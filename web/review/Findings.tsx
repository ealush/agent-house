import { useState } from 'react';
import type { Finding, Layer, ReviewApi, Verdict } from '../reviewApi.ts';
import { askConfirm, askText, showError } from '../ask.tsx';
import { age } from '../agents.ts';
import { Icon } from '../icons.tsx';
import { SeveritySeg, splitNote, type Severity } from './Diff.tsx';
import { GitHubThread, commenter } from './GitHubText.tsx';

const SOURCE = (s: string) => (s === 'you' ? 'You' : s === 'reviewer' ? 'Reviewer' : commenter(s.replace(/^(bot|gh):/, '')));

function where(f: Finding): string | null {
  if (!f.path) return null;
  return `${f.path}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `–${f.lineEnd}` : ''}` : ''}`;
}

const SEV_WORD: Record<string, string> = { blocking: 'Blocking', should: 'Should', nit: 'Nit' };
const VERDICT_WORD = { addressed: 'Fixed', partly: 'Partly fixed', not: 'Not fixed' } as const;
const BY: Record<string, string> = { you: 'you', reviewer: 'the reviewer', github: 'GitHub' };

/** What the card says about where a finding stands: the reviewer's verdict on a fix, else its state. */
function standing(f: Finding, verdict?: Verdict['items'][number]): { word: string; tone: string } | null {
  if (f.state === 'sent' && verdict) return { word: VERDICT_WORD[verdict.verdict], tone: verdict.verdict === 'addressed' ? 'done' : 'needs' };
  if (f.state === 'sent') return { word: 'With the agent', tone: 'busy' };
  if (f.state === 'proposed') return { word: 'Proposed by the reviewer', tone: 'needs' };
  if (f.state === 'addressed') return { word: 'Fixed', tone: 'done' };
  if (f.state === 'wontfix') return { word: f.severity === 'blocking' ? 'Waived' : "Won't fix", tone: '' };
  if (f.state === 'dismissed') return { word: 'Dismissed', tone: '' };
  return null;
}

/** One finding as a card: severity, where it stands, what, where; tap the title for the why and what you can do. */
export function FindingRow({
  f,
  api,
  stackId,
  layers,
  selected,
  onSelect,
  onChanged,
  verdict,
  followup,
  onDiscuss,
}: {
  f: Finding;
  api: ReviewApi;
  stackId: string;
  layers: Layer[];
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onChanged: () => void;
  verdict?: Verdict['items'][number];
  followup?: boolean;
  /** Bring it to the reviewer's conversation. */
  onDiscuss?: (f: Finding) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const owner = layers.find((l) => l.pr === f.ownerPr);
  const set = async (patch: Parameters<ReviewApi['updateFinding']>[2], label = 'Saving…') => {
    setBusy(label);
    try {
      await api.updateFinding(stackId, f.id, patch);
      onChanged();
    } catch (e) {
      showError(e, "Couldn't update the finding");
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('Removing…');
    try {
      await api.deleteFinding(stackId, f.id);
      onChanged();
    } catch (e) {
      showError(e, "Couldn't remove the finding");
    } finally {
      setBusy(null);
    }
  };
  const waive = async () => {
    if (f.severity !== 'blocking') return set({ state: 'wontfix' }, 'Updating…');
    const note = await askText({ title: 'Waive this blocking finding?', body: 'It stops blocking the merge. The reason stays on the finding.', label: 'Why', value: f.note ?? '', confirm: 'Waive' });
    if (note?.trim()) await set({ state: 'wontfix', note: note.trim() }, 'Waiving…');
  };
  const resolve = async () => {
    const ok = await askConfirm({ title: 'Resolve the thread on GitHub?', body: f.note ? `Replies "${f.note.slice(0, 120)}", then resolves it.` : 'Resolves it without a reply.', confirm: 'Resolve' });
    if (!ok) return;
    setBusy('Resolving…');
    try {
      await api.resolveThread(stackId, f.id, f.note ?? '');
      onChanged();
    } catch (e) {
      showError(e, "Couldn't resolve the thread");
    } finally {
      setBusy(null);
    }
  };
  const st = standing(f, verdict);
  const settled = st?.tone === 'done' || f.state === 'wontfix' || f.state === 'dismissed';
  const history = f.stateBy && f.state !== 'open' && f.state !== 'proposed' ? `${st?.word ?? f.state} by ${BY[f.stateBy] ?? f.stateBy}${f.stateHead ? ` at ${f.stateHead}` : ''}${f.stateAt ? `, ${age(f.stateAt) === 'now' ? 'just now' : `${age(f.stateAt)} ago`}` : ''}` : null;
  return (
    <li className={`finding sev-${f.severity} ${f.state} ${st?.tone === 'needs' ? 'needs' : ''} ${settled ? 'settled' : ''} ${selected ? 'selected' : ''}`}>
      <div className="finding-head">
        {onSelect && f.state === 'open' && (
          <label className="pick">
            <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select "${f.title}"`} />
            <span className="box" aria-hidden />
          </label>
        )}
        <span className="finding-stack">
          <span className="finding-tags">
            <span className={`sev-chip sev-${f.severity}`}>{SEV_WORD[f.severity] ?? f.severity}</span>
            {followup && owner && <span className="state-word">From {owner.role || `#${owner.pr}`}, merged</span>}
            {st && <span className={`state-word ${st.tone}`}>{st.word}</span>}
          </span>
          <button type="button" className="finding-title" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {f.title}
          </button>
          <span className="finding-meta">
            {where(f) && <span className="mono">{where(f)}</span>}
            <span>{SOURCE(f.source)}</span>
            {!followup && f.ownerPr !== f.foundOnPr && owner && <span>for {owner.role || `#${owner.pr}`}</span>}
            {f.ghUrl && (
              <a href={f.ghUrl} target="_blank" rel="noreferrer">
                GitHub <Icon name="external" size={12} />
              </a>
            )}
          </span>
        </span>
        {onDiscuss && f.state !== 'proposed' && (
          <button type="button" className="icon-btn discuss" onClick={() => onDiscuss(f)} aria-label={`Discuss "${f.title}" with the reviewer`} title="Discuss with the reviewer">
            <Icon name="chat" size={16} />
          </button>
        )}
      </div>
      {(open || f.state === 'proposed') && f.body && (
        <div className="finding-body">
          <GitHubThread body={f.body} image={(src) => api.imageUrl(stackId, src)} />
        </div>
      )}
      {(verdict?.evidence || (f.note && f.state !== 'open')) && (open || st?.tone === 'needs' || f.state === 'wontfix') && <p className="finding-note">{verdict?.evidence || f.note}</p>}
      {open && history && <p className="finding-history">{history}</p>}
      {open && (
        <div className="finding-actions">
          {f.state === 'open' && (
            <>
              <button className="btn ghost small" disabled={!!busy} onClick={() => set({ state: 'addressed' }, 'Marking…')}>
                {busy === 'Marking…' ? 'Marking…' : 'Fixed'}
              </button>
              <button className="btn ghost small" disabled={!!busy} onClick={waive}>
                {busy === 'Waiving…' ? 'Waiving…' : f.severity === 'blocking' ? 'Waive…' : "Won't fix"}
              </button>
              <select className="review-select" aria-label="Severity" value={f.severity} disabled={!!busy} onChange={(e) => set({ severity: e.target.value })}>
                <option value="blocking">Blocking</option>
                <option value="should">Should</option>
                <option value="nit">Nit</option>
              </select>
              {layers.length > 1 && (
                <select className="review-select" aria-label="Layer that should change" value={f.ownerPr} disabled={!!busy} onChange={(e) => set({ ownerPr: Number(e.target.value) })}>
                  {layers
                    .filter((l) => l.state === 'open' || l.pr === f.ownerPr)
                    .map((l) => (
                      <option key={l.pr} value={l.pr}>
                        For {l.role || `#${l.pr}`}
                      </option>
                    ))}
                </select>
              )}
              {!f.ghThread && (
                <button className="btn ghost small danger-text" disabled={!!busy} onClick={remove}>
                  {busy === 'Removing…' ? 'Removing…' : 'Remove'}
                </button>
              )}
            </>
          )}
          {(f.state === 'addressed' || f.state === 'wontfix' || f.state === 'dismissed' || f.state === 'sent') && (
            <button className="btn ghost small" disabled={!!busy} onClick={() => set({ state: 'open' }, 'Reopening…')}>
              {busy === 'Reopening…' ? 'Reopening…' : 'Reopen'}
            </button>
          )}
          {f.ghThread && f.state !== 'proposed' && (
            <button className="btn ghost small" disabled={!!busy} onClick={resolve}>
              {busy === 'Resolving…' ? 'Resolving…' : 'Resolve on GitHub'}
            </button>
          )}
        </div>
      )}
      {f.state === 'proposed' && (
        <div className="finding-actions">
          <button className="btn small" disabled={!!busy} onClick={() => set({ state: 'open' }, 'Keeping…')}>
            {busy === 'Keeping…' ? 'Keeping…' : 'Keep'}
          </button>
          <button className="btn ghost small" disabled={!!busy} onClick={() => set({ state: 'dismissed' }, 'Dismissing…')}>
            {busy === 'Dismissing…' ? 'Dismissing…' : 'Dismiss'}
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
      <button className="add-finding" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> Add a finding, or click a line
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
 * dismiss, then the ones to send and the ones with the agent (with the
 * reviewer's verdict once a fix is back), follow-ups left by merged layers,
 * other layers' findings made here, and the closed ones folded away.
 */
export function FindingsList({
  api,
  stackId,
  layer,
  layers,
  findings,
  followups,
  selected,
  setSelected,
  onChanged,
  onImport,
  importing,
  onDiscuss,
}: {
  api: ReviewApi;
  stackId: string;
  layer: Layer;
  layers: Layer[];
  findings: Finding[];
  followups: Finding[];
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  onChanged: () => void;
  onImport: () => void;
  importing: boolean;
  onDiscuss?: (f: Finding) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const mine = findings.filter((f) => f.ownerPr === layer.pr || f.foundOnPr === layer.pr);
  const verdicts = new Map((layer.status === 'rereview' ? (layer.current?.verdict?.items ?? []) : []).map((v) => [v.id, v]));
  const proposed = mine.filter((f) => f.state === 'proposed');
  const live = mine
    .filter((f) => (f.state === 'open' || f.state === 'sent') && f.ownerPr === layer.pr)
    .sort((a, b) => rank(a, verdicts) - rank(b, verdicts));
  const others = mine.filter((f) => f.ownerPr !== layer.pr && f.state !== 'proposed' && f.state !== 'dismissed');
  const closed = mine.filter((f) => f.ownerPr === layer.pr && (f.state === 'addressed' || f.state === 'wontfix' || f.state === 'dismissed'));
  const openIds = [...live, ...followups].filter((f) => f.state === 'open').map((f) => f.id);
  const toggle = (id: number, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const row = (f: Finding, opts: { select?: boolean; followup?: boolean } = {}) => (
    <FindingRow key={f.id} f={f} api={api} stackId={stackId} layers={layers} selected={selected.has(f.id)} onSelect={opts.select ? (on) => toggle(f.id, on) : undefined} onChanged={onChanged} verdict={verdicts.get(f.id)} followup={opts.followup} onDiscuss={onDiscuss} />
  );
  return (
    <div className="findings">
      {openIds.length > 1 && (
        <div className="findings-bar">
          <button className="btn ghost small" onClick={() => setSelected(selected.size === openIds.length ? new Set() : new Set(openIds))}>
            {selected.size === openIds.length ? 'Select none' : 'Select all open'}
          </button>
        </div>
      )}
      {!mine.length && !followups.length && <p className="panel-msg">No findings yet. Click a line in the diff, ask the reviewer, or bring in GitHub's threads.</p>}
      {proposed.length > 0 && (
        <section>
          <h3 className="findings-label">
            Proposed by the reviewer <span className="count">{proposed.length}</span>
          </h3>
          <ul className="finding-list">{proposed.map((f) => row(f))}</ul>
        </section>
      )}
      {live.length > 0 && <ul className="finding-list">{live.map((f) => row(f, { select: true }))}</ul>}
      {followups.length > 0 && (
        <section>
          <h3 className="findings-label">
            Follow-ups from merged layers <span className="count">{followups.length}</span>
          </h3>
          <ul className="finding-list">{followups.map((f) => row(f, { select: true, followup: true }))}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section>
          <h3 className="findings-label">
            For other layers <span className="count">{others.length}</span>
          </h3>
          <ul className="finding-list">{others.map((f) => row(f))}</ul>
        </section>
      )}
      {closed.length > 0 && (
        <section>
          <button className="findings-label linkish" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
            Closed <span className="count">{closed.length}</span>
          </button>
          {showClosed && <ul className="finding-list">{closed.map((f) => row(f))}</ul>}
        </section>
      )}
      <div className="findings-add">
        <NewFinding api={api} stackId={stackId} pr={layer.pr} onAdded={onChanged} />
        <button className="btn ghost small import" onClick={onImport} disabled={importing} title="Bring in review threads from GitHub, bots included">
          <Icon name="reply" size={14} /> {importing ? 'Reading GitHub…' : 'Bring in GitHub threads'}
        </button>
      </div>
    </div>
  );
}

/** What needs you first: a fix not fully made, then open, then with the agent, then fixed. */
function rank(f: Finding, verdicts: Map<number, Verdict['items'][number]>): number {
  const v = verdicts.get(f.id);
  if (f.state === 'sent' && v) return v.verdict === 'addressed' ? 3 : 0;
  return f.state === 'open' ? 1 : 2;
}
