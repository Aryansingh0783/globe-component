import { useEffect, useState, type CSSProperties } from 'react';
import Globe, { type GlobeCoords } from './components/Globe';
import './App.css';

const PRESETS = [
  { name: 'Ultraviolet', color: '#FF9FFC' },
  { name: 'Glacier', color: '#7DD3FC' },
  { name: 'Signal', color: '#5EEAD4' },
  { name: 'Ember', color: '#FDBA74' },
];

function formatLat(lat: number) {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
}

function formatLng(lng: number) {
  return `${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? 'E' : 'W'}`;
}

function useCompactLayout() {
  const [compact, setCompact] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 700px)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)');
    const onChange = () => setCompact(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return compact;
}

export default function App() {
  const [activePreset, setActivePreset] = useState(0);
  const [coords, setCoords] = useState<GlobeCoords | null>(null);
  const [ready, setReady] = useState(false);
  const compact = useCompactLayout();

  const primary = PRESETS[activePreset].color;

  return (
    <main className="page" style={{ '--accent': primary } as CSSProperties}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span>Orbital</span>
          <span className="brand-sub">/ 01</span>
        </div>

        <div className={`status${ready ? ' is-ready' : ''}`}>
          <span className="status-dot" />
          {ready ? 'render live' : 'booting'}
        </div>
      </header>

      <section className="stage">
        <div className="globe-wrap">
          <Globe
            width="auto"
            height="auto"
            primaryColor={primary}
            neutralColor="#9ca3af"
            atmosphereColor="#9ca3af"
            showAtmosphere
            autoRotateSpeed={0.85}
            enableZoom
            interactive
            arcCount={10}
            arcInterval={6000}
            arcAnimationDuration={2000}
            cameraAltitude={compact ? 2.45 : 2.35}
            pointSize={0.25}
            pointResolution={5}
            atmosphereAltitude={0.15}
            globeOpacity={1}
            landDotRows={200}
            landMapUrl="/earth-land-mask.png"
            onReady={() => setReady(true)}
            onGlobeClick={(next) => setCoords(next)}
            className="hero-globe"
          />
        </div>
      </section>

      <footer className="bottombar">
        <div className="readout">
          <div className="readout-label">
            {coords ? 'Target acquired' : 'Dotted earth'}
          </div>
          <div className="readout-value" aria-live="polite">
            {coords ? (
              <>
                <span className="coords">{formatLat(coords.lat)}</span>
                <span className="sep">/</span>
                <span className="coords">{formatLng(coords.lng)}</span>
              </>
            ) : (
              <span>
                {compact
                  ? 'Drag to spin · Pinch to zoom · Tap to target'
                  : 'Drag to spin · Scroll to zoom · Click to target'}
              </span>
            )}
          </div>
        </div>

        <div className="palette" role="group" aria-label="Arc colour">
          {PRESETS.map((preset, index) => (
            <button
              key={preset.name}
              type="button"
              className="swatch"
              style={{ '--swatch': preset.color } as CSSProperties}
              data-active={index === activePreset}
              aria-label={`Use ${preset.name} arcs`}
              aria-pressed={index === activePreset}
              onClick={() => setActivePreset(index)}
            />
          ))}
        </div>
      </footer>
    </main>
  );
}
