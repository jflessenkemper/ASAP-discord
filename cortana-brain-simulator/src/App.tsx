import { BrainScene } from './components/BrainScene';
import { DetailPanel } from './components/DetailPanel';

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="title">
          <span className="title-bracket">[</span>
          CORTANA · BRAIN SIMULATOR
          <span className="title-bracket">]</span>
        </div>
        <div className="subtitle">v0.2 — click any cube to inspect · ASAP Discord interface</div>
      </header>

      <main className="app-main app-main-explore">
        <DetailPanel />
        <section className="brain-canvas brain-canvas-full">
          <BrainScene />
          <div className="canvas-hint">drag to rotate · scroll to zoom · click any cube</div>
        </section>
      </main>
    </div>
  );
}
