import { useBrainStore } from '../store';
import { REGION_BY_ID } from '../data/regions';

function NeuromodBar({ label, value, base, range = [0, 1], color }: {
  label: string; value: number; base: number; range?: [number, number]; color: string;
}) {
  const [lo, hi] = range;
  const span = hi - lo;
  const pct = ((value - lo) / span) * 100;
  const basePct = ((base - lo) / span) * 100;
  return (
    <div className="nm-bar">
      <div className="nm-label">
        <span>{label}</span>
        <span className="nm-value">{value.toFixed(2)}</span>
      </div>
      <div className="nm-track">
        <div className="nm-baseline" style={{ left: `${basePct}%` }} />
        <div className="nm-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

export function Telemetry() {
  const nm = useBrainStore(s => s.neuromod);
  const log = useBrainStore(s => s.log);
  const faults = useBrainStore(s => s.faultsDetected);
  const swap = useBrainStore(s => s.swapInProgress);
  const vlmLoaded = useBrainStore(s => s.vlmLoaded);
  const selection = useBrainStore(s => s.selection);
  const region = selection?.kind === 'region' ? REGION_BY_ID[selection.id] : null;

  return (
    <div className="telemetry">
      <div className="tel-section">
        <h3>NEUROMODULATORS</h3>
        <NeuromodBar label="DA tonic" value={nm.da_tonic} base={0.5} color="#ffae42" />
        <NeuromodBar label="DA phasic" value={nm.da_phasic} base={0} range={[-1, 1]} color="#ff8c1a" />
        <NeuromodBar label="NE (arousal)" value={nm.ne} base={0.2} color="#ff5f56" />
        <NeuromodBar label="ACh (gain)" value={nm.ach} base={0.4} color="#5fffaa" />
        <NeuromodBar label="5-HT (patience)" value={nm.ser} base={0.5} color="#a07fff" />
      </div>

      <div className="tel-section">
        <h3>VRAM STATE</h3>
        <div className="vram-row">
          <span className={`pill ${vlmLoaded ? 'on' : 'off'}`}>VLM {vlmLoaded ? 'RESIDENT' : 'OFFLINE'}</span>
          <span className={`pill ${swap ? 'warn' : 'ok'}`}>{swap ? 'SWAP IN PROGRESS' : 'STABLE'}</span>
        </div>
      </div>

      {region && (
        <div className="tel-section region-info">
          <h3>SELECTED REGION</h3>
          <div className="region-detail">
            <div className="rd-name" style={{ color: region.color }}>{region.label}</div>
            <div className="rd-model">{region.model}</div>
            {region.vramGb > 0 && <div className="rd-vram">{region.vramGb} GB VRAM</div>}
            <div className="rd-role">{region.cortanaRole}</div>
            {region.notes && <div className="rd-notes">→ {region.notes}</div>}
            <div className="rd-flags">
              {region.selfTunable && <span className="flag tune">self-tunable</span>}
              {region.alwaysOn ? <span className="flag on">always-on</span> : <span className="flag lazy">lazy-loaded</span>}
            </div>
          </div>
        </div>
      )}

      {faults.length > 0 && (
        <div className="tel-section faults">
          <h3>⚠ FAULTS DETECTED</h3>
          <ul>
            {faults.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}

      <div className="tel-section log">
        <h3>EVENT LOG</h3>
        <div className="log-stream">
          {log.slice(-12).reverse().map((entry, i) => (
            <div key={`${entry.ts}-${i}`} className={`log-entry ${entry.level}`}>
              <span className="log-time">{new Date(entry.ts).toLocaleTimeString().slice(-8)}</span>
              <span className="log-text">{entry.text}</span>
            </div>
          ))}
          {log.length === 0 && <div className="log-empty">no events — fire an input</div>}
        </div>
      </div>
    </div>
  );
}
