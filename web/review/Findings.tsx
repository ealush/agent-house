import { useState } from 'react';
import type { Finding, Layer, ReviewApi } from '../reviewApi.ts';
import { askConfirm, showError } from '../ask.tsx';
import { Icon } from '../icons.tsx';
import { SeveritySeg, splitNote, type Severity } from './Diff.tsx';

const SOURCE = (s: string) => (s === 'you' ? 'You' : s === 'reviewer' ? 'Reviewer' : s.replace(/^(bot|gh):/, '').replace(/^chatgpt-codex-connector$/, 'Codex').replace(/\[bot\]$/, ''));
const STATE_WORD: Record<Finding['state'], string> = { proposed: 'Proposed', open: 'Open', sent: 'Sent', addressed: 'Addressed', wontfix: "Won't fix", dismissed: 'Dismissed' };

function where(f: Finding): string | null {
  if (!f.path) return null;
  return `${f.path}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `–${f.lineEnd}` : ''}` : ''}`;
}

/** One finding: what, where, who said it, and what you can do with it now. */
export function FindingRow({
  f,
  api,
  stackId,
  layers,
  selected,
  onSelect,
  onChanged,
  compact,
}: {
  f: Finding;
  api: ReviewApi;
  stackId: string;
  layers: Layer[];
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onChanged: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = layers.find((l) => l.pr === f.ownerPr);
  const set = async (patch: Parameters<ReviewApi['updateFinding']>[2]) => {
    setBusy(true);
    try {
      await api.updateFinding(stackId, f.id, patch);
      onChanged();
    } catch (e) {
      showError(e, "Couldn't update the finding");
    } finally {
      setBusy(false);
    }
  };
  const resolve = async () => {
    const ok = await askConfirm({ title: 'Resolve the thread on GitHub?', body: f.note ? `Replies "${f.note.slice(0, 120)}", then resolves it.` : 'Resolves it without a reply.', confirm: 'Resolve' });
    if (!ok) return;
    setBusy(true);
    try {
      await api.resolveThread(stackId, f.id, f.note ?? '');
      onChanged();
    } catch (e) {
      showError(e, "Couldn't resolve the thread");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`finding sev-${f.severity} ${f.state} ${selected ? 'selected' : ''}`}>
      <div className="finding-head">
        {onSelect && f.state === 'open' ? (
          <label className="pick">
            <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select "${f.title}"`} />
            <span className="box" aria-hidden />
          </label>
        ) : (
          <span className="dot" aria-hidden />
        )}
        <button type="button" className="finding-title" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {f.title}
        </button>
        {f.state !== 'open' && <span className={`pill ${f.state === 'addressed' ? 'attention' : f.state === 'sent' ? 'busy' : f.state === 'proposed' ? 'waiting' : ''}`}>{STATE_WORD[f.state]}</span>}
      </div>
      <div className="finding-meta">
        <span className={`sev sev-${f.severity}`}>{f.severity}</span>
        {where(f) && <span className="mono">{where(f)}</span>}
        <span>{SOURCE(f.source)}</span>
        {f.ownerPr !== f.foundOnPr && owner && <span>for {owner.role || `#${owner.pr}`}</span>}
        {f.ghUrl && (
          <a href={f.ghUrl} target="_blank" rel="noreferrer">
            GitHub <Icon name="external" size={12} />
          </a>
        )}
      </div>
      {(open || (!compact && f.state === 'proposed')) && f.body && <p className="finding-body">{f.body}</p>}
      {f.note && f.state !== 'open' && <p className="finding-note">{f.note}</p>}
      {open && (
        <div className="finding-actions">
          {f.state === 'open' && (
            <>
              <button className="btn ghost small" disabled={busy} onClick={() => set({ state: 'addressed' })}>
                Addressed
              </button>
              <button className="btn ghost small" disabled={busy} onClick={() => set({ state: 'wontfix' })}>
                Won't fix
              </button>
              <select
                className="review-select"
                aria-label="Severity"
                value={f.severity}
                disabled={busy}
                onChange={(e) => set({ severity: e.target.value })}
              >
                <option value="blocking">Blocking</option>
                <option value="should">Should</option>
                <option value="nit">Nit</option>
              </select>
              {layers.length > 1 && (
                <select className="review-select" aria-label="Layer that should change" value={f.ownerPr} disabled={busy} onChange={(e) => set({ ownerPr: Number(e.target.value) })}>
                  {layers
                    .filter((l) => l.state === 'open' || l.pr === f.ownerPr)
                    .map((l) => (
                      <option key={l.pr} value={l.pr}>
                        For {l.role || `#${l.pr}`}
                      </option>
                    ))}
                </select>
              )}
            </>
          )}
          {(f.state === 'addressed' || f.state === 'wontfix' || f.state === 'dismissed' || f.state === 'sent') && (
            <button className="btn ghost small" disabled={busy} onClick={() => set({ state: 'open' })}>
              Reopen
            </button>
          )}
          {f.ghThread && f.state !== 'proposed' && (
            <button className="btn ghost small" disabled={busy} onClick={resolve}>
              Resolve on GitHub
            </button>
          )}
        </div>
      )}
      {f.state === 'proposed' && (
        <div className="finding-actions">
          <button className="btn small" disabled={busy} onClick={() => set({ state: 'open' })}>
            Keep
          </button>
          <button className="btn ghost small" disabled={busy} onClick={() => set({ state: 'dismissed' })}>
            Dismiss
          </button>
        </div>
      )}
    </li>
  );
}

