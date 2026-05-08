import { INPUTS } from '../data/inputs';
import { useBrainStore } from '../store';

export function InputPanel() {
  // Legacy panel — no longer mounted by App in v0.2 (explore mode), kept
  // for reference / future feature toggle.
  const fireInput = useBrainStore(s => s.fireInput);
  const reset = useBrainStore(s => s.reset);
  const total = useBrainStore(s => s.totalActivations);
  const exploded = false;
  const setExploded = (_: boolean) => {};

  return (
    <div className="input-panel">
      <div className="panel-header">
        <h2>DISCORD INPUTS</h2>
        <div className="panel-sub">Trigger an event → watch the brain fire</div>
      </div>

      <div className="explode-row">
        <button
          className={`explode-toggle ${exploded ? 'on' : 'off'}`}
          onClick={() => setExploded(!exploded)}
          title={exploded ? 'Reassemble brain' : 'Explode brain into regions'}
        >
          <span className="explode-dot" aria-hidden />
          <span>EXPLODED VIEW</span>
          <span className="explode-state">{exploded ? 'ON' : 'OFF'}</span>
        </button>
      </div>

      <div className="input-list">
        {INPUTS.map(inp => (
          <button
            key={inp.id}
            className="input-button"
            onClick={() => fireInput(inp.id)}
            title={inp.description}
          >
            <span className="input-emoji">{inp.emoji}</span>
            <span className="input-text">
              <span className="input-label">{inp.label}</span>
              <span className="input-desc">{inp.description}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="panel-footer">
        <div className="counter">activations: <span>{total}</span></div>
        <button className="reset-btn" onClick={reset}>RESET</button>
      </div>
    </div>
  );
}
