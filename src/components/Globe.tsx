import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export type GlobeCoords = {
  lat: number;
  lng: number;
};

export interface GlobeProps {
  /** Width of the globe container in pixels, or "auto" to match the parent width. */
  width?: number | 'auto';
  /** Height of the globe container in pixels, or "auto" to match its width. */
  height?: number | 'auto';
  /** Color for animated arcs and labels. */
  primaryColor?: string;
  /** Color for land dots and (by default) the atmosphere. */
  neutralColor?: string;
  /** Color for the atmosphere glow. Defaults to neutralColor. */
  atmosphereColor?: string;
  /** Show the soft glow around the globe. */
  showAtmosphere?: boolean;
  /** Auto-rotation speed. 0 disables rotation. */
  autoRotateSpeed?: number;
  /** Enable zooming with the mouse wheel. */
  enableZoom?: boolean;
  /** Enable dragging and click reporting. */
  interactive?: boolean;
  /** Number of arcs in the animation pool. */
  arcCount?: number;
  /** Base duration of one arc lifecycle, in milliseconds. */
  arcInterval?: number;
  /** Time it takes an arc to draw itself, in milliseconds. */
  arcAnimationDuration?: number;
  /** Camera distance from the globe. Higher = further away. */
  cameraAltitude?: number;
  /** Size of the land dots. */
  pointSize?: number;
  /** Pixel stride used when reading the land map. Higher = lighter. */
  pointResolution?: number;
  /** Thickness of the atmosphere, relative to the globe radius. */
  atmosphereAltitude?: number;
  /** Opacity of the dark globe body. */
  globeOpacity?: number;
  /** Number of latitude rows used for the land dot grid. */
  landDotRows?: number;
  /** URL of a land mask / topology image (equirectangular). */
  landMapUrl?: string;
  className?: string;
  /** Fired once the globe has initialized. */
  onReady?: () => void;
  /** Fired when a click lands on the globe. */
  onGlobeClick?: (coords: GlobeCoords, event: MouseEvent) => void;
}

type ResolvedOptions = {
  width: number | 'auto';
  height: number | 'auto';
  primaryColor: string;
  neutralColor: string;
  atmosphereColor: string;
  showAtmosphere: boolean;
  autoRotateSpeed: number;
  enableZoom: boolean;
  interactive: boolean;
  arcCount: number;
  arcInterval: number;
  arcAnimationDuration: number;
  cameraAltitude: number;
  pointSize: number;
  pointResolution: number;
  atmosphereAltitude: number;
  globeOpacity: number;
  landDotRows: number;
  landMapUrl: string;
};

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TAU = Math.PI * 2;

const DEFAULT_LAND_MAP =
  'https://unpkg.com/three-globe@2.31.1/example/img/earth-topology.png';

const SEGMENTS = 140;

const POINT_VERTEX = /* glsl */ `
  uniform float uSize;
  uniform float uPixelRatio;

  void main() {
    gl_PointSize = max(1.0, uSize * uPixelRatio);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const POINT_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    gl_FragColor = vec4(uColor, uOpacity);
    #include <colorspace_fragment>
  }
`;