/** A finding about the layer as a whole (no line): a small form under the list. */
function NewFinding({ api, stackId, pr, onAdded }: { api: ReviewApi; stackId: string; pr: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sev, setSev] = useState<Severity>('should');
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button className="btn ghost small add-finding" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> Finding
      </button>
    );
  const submit = async () => {
    const { title, body } = splitNote(text);
    if (!title) return;
    setBusy(true);
    try {
      await api.addFinding(stackId, { ownerPr: pr, title, body, severity: sev });
      setText('');
      setOpen(false);
      onAdded();
    } catch (e) {
      showError(e, "Couldn't add the finding");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="comment-box loose"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should change? The first line is the title."
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="row-actions">
        <SeveritySeg value={sev} onChange={setSev} />
        <span className="spacer" />
        <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="btn primary small" disabled={busy || !text.trim()}>
          Add finding
        </button>
      </div>
    </form>
  );
}

/**
 * A layer's findings in the order you act on them: proposals to keep or
 * dismiss, open ones to select and send, sent ones the agent is on, then the
 * closed ones folded away.
 */
export function FindingsList({
  api,
  stackId,
  layer,
  layers,
  findings,
  selected,
  setSelected,
  onChanged,
  onImport,
  importing,
}: {
  api: ReviewApi;
  stackId: string;
  layer: Layer;
  layers: Layer[];
  findings: Finding[];
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  onChanged: () => void;
  onImport: () => void;
  importing: boolean;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const mine = findings.filter((f) => f.ownerPr === layer.pr || f.foundOnPr === layer.pr);
  const groups: [string, Finding[]][] = [
    ['Proposed by the reviewer', mine.filter((f) => f.state === 'proposed')],
    ['Open', mine.filter((f) => f.state === 'open' && f.ownerPr === layer.pr)],
    ['Sent to the agent', mine.filter((f) => f.state === 'sent' && f.ownerPr === layer.pr)],
    ['For other layers', mine.filter((f) => f.ownerPr !== layer.pr && f.state !== 'proposed' && f.state !== 'dismissed')],
  ];
  const closed = mine.filter((f) => f.ownerPr === layer.pr && (f.state === 'addressed' || f.state === 'wontfix' || f.state === 'dismissed'));
  const openIds = mine.filter((f) => f.state === 'open' && f.ownerPr === layer.pr).map((f) => f.id);
  const toggle = (id: number, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  return (
    <div className="findings">
      <div className="findings-bar">
        {openIds.length > 1 && (
          <button className="btn ghost small" onClick={() => setSelected(selected.size === openIds.length ? new Set() : new Set(openIds))}>
            {selected.size === openIds.length ? 'Select none' : 'Select all open'}
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost small" onClick={onImport} disabled={importing} title="Bring in review threads from GitHub, bots included">
          {importing ? 'Reading GitHub…' : 'GitHub threads'}
        </button>
        <NewFinding api={api} stackId={stackId} pr={layer.pr} onAdded={onChanged} />
      </div>
      {!mine.length && <p className="panel-msg">No findings yet. Click a line in the diff, ask the reviewer, or bring in GitHub's threads.</p>}
      {groups.map(([title, list]) =>
        list.length ? (
          <section key={title}>
            <h3 className="findings-label">
              {title} <span className="count">{list.length}</span>
            </h3>
            <ul className="finding-list">
              {list.map((f) => (
                <FindingRow key={f.id} f={f} api={api} stackId={stackId} layers={layers} selected={selected.has(f.id)} onSelect={f.ownerPr === layer.pr ? (on) => toggle(f.id, on) : undefined} onChanged={onChanged} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {closed.length > 0 && (
        <section>
          <button className="findings-label linkish" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
            Closed <span className="count">{closed.length}</span>
          </button>
          {showClosed && (
            <ul className="finding-list">
              {closed.map((f) => (
                <FindingRow key={f.id} f={f} api={api} stackId={stackId} layers={layers} onChanged={onChanged} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
