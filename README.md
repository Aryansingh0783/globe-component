# Globe

A dotted Earth with animated flight arcs, built with React and three.js.

This is an original recreation of the **Globe** component from
[React Bits Pro](https://pro.reactbits.dev/docs/components/globe), written to
match its documented 22-prop API and visual character: a near-black ocean
sphere, a latitude/longitude grid of land dots, a soft atmosphere halo and
pink arcs that draw themselves across the view.

The demo in `src/App.tsx` uses the reference palette and timing (`#FF9FFC`
arcs, 10 arcs, 6 s interval, 2 s draw time, 0.15 atmosphere). Its camera
altitude is 2.35 rather than the reference's 3.0, so the globe fills the page
instead of sitting in a small preview canvas; the component default remains
2.

```bash
cd globe-clone
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
npm run preview  # serve the production build
```

Requires Node 20+.

---

## Using the component

The component needs `react` and `three` (plus `@types/three` in TypeScript
projects).

```bash
npm i three
npm i -D @types/three
```

1. Copy `src/components/Globe.tsx` into your project.
2. Copy `public/earth-land-mask.png` somewhere your app can serve it. If you
   keep the default `landMapUrl`, you can skip this step — the component falls
   back to a CORS-enabled topology image on unpkg.
3. Render it inside a sized container:

```tsx
import Globe from './components/Globe';

export function Hero() {
  return (
    <div style={{ width: 'min(720px, 88vw)' }}>
      <Globe
        primaryColor="#FF9FFC"
        neutralColor="#9ca3af"
        atmosphereColor="#9ca3af"
        autoRotateSpeed={0.85}
        enableZoom
        arcCount={10}
        arcInterval={6000}
        arcAnimationDuration={2000}
        cameraAltitude={3}
        atmosphereAltitude={0.15}
        landMapUrl="/earth-land-mask.png"
        onGlobeClick={({ lat, lng }) => console.log(lat, lng)}
      />
    </div>
  );
}
```

`width` / `height` default to `"auto"`; with both on auto the component takes
the full width of its parent and stays square. The canvas itself is
transparent, so the page background shows through around the globe.

Colour, opacity, arc timing and grid props can all be changed live without
remounting. Changing `landMapUrl`, `landDotRows` or `pointResolution` rebuilds
the dot grid.

---

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `width` | `number \| "auto"` | `"auto"` | Container width in pixels, or full parent width. |
| `height` | `number \| "auto"` | `"auto"` | Container height in pixels, or square when `width` is also auto. |
| `primaryColor` | `string` | `"rgb(59, 130, 246)"` | Arc colour. Any CSS colour. |
| `neutralColor` | `string` | `"rgb(156, 163, 175)"` | Land dot colour. |
| `atmosphereColor` | `string` | `undefined` | Halo colour. Defaults to `neutralColor`. |
| `showAtmosphere` | `boolean` | `true` | Show the atmosphere glow. |
| `autoRotateSpeed` | `number` | `0.85` | Auto-rotation speed. `0` disables it. |
| `enableZoom` | `boolean` | `false` | Wheel and pinch zoom. |
| `interactive` | `boolean` | `true` | Pointer drag and click reporting. |
| `arcCount` | `number` | `10` | Size of the arc pool. |
| `arcInterval` | `number` | `6000` | Base duration of one arc lifecycle, in ms. |
| `arcAnimationDuration` | `number` | `2000` | Time an arc takes to draw itself, in ms. |
| `cameraAltitude` | `number` | `2` | Camera distance. Higher pulls the globe away. |
| `pointSize` | `number` | `0.25` | Land dot size. |
| `pointResolution` | `number` | `5` | Pixel stride used when sampling the land map. |
| `atmosphereAltitude` | `number` | `0.3` | Halo thickness, as a fraction of the globe radius. |
| `globeOpacity` | `number` | `1` | Opacity of the dark globe body. |
| `landDotRows` | `number` | `200` | Latitude rows in the land dot grid. |
| `landMapUrl` | `string` | three-globe topology PNG | Equirectangular land mask. |
| `className` | `string` | `undefined` | Extra class on the container. |
| `onReady` | `() => void` | `undefined` | Fires once the globe is initialised. |
| `onGlobeClick` | `(coords, event) => void` | `undefined` | Fires on a globe click/tap with `{ lat, lng }` in degrees. |

### Interaction details

- Drag (mouse or one finger) rotates the globe; vertical drag also tilts it.
- Wheel zooms when `enableZoom` is set; two-finger pinch does the same on touch.
- A click or tap that does not travel more than 6 px reports coordinates to
  `onGlobeClick`. Coordinates are relative to the globe's own texture, not the
  screen.
- Auto-rotation stops while dragging and resumes afterwards.
- Zoom is clamped to a 0.85×–2.4× camera-distance multiplier so the globe
  cannot clip through the camera.

The component does not use `OrbitControls`; controls are implemented directly
on the canvas. There is no inertia/damping pass.

---

## Land map notes

The dot layer is made by reading a 2:1 equirectangular land mask with a 2D
canvas:

- **White or bright pixels = land**, black or transparent = ocean. The bundled
  `earth-land-mask.png` is a clean 2048 × 1024 binary mask generated from the
  topology image used by `three-globe` (MIT).
- The mask must be reachable by the browser and, for cross-origin URLs, served
  with `Access-Control-Allow-Origin`. The component wants to read pixels, so a
  missing CORS header results in the "unable to read the land map" warning and
  an empty dot layer. Host it locally when possible.
- `pointResolution` downsamples the mask before it is read (`5` means one sample
  per 5 × 5 px block). It is a speed/quality trade-off, not a dot-size control.
- `landDotRows` controls the actual latitude grid. A higher value gives finer
  dots; 200 is a good desktop default, 110–140 is a sensible mobile default.
- The default URL points at
  `https://unpkg.com/three-globe@2.31.1/example/img/earth-topology.png`. It is
  convenient for a quick start but adds a network dependency, so production
  sites should ship their own mask.

Arc endpoints are sampled from the hemisphere currently facing the camera
(with a small chance of a far-side point) so the network stays visible as the
globe rotates. Arcs follow a lifted great-circle path with a little random
altitude; endpoint caps appear when an arc finishes drawing.

---

## SSR, accessibility and performance

- The component is safe to render during SSR: all browser/WebGL work is inside
  `useEffect`. The canvas mounts after hydration.
- `onReady` fires once per mount, after the first dot grid exists. If the map
  never resolves it fires after a 15 s safety timeout and leaves the globe
  empty rather than hanging the page.
- The renderer caps device pixel ratio at 2 and pauses its animation loop while
  the container is off-screen (via `IntersectionObserver`).
- At the defaults the dot layer is roughly 20–25k points, plus 10 arcs with 140
  segments each. For low-end phones, lower `landDotRows` to ~120 and set
  `enableZoom={false}` if you do not need it.
- The globe is a visual element. If clicks are used as a primary interaction,
  put equivalent controls elsewhere in the UI; the canvas has no keyboard
  target. The demo's colour swatches are real buttons with labels and focus
  styles.

---

## Project layout

```
globe-clone/
├─ public/
│  └─ earth-land-mask.png      binary land mask used by the demo
├─ src/
│  ├─ components/Globe.tsx     the component
│  ├─ App.tsx                  demo page
│  ├─ App.css                  demo styling
│  ├─ index.css                global reset
│  └─ main.tsx                 React entry
├─ docs/
│  └─ preview.png              final desktop capture
├─ index.html
└─ package.json
```

The demo adds a small "ORBITAL / 01" frame around the component: a live status
pill, a click-coordinate readout and four arc-colour swatches. The globe itself
is entirely self-contained in `Globe.tsx`.

---

## Notes on this recreation

This is not the React Bits Pro source and is not affiliated with React Bits.
It is an independent implementation of the documented interface and visual
language: the halo is a custom screen-space shader, the land dots come from a
canvas-sampled mask, and the arcs are interpolated great-circle hops with a
per-arc draw/hold/fade schedule. The screenshot comparison used for tuning is
in `docs/preview.png`.

Built with React 19, three.js 0.182 and Vite 7.
