import { INPUTS } from '../data/inputs';
import { useBrainStore } from '../store';

export function InputPanel() {
  const fireInput = useBrainStore(s => s.fireInput);
  const reset = useBrainStore(s => s.reset);
  const total = useBrainStore(s => s.totalActivations);
  const explode = useBrainStore(s => s.explode);
  const setExplode = useBrainStore(s => s.setExplode);

  return (
    <div className="input-panel">
      <div className="panel-header">
        <h2>DISCORD INPUTS</h2>
        <div className="panel-sub">Trigger an event → watch the brain fire</div>
      </div>

      <div className="explode-row">
        <div className="explode-label">
          <span>EXPLODED VIEW</span>
          <span className="explode-pct">{Math.round(explode * 100)}%</span>
        </div>
        <input
          type="range"
          className="explode-slider"
          min={0}
          max={1}
          step={0.01}
          value={explode}
          onChange={e => setExplode(parseFloat(e.target.value))}
        />
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
