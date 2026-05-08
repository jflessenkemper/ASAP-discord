import { useBrainStore } from '../store';
import { REGION_BY_ID, CONNECTIONS, type RegionId } from '../data/regions';
import { IO_BOX_BY_ID, type IOBoxId, type IOBox } from '../data/ioBoxes';

/**
 * Slide-in detail panel on the left. Renders different content depending on
 * what's selected: a brain region, an eye/ear (sensory), or the mouth/spine
 * (motor). Empty when nothing is selected.
 */
export function DetailPanel() {
  const selection = useBrainStore(s => s.selection);
  const close = useBrainStore(s => s.clearSelection);

  if (!selection) return null;

  return (
    <aside className="detail-panel">
      <button className="detail-close" onClick={close} aria-label="Close panel">×</button>
      {selection.kind === 'region' ? (
        <RegionDetail id={selection.id as RegionId} />
      ) : (
        <IODetail id={selection.id as IOBoxId} />
      )}
    </aside>
  );
}

// ─── Brain region view ─────────────────────────────────────────────────

function RegionDetail({ id }: { id: RegionId }) {
  const region = REGION_BY_ID[id];
  if (!region) return null;

  const out = CONNECTIONS.filter(c => c.from === id);
  const inc = CONNECTIONS.filter(c => c.to === id);

  return (
    <div className="detail-content">
      <header className="detail-head">
        <div className="detail-kind">BRAIN REGION</div>
        <h2 className="detail-title" style={{ color: region.color }}>{region.label}</h2>
        <div className="detail-sub">{region.cortanaRole}</div>
      </header>

      <section className="detail-section">
        <div className="detail-section-title">Model</div>
        <div className="detail-row">
          <span className="detail-row-key">Implementation</span>
          <span className="detail-row-val">{region.model}</span>
        </div>
        <div className="detail-row">
          <span className="detail-row-key">VRAM</span>
          <span className="detail-row-val">{region.vramGb > 0 ? `${region.vramGb} GB` : '—'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-row-key">Always-on</span>
          <span className="detail-row-val">{region.alwaysOn ? 'yes' : 'lazy-loaded'}</span>
        </div>
        <div className="detail-row">
          <span className="detail-row-key">Self-tunable</span>
          <span className="detail-row-val">{region.selfTunable ? 'yes (online + nightly)' : 'frozen'}</span>
        </div>
      </section>

      {region.notes && (
        <section className="detail-section">
          <div className="detail-section-title">Notes</div>
          <div className="detail-note">{region.notes}</div>
        </section>
      )}

      {(out.length > 0 || inc.length > 0) && (
        <section className="detail-section">
          <div className="detail-section-title">Connections</div>
          {out.length > 0 && (
            <div className="conn-group">
              <div className="conn-label">→ outgoing</div>
              {out.map((c, i) => (
                <ConnRow key={`o${i}`} other={REGION_BY_ID[c.to]?.label ?? c.to} type={c.type} />
              ))}
            </div>
          )}
          {inc.length > 0 && (
            <div className="conn-group">
              <div className="conn-label">← incoming</div>
              {inc.map((c, i) => (
                <ConnRow key={`i${i}`} other={REGION_BY_ID[c.from]?.label ?? c.from} type={c.type} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ConnRow({ other, type }: { other: string; type: string }) {
  return (
    <div className="conn-row">
      <span className={`conn-type conn-${type}`}>{type}</span>
      <span className="conn-name">{other}</span>
    </div>
  );
}

// ─── I/O box view ──────────────────────────────────────────────────────

function IODetail({ id }: { id: IOBoxId }) {
  const box = IO_BOX_BY_ID[id];
  if (!box) return null;

  const headlineByKind: Record<IOBox['kind'], string> = {
    eye: 'VISUAL INPUT',
    ear: 'AUDIO INPUT',
    mouth: 'VOICE OUTPUT',
    spine: 'TOOL LAYER',
  };

  return (
    <div className="detail-content">
      <header className="detail-head">
        <div className="detail-kind">{headlineByKind[box.kind]}</div>
        <h2 className="detail-title" style={{ color: box.color }}>{box.label}</h2>
      </header>

      {box.inputs && box.inputs.length > 0 && (
        <section className="detail-section">
          <div className="detail-section-title">Discord input streams</div>
          {box.inputs.map((inp, i) => (
            <div key={i} className="io-stream">
              <div className="io-stream-source">{inp.source}</div>
              <div className="io-stream-meta">
                <span className="io-stream-format">{inp.format}</span>
                <span className="io-stream-quality">{inp.quality}</span>
              </div>
              {inp.notes && <div className="io-stream-notes">{inp.notes}</div>}
            </div>
          ))}
        </section>
      )}

      {box.outputs && box.outputs.length > 0 && (
        <section className="detail-section">
          <div className="detail-section-title">Discord output streams</div>
          {box.outputs.map((o, i) => (
            <div key={i} className="io-stream">
              <div className="io-stream-source">{o.source}</div>
              <div className="io-stream-meta">
                <span className="io-stream-format">{o.format}</span>
                <span className="io-stream-quality">{o.quality}</span>
              </div>
              {o.notes && <div className="io-stream-notes">{o.notes}</div>}
            </div>
          ))}
        </section>
      )}

      {box.models && box.models.length > 0 && (
        <section className="detail-section">
          <div className="detail-section-title">Models</div>
          {box.models.map((m, i) => (
            <div key={i} className="io-model">
              <div className="io-model-name">{m.name}{m.size ? ` · ${m.size}` : ''}</div>
              <div className="io-model-role">{m.role}</div>
            </div>
          ))}
        </section>
      )}

      {box.tools && box.tools.length > 0 && (
        <section className="detail-section">
          <div className="detail-section-title">Discord tool calls ({box.tools.length})</div>
          <div className="tool-grid">
            {box.tools.map((t, i) => (
              <div key={i} className="tool-card">
                <div className="tool-name">{t.name}</div>
                <div className="tool-desc">{t.description}</div>
                {t.api && <div className="tool-api">{t.api}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {(box.pipesTo || box.pipesFrom) && (
        <section className="detail-section">
          <div className="detail-section-title">Brain wiring</div>
          {box.pipesTo && box.pipesTo.length > 0 && (
            <div className="conn-group">
              <div className="conn-label">→ feeds into</div>
              {box.pipesTo.map(rid => (
                <div key={rid} className="conn-row">
                  <span className="conn-name">{REGION_BY_ID[rid as RegionId]?.label ?? rid}</span>
                </div>
              ))}
            </div>
          )}
          {box.pipesFrom && box.pipesFrom.length > 0 && (
            <div className="conn-group">
              <div className="conn-label">← driven by</div>
              {box.pipesFrom.map(rid => (
                <div key={rid} className="conn-row">
                  <span className="conn-name">{REGION_BY_ID[rid as RegionId]?.label ?? rid}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {box.notes && box.notes.length > 0 && (
        <section className="detail-section">
          <div className="detail-section-title">Notes</div>
          <ul className="detail-bullets">
            {box.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
