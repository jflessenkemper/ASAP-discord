import { BrainScene } from './components/BrainScene';
import { InputPanel } from './components/InputPanel';
import { Telemetry } from './components/Telemetry';

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="title">
          <span className="title-bracket">[</span>
          CORTANA · BRAIN SIMULATOR
          <span className="title-bracket">]</span>
        </div>
        <div className="subtitle">v0.1 — open-source neural map · brain-mapped Discord agent</div>
      </header>

      <main className="app-main">
        <aside className="left-panel">
          <InputPanel />
        </aside>
        <section className="brain-canvas">
          <BrainScene />
          <div className="canvas-hint">drag to rotate · scroll to zoom · click region for details</div>
        </section>
        <aside className="right-panel">
          <Telemetry />
        </aside>
      </main>
    </div>
  );
}