const ATMOSPHERE_VERTEX = /* glsl */ `
  varying vec3 vViewPosition;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = viewPosition.xyz;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uGlobeTan;
  uniform float uHaloTan;
  varying vec3 vViewPosition;

  void main() {
    // Screen-space radius (the tangent of the viewing angle) for this halo
    // fragment. Comparing it with the projected globe and halo silhouettes
    // gives a glow band of even thickness around the globe at any zoom.
    float screenRadius =
      length(vViewPosition.xy) / max(0.0001, -vViewPosition.z);
    float t = clamp(
      (screenRadius - uGlobeTan) / max(0.0001, uHaloTan - uGlobeTan),
      0.0,
      1.0
    );

    // Soft haze that holds near the limb and rolls off at the outer edge,
    // like a thin scattering shell.
    float glow = 1.0 - smoothstep(0.0, 1.0, t);

    gl_FragColor = vec4(uColor * glow * uOpacity, clamp(glow * uOpacity, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resolveOptions(props: GlobeProps): ResolvedOptions {
  const neutral = props.neutralColor ?? 'rgb(156, 163, 175)';

  return {
    width: props.width ?? 'auto',
    height: props.height ?? 'auto',
    primaryColor: props.primaryColor ?? 'rgb(59, 130, 246)',
    neutralColor: neutral,
    atmosphereColor: props.atmosphereColor ?? neutral,
    showAtmosphere: props.showAtmosphere ?? true,
    autoRotateSpeed: finite(props.autoRotateSpeed, 0.85),
    enableZoom: props.enableZoom ?? false,
    interactive: props.interactive ?? true,
    arcCount: clamp(Math.round(finite(props.arcCount, 10)), 0, 40),
    arcInterval: Math.max(600, finite(props.arcInterval, 6000)),
    arcAnimationDuration: Math.max(150, finite(props.arcAnimationDuration, 2000)),
    cameraAltitude: clamp(finite(props.cameraAltitude, 2), 1.05, 40),
    pointSize: Math.max(0.05, finite(props.pointSize, 0.25)),
    pointResolution: clamp(Math.round(finite(props.pointResolution, 5)), 1, 32),
    atmosphereAltitude: clamp(finite(props.atmosphereAltitude, 0.3), 0.01, 2),
    globeOpacity: clamp(finite(props.globeOpacity, 1), 0, 1),
    landDotRows: clamp(Math.round(finite(props.landDotRows, 200)), 24, 600),
    landMapUrl:
      props.landMapUrl && props.landMapUrl.trim()
        ? props.landMapUrl
        : DEFAULT_LAND_MAP,
  };
}

function parseColor(value: string | undefined, fallback: string): THREE.Color {
  const color = new THREE.Color();
  try {
    color.setStyle(value && value.trim() ? value : fallback);
  } catch {
    color.setStyle(fallback);
  }
  return color;
}

function latLngToVector3(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi = lat * DEG2RAD;
  const theta = lng * DEG2RAD;
  const cosPhi = Math.cos(phi);

  return new THREE.Vector3(
    radius * cosPhi * Math.sin(theta),
    radius * Math.sin(phi),
    radius * cosPhi * Math.cos(theta),
  );
}

type LandMask = {
  width: number;
  height: number;
  data: Uint8Array;
};

function loadLandMask(url: string, stride: number): Promise<LandMask> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';

    image.onload = () => {
      try {
        const width = Math.max(1, Math.ceil(image.naturalWidth / stride));
        const height = Math.max(1, Math.ceil(image.naturalHeight / stride));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          reject(new Error('Canvas 2D context unavailable'));
          return;
        }

        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0, width, height);

        const pixels = context.getImageData(0, 0, width, height).data;
        const data = new Uint8Array(width * height);

        for (let i = 0; i < data.length; i += 1) {
          const offset = i * 4;
          const luma = Math.max(
            pixels[offset],
            pixels[offset + 1],
            pixels[offset + 2],
          );
          const alpha = pixels[offset + 3] / 255;
          data[i] = luma * alpha > 3 ? 1 : 0;
        }

        resolve({ width, height, data });
      } catch (error) {
        reject(error);
      }
    };

    image.onerror = () => reject(new Error(`Could not load land map: ${url}`));
    image.src = url;
  });
}

type Arc = {
  group: THREE.Group;
  line: Line2;
  lineGeometry: LineGeometry;
  lineMaterial: LineMaterial;
  points: THREE.Vector3[];
  endpoints: THREE.Points;
  endpointGeometry: THREE.BufferGeometry;
  endpointMaterial: THREE.ShaderMaterial;
  head: THREE.Points;
  headGeometry: THREE.BufferGeometry;
  headMaterial: THREE.ShaderMaterial;
  phase: number;
  cycle: number;
  draw: number;
  hold: number;
  fade: number;
  lastCycle: number;
};

export default function Globe({
  width,
  height,
  primaryColor,
  neutralColor,
  atmosphereColor,
  showAtmosphere,
  autoRotateSpeed,
  enableZoom,
  interactive,
  arcCount,
  arcInterval,
  arcAnimationDuration,
  cameraAltitude,
  pointSize,
  pointResolution,
  atmosphereAltitude,
  globeOpacity,
  landDotRows,
  landMapUrl,
  className,
  onReady,
  onGlobeClick,
}: GlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{ apply: (options: ResolvedOptions) => void } | null>(null);

  const options = useMemo(
    () =>
      resolveOptions({
        width,
        height,
        primaryColor,
        neutralColor,
        atmosphereColor,
        showAtmosphere,
        autoRotateSpeed,
        enableZoom,
        interactive,
        arcCount,
        arcInterval,
        arcAnimationDuration,
        cameraAltitude,
        pointSize,
        pointResolution,
        atmosphereAltitude,
        globeOpacity,
        landDotRows,
        landMapUrl,
      }),
    [
      width,
      height,
      primaryColor,
      neutralColor,
      atmosphereColor,
      showAtmosphere,
      autoRotateSpeed,
      enableZoom,
      interactive,
      arcCount,
      arcInterval,
      arcAnimationDuration,
      cameraAltitude,
      pointSize,
      pointResolution,
      atmosphereAltitude,
      globeOpacity,
      landDotRows,
      landMapUrl,
    ],
  );

  const optionsRef = useRef(options);
  const callbacksRef = useRef({ onReady, onGlobeClick });
  optionsRef.current = options;
  callbacksRef.current = { onReady, onGlobeClick };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const hostNode: HTMLDivElement = container;

    let disposed = false;
    let opts = optionsRef.current;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 100);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const canvas = renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);

    const startTime = performance.now() / 1000;

    // A very slight axial lean keeps the dot grid from reading as a flat
    // bullseye. The outer group holds the lean, the inner group spins.
    const tiltGroup = new THREE.Group();
    tiltGroup.rotation.set(0.16, 0, -0.13);
    scene.add(tiltGroup);

    const spinGroup = new THREE.Group();
    tiltGroup.add(spinGroup);

    const globeGeometry = new THREE.SphereGeometry(1, 96, 64);
    const globeMaterial = new THREE.MeshBasicMaterial({
      color: 0x060607,
      transparent: false,
      opacity: 1,
      depthWrite: true,
    });
    const globe = new THREE.Mesh(globeGeometry, globeMaterial);
    spinGroup.add(globe);

    const pixelRatioUniform = { value: 1 };

    let dotGeometry = new THREE.BufferGeometry();
    const dotMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('rgb(156, 163, 175)') },
        uOpacity: { value: 0.8 },
        uSize: { value: 1.5 },
        uPixelRatio: pixelRatioUniform,
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    const dots = new THREE.Points(dotGeometry, dotMaterial);
    dots.frustumCulled = false;
    dots.renderOrder = 1;
    spinGroup.add(dots);

    const atmosphereGeometry = new THREE.SphereGeometry(1, 64, 48);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('rgb(156, 163, 175)') },
        uOpacity: { value: 0.5 },
        uGlobeTan: { value: 0.3536 },
        uHaloTan: { value: 0.4149 },
      },
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The fragment shader outputs premultiplied color, so add it straight
      // into the frame instead of letting additive blending multiply by alpha
      // a second time. This keeps the halo at the strength it is authored at.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      premultipliedAlpha: true,
    });

    const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    atmosphere.scale.setScalar(1.15);
    atmosphere.renderOrder = 2;
    scene.add(atmosphere);

    const arcRoot = new THREE.Group();
    spinGroup.add(arcRoot);

    const arcColor = new THREE.Color('rgb(59, 130, 246)');
    let arcs: Arc[] = [];
    let lastArcKey = '';

    let mask: LandMask | null = null;
    let landSignature = '';
    let landToken = 0;

    let readyFired = false;
    const readyTimer = window.setTimeout(() => notifyReady(), 15000);

    function notifyReady() {
      if (readyFired || disposed) return;
      readyFired = true;
      window.clearTimeout(readyTimer);
      window.setTimeout(() => {
        if (!disposed) callbacksRef.current.onReady?.();
      }, 0);
    }

    function isLand(lat: number, lng: number): boolean {
      if (!mask) return false;

      const x = clamp(
        Math.floor(((lng + 180) / 360) * mask.width),
        0,
        mask.width - 1,
      );
      const y = clamp(
        Math.floor(((90 - lat) / 180) * mask.height),
        0,
        mask.height - 1,
      );

      return mask.data[y * mask.width + x] === 1;
    }

    function buildDots() {
      const rows = clamp(Math.round(opts.landDotRows), 24, 600);
      const cols = rows * 2;
      const radius = 1.003;
      const positions = new Float32Array(rows * cols * 3);
      let cursor = 0;

      for (let row = 0; row < rows; row += 1) {
        const lat = 90 - ((row + 0.5) * 180) / rows;
        const phi = lat * DEG2RAD;
        const y = Math.sin(phi) * radius;
        const cosPhi = Math.cos(phi);

        for (let col = 0; col < cols; col += 1) {
          const lng = -180 + ((col + 0.5) * 360) / cols;

          if (!isLand(lat, lng)) continue;

          const theta = lng * DEG2RAD;
          positions[cursor] = cosPhi * Math.sin(theta) * radius;
          positions[cursor + 1] = y;
          positions[cursor + 2] = cosPhi * Math.cos(theta) * radius;
          cursor += 3;
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(positions.subarray(0, cursor), 3),
      );
      geometry.computeBoundingSphere();

      const previous = dots.geometry;
      dots.geometry = geometry;
      previous.dispose();
      dots.visible = cursor > 0;
    }

    function requestLand() {
      const token = (landToken += 1);
      const stride = clamp(Math.round(opts.pointResolution), 1, 32);

      loadLandMask(opts.landMapUrl, stride)
        .then((loaded) => {
          if (disposed || token !== landToken) return;
          mask = loaded;
          buildDots();
          notifyReady();
        })
        .catch((error: unknown) => {
          if (disposed || token !== landToken) return;
          mask = null;
          buildDots();
          notifyReady();
          console.warn('[Globe] Unable to read the land map.', error);
        });
    }

    function randomLatLng(): { lat: number; lng: number } {
      return {
        lat: Math.asin(Math.random() * 2 - 1) * RAD2DEG,
        lng: Math.random() * 360 - 180,
      };
    }

    const arcViewDirection = new THREE.Vector3(0, 0, 1);

    function pickArcPoint(): THREE.Vector3 {
      // Sample the hemisphere that is currently facing the camera so the
      // visible routes feel continuous instead of only surfacing at the limb.
      if (Math.random() < 0.9) {
        for (let attempt = 0; attempt < 24; attempt += 1) {
          const { lat, lng } = randomLatLng();
          const point = latLngToVector3(lat, lng, 1.004);
          if (point.dot(arcViewDirection) > 0.08) return point;
        }
      }

      const { lat, lng } = randomLatLng();
      return latLngToVector3(lat, lng, 1.004);
    }

    function buildArcPath(): THREE.Vector3[] {
      spinGroup.updateWorldMatrix(true, false);
      arcViewDirection
        .copy(spinGroup.worldToLocal(camera.position.clone()))
        .normalize();

      let start = pickArcPoint();
      let end = pickArcPoint();

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const angle = start.angleTo(end);
        if (angle > 0.8 && angle < 2.8) break;
        start = pickArcPoint();
        end = pickArcPoint();
      }

      // Interpolate along the great circle between the two surface points,
      // then lift the midpoint radially. The result is the clean, symmetric
      // "hop" that real flight-path arcs use, with no lateral wobble.
      const angle = Math.max(0.001, start.angleTo(end));
      const sinAngle = Math.sin(angle);
      const from = start.clone().normalize();
      const to = end.clone().normalize();
      const hop =
        0.04 +
        Math.pow(Math.random(), 1.5) * 0.28 +
        (angle / Math.PI) * (0.05 + Math.random() * 0.1);

      const points: THREE.Vector3[] = [];
      for (let index = 0; index <= SEGMENTS; index += 1) {
        const t = index / SEGMENTS;
        const a = Math.sin((1 - t) * angle) / sinAngle;
        const b = Math.sin(t * angle) / sinAngle;
        const direction = from.clone().multiplyScalar(a).addScaledVector(to, b);
        const altitude = 1.004 + hop * Math.pow(Math.sin(Math.PI * t), 0.85);
        points.push(direction.multiplyScalar(altitude));
      }

      return points;
    }

    function makePointMaterial(size: number): THREE.ShaderMaterial {
      return new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: arcColor.clone() },
          uOpacity: { value: 1 },
          uSize: { value: size },
          uPixelRatio: pixelRatioUniform,
        },
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
      });
    }

    function disposeArc(arc: Arc) {
      arcRoot.remove(arc.group);
      arc.lineGeometry.dispose();
      arc.lineMaterial.dispose();
      arc.endpointGeometry.dispose();
      arc.endpointMaterial.dispose();
      arc.headGeometry.dispose();
      arc.headMaterial.dispose();
    }

    function retargetArc(arc: Arc) {
      const points = buildArcPath();
      arc.points = points;

      const lineArray = new Float32Array((SEGMENTS + 1) * 3);
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        lineArray[index * 3] = point.x;
        lineArray[index * 3 + 1] = point.y;
        lineArray[index * 3 + 2] = point.z;
      }
      arc.lineGeometry.setPositions(lineArray);
      arc.lineGeometry.instanceCount = 0;

      const last = points[points.length - 1];
      const endpoints = arc.endpointGeometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute;
      endpoints.setXYZ(0, points[0].x, points[0].y, points[0].z);
      endpoints.setXYZ(1, last.x, last.y, last.z);
      endpoints.needsUpdate = true;

      const head = arc.headGeometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute;
      head.setXYZ(0, points[0].x, points[0].y, points[0].z);
      head.needsUpdate = true;
    }

    function createArc(index: number, count: number): Arc {
      const group = new THREE.Group();

      const lineGeometry = new LineGeometry();
      lineGeometry.setPositions(new Float32Array((SEGMENTS + 1) * 3));
      lineGeometry.instanceCount = 0;

      const lineMaterial = new LineMaterial({
        color: arcColor.clone(),
        linewidth: 0.85,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: true,
      });
      lineMaterial.resolution.set(viewportWidth, viewportHeight);

      const line = new Line2(lineGeometry, lineMaterial);
      line.frustumCulled = false;
      line.renderOrder = 1;

      const endpointGeometry = new THREE.BufferGeometry();
      endpointGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(2 * 3), 3),
      );
      const endpointMaterial = makePointMaterial(2.0);
      const endpoints = new THREE.Points(endpointGeometry, endpointMaterial);
      endpoints.frustumCulled = false;
      endpoints.renderOrder = 3;

      const headGeometry = new THREE.BufferGeometry();
      headGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(3), 3),
      );
      const headMaterial = makePointMaterial(2.4);
      const head = new THREE.Points(headGeometry, headMaterial);
      head.frustumCulled = false;
      head.visible = false;
      head.renderOrder = 4;

      group.add(line, endpoints, head);

      const draw = clamp(opts.arcAnimationDuration / 1000, 0.25, 20);
      const interval = clamp(opts.arcInterval / 1000, 0.6, 60);
      const cycle = Math.max(draw + 1.6, interval * (0.85 + Math.random() * 0.3));
      // Draw, hold, fade, then rest off-screen. The rest window keeps roughly
      // six of the ten routes alive at any moment.
      const hold = Math.max(0.35, (cycle - draw) * 0.3);
      const fade = Math.max(0.4, (cycle - draw - hold) * 0.26);
      const phase =
        (index / Math.max(1, count)) * cycle + Math.random() * cycle * 0.2;

      const arc: Arc = {
        group,
        line,
        lineGeometry,
        lineMaterial,
        points: [],
        endpoints,
        endpointGeometry,
        endpointMaterial,
        head,
        headGeometry,
        headMaterial,
        phase,
        cycle,
        draw,
        hold,
        fade,
        lastCycle: Math.floor(
          (performance.now() / 1000 - startTime + phase) / cycle,
        ),
      };

      retargetArc(arc);
      arcRoot.add(group);
      return arc;
    }

    function syncArcs() {
      const key = `${opts.arcCount}|${opts.arcInterval}|${opts.arcAnimationDuration}`;
      if (key === lastArcKey) return;
      lastArcKey = key;

      for (const arc of arcs) disposeArc(arc);
      arcs = [];

      for (let index = 0; index < opts.arcCount; index += 1) {
        arcs.push(createArc(index, opts.arcCount));
      }
    }

    function updateArcs(now: number) {
      for (const arc of arcs) {
        const raw = now - startTime + arc.phase;
        const cycleIndex = Math.floor(raw / arc.cycle);
        const t = raw - cycleIndex * arc.cycle;

        if (cycleIndex !== arc.lastCycle) {
          retargetArc(arc);
          arc.lastCycle = cycleIndex;
        }

        let progress = 1;
        let opacity = 1;

        if (t < arc.draw) {
          const x = clamp(t / arc.draw, 0, 1);
          progress = x * x * (3 - 2 * x);
        } else if (t >= arc.draw + arc.hold) {
          opacity = clamp(
            1 - (t - arc.draw - arc.hold) / arc.fade,
            0,
            1,
          );
        }

        const visiblePoints = Math.floor(progress * (SEGMENTS + 1));
        arc.lineGeometry.instanceCount = Math.max(0, visiblePoints - 1);
        arc.lineMaterial.opacity = opacity;
        arc.group.visible = opacity > 0.001 && visiblePoints > 0;

        // Both end caps surface together once the head has reached the end.
        const capsVisible = clamp((progress - 0.94) / 0.06, 0, 1);
        arc.endpointMaterial.uniforms.uOpacity.value = opacity * capsVisible;

        const drawing = t < arc.draw;
        arc.head.visible = drawing && visiblePoints > 0;

        if (drawing) {
          const index = Math.max(0, Math.min(SEGMENTS, visiblePoints - 1));
          const point = arc.points[index];
          const headAttribute = arc.headGeometry.getAttribute(
            'position',
          ) as THREE.BufferAttribute;
          headAttribute.setXYZ(0, point.x, point.y, point.z);
          headAttribute.needsUpdate = true;
          arc.headMaterial.uniforms.uOpacity.value = opacity;
        }
      }
    }

    let viewportWidth = 1;
    let viewportHeight = 1;
    let spin = 46 * DEG2RAD;
    const baseTiltX = 0.16;
    let userTiltX = 0;
    let zoom = 1;
    let dragging = false;
    let dragPointer = -1;
    let dragX = 0;
    let dragY = 0;
    let dragTravel = 0;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    let multiTouch = false;

    function updateCamera() {
      const distance = Math.max(1.05, opts.cameraAltitude * zoom);
      camera.position.set(0, 0, distance);
      camera.lookAt(0, 0, 0);

      // Exact projected tangents of the globe silhouette and the atmosphere
      // shell. Used by the halo shader so its width is measured in screen
      // space rather than in object space.
      const globeTan = 1 / Math.sqrt(Math.max(0.0001, distance * distance - 1));
      const haloTan = globeTan * (1 + opts.atmosphereAltitude);
      atmosphereMaterial.uniforms.uGlobeTan.value = globeTan;
      atmosphereMaterial.uniforms.uHaloTan.value = haloTan;
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function reportClick(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const hits = raycaster.intersectObject(globe, false);
      if (hits.length === 0) return;

      globe.updateWorldMatrix(true, false);
      const local = globe.worldToLocal(hits[0].point.clone());
      const radius = local.length() || 1;
      const lat = Math.asin(clamp(local.y / radius, -1, 1)) * RAD2DEG;
      const lng = Math.atan2(local.x, local.z) * RAD2DEG;

      callbacksRef.current.onGlobeClick?.({ lat, lng }, event);
    }

    function onPointerDown(event: PointerEvent) {
      if (!opts.interactive) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      canvas.setPointerCapture?.(event.pointerId);
      canvas.style.cursor = 'grabbing';

      if (pointers.size >= 2) {
        const [first, second] = Array.from(pointers.values());
        pinchStartDistance =
          Math.hypot(first.x - second.x, first.y - second.y) || 1;
        pinchStartZoom = zoom;
        dragging = false;
        multiTouch = true;
        dragTravel = 100;
        return;
      }

      dragging = true;
      dragPointer = event.pointerId;
      dragX = event.clientX;
      dragY = event.clientY;
      dragTravel = 0;
    }

    function onPointerMove(event: PointerEvent) {
      if (!pointers.has(event.pointerId)) return;

      pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      if (pointers.size >= 2) {
        if (!opts.enableZoom) return;
        const [first, second] = Array.from(pointers.values());
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        // `zoom` is a distance multiplier: spreading the fingers should move
        // the camera closer, tightening them should pull it away.
        zoom = clamp(
          pinchStartZoom * (pinchStartDistance / Math.max(1, distance)),
          0.85,
          2.4,
        );
        updateCamera();
        return;
      }

      if (!dragging || event.pointerId !== dragPointer) return;

      const dx = event.clientX - dragX;
      const dy = event.clientY - dragY;
      dragX = event.clientX;
      dragY = event.clientY;
      dragTravel += Math.abs(dx) + Math.abs(dy);

      spin += dx * 0.006;
      userTiltX = clamp(userTiltX + dy * 0.0045, -0.9, 0.9);
    }

    function finishGesture(event: PointerEvent, allowClick: boolean) {
      const pointerId = event.pointerId;
      if (!pointers.delete(pointerId)) return;

      if (canvas.hasPointerCapture?.(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }

      if (pointers.size === 1) {
        // One finger remains after a pinch: keep panning, never treat the
        // tail of the gesture as a click.
        const [nextId, position] = Array.from(pointers.entries())[0];
        dragging = true;
        dragPointer = nextId;
        dragX = position.x;
        dragY = position.y;
        dragTravel = 100;
        return;
      }

      if (pointers.size > 1) return;

      const wasClick = !multiTouch && dragTravel < 6;
      dragging = false;
      dragPointer = -1;
      pinchStartDistance = 0;
      multiTouch = false;
      dragTravel = 0;
      canvas.style.cursor = opts.interactive ? 'grab' : 'default';

      if (allowClick && wasClick) reportClick(event);
    }

    function onPointerUp(event: PointerEvent) {
      finishGesture(event, true);
    }

    function onPointerCancel(event: PointerEvent) {
      finishGesture(event, false);
    }

    function onWheel(event: WheelEvent) {
      if (!opts.enableZoom) return;
      event.preventDefault();
      zoom = clamp(zoom * Math.exp(event.deltaY * 0.0012), 0.85, 2.4);
      updateCamera();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    function apply(next: ResolvedOptions) {
      opts = next;

      const primary = parseColor(next.primaryColor, 'rgb(59, 130, 246)');
      const neutral = parseColor(next.neutralColor, 'rgb(156, 163, 175)');
      const atmosphereTint = parseColor(
        next.atmosphereColor,
        next.neutralColor,
      );

      arcColor.copy(primary);
      dotMaterial.uniforms.uColor.value.copy(neutral);
      dotMaterial.uniforms.uSize.value = Math.max(0.05, next.pointSize * 5.0);

      for (const arc of arcs) {
        arc.lineMaterial.color.copy(primary);
        (arc.endpointMaterial.uniforms.uColor.value as THREE.Color).copy(
          primary,
        );
        (arc.headMaterial.uniforms.uColor.value as THREE.Color).copy(primary);
      }

      const opacity = clamp(next.globeOpacity, 0, 1);
      globeMaterial.opacity = opacity;
      const transparent = opacity < 0.999;
      if (globeMaterial.transparent !== transparent) {
        globeMaterial.transparent = transparent;
        globeMaterial.depthWrite = !transparent;
        globeMaterial.needsUpdate = true;
      }
      globe.visible = opacity > 0.001;

      const scale = 1 + next.atmosphereAltitude;
      atmosphere.scale.setScalar(scale);
      atmosphereMaterial.uniforms.uColor.value.copy(atmosphereTint);
      atmosphereMaterial.uniforms.uOpacity.value = 0.012;
      atmosphere.visible = next.showAtmosphere;

      updateCamera();

      hostNode.style.touchAction = next.interactive ? 'none' : 'auto';
      canvas.style.cursor = next.interactive
        ? dragging
          ? 'grabbing'
          : 'grab'
        : 'default';

      syncArcs();

      const signature = `${next.landMapUrl}|${next.landDotRows}|${next.pointResolution}`;
      if (signature !== landSignature) {
        landSignature = signature;
        requestLand();
      }
    }

    function resize() {
      const rect = hostNode.getBoundingClientRect();
      const widthNow = Math.max(1, rect.width);
      const heightNow = Math.max(1, rect.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(widthNow, heightNow, false);
      pixelRatioUniform.value = pixelRatio;

      viewportWidth = widthNow;
      viewportHeight = heightNow;
      for (const arc of arcs) {
        arc.lineMaterial.resolution.set(widthNow, heightNow);
      }

      camera.aspect = widthNow / heightNow;
      camera.updateProjectionMatrix();
    }

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let onScreen = true;
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(container);

    let raf = 0;
    let last = performance.now();

    function animate() {
      raf = requestAnimationFrame(animate);

      const nowMs = performance.now();
      const delta = Math.min(0.05, (nowMs - last) / 1000);
      last = nowMs;

      if (!onScreen) return;

      if (!dragging && opts.autoRotateSpeed !== 0) {
        spin = (spin + opts.autoRotateSpeed * 0.09 * delta) % TAU;
      }

      spinGroup.rotation.y = spin;
      tiltGroup.rotation.x = baseTiltX + userTiltX;

      updateArcs(nowMs / 1000);
      renderer.render(scene, camera);
    }

    apply(optionsRef.current);
    updateArcs(performance.now() / 1000);
    animate();

    const api = { apply };
    apiRef.current = api;

    return () => {
      disposed = true;
      landToken += 1;
      window.clearTimeout(readyTimer);
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();

      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('wheel', onWheel);

      for (const arc of arcs) disposeArc(arc);
      arcs = [];

      dots.geometry.dispose();
      dotMaterial.dispose();
      globeGeometry.dispose();
      globeMaterial.dispose();
      atmosphereGeometry.dispose();
      atmosphereMaterial.dispose();

      renderer.dispose();
      canvas.remove();
      if (apiRef.current === api) apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    apiRef.current?.apply(options);
  }, [options]);

  const style: CSSProperties = {
    position: 'relative',
    width: width === 'auto' || width === undefined ? '100%' : `${width}px`,
    maxWidth: '100%',
    ...(height === 'auto' || height === undefined
      ? { aspectRatio: '1 / 1' }
      : { height: `${height}px` }),
    overflow: 'hidden',
    userSelect: 'none',
  };

  return (
    <div
      ref={containerRef}
      className={className ? `rb-globe ${className}` : 'rb-globe'}
      style={style}
    />
  );
}
