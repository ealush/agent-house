import { useMemo, useState } from 'react';
import { parsePatch } from '../Git.tsx';
import { Icon } from '../icons.tsx';
import type { Finding } from '../reviewApi.ts';
import { pickedLines, type AskedLines } from './askLines.ts';

export type { AskedLines };

export type Severity = 'blocking' | 'should' | 'nit';

const STATE_WORD: Record<string, string> = { sent: 'with the agent', addressed: 'fixed', wontfix: "won't fix" };

/** A finding's first line is its title; the rest is the why. */
export function splitNote(text: string): { title: string; body: string } {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const first = (nl < 0 ? t : t.slice(0, nl)).trim();
  const rest = nl < 0 ? '' : t.slice(nl + 1).trim();
  if (first.length <= 140) return { title: first, body: rest };
  return { title: `${first.slice(0, 137).trimEnd()}…`, body: t };
}

export function SeveritySeg({ value, onChange }: { value: Severity; onChange: (s: Severity) => void }) {
  return (
    <div className="seg sev-seg" role="radiogroup" aria-label="Severity">
      {(['blocking', 'should', 'nit'] as const).map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} className={`${value === s ? 'on' : ''} sev-${s}`} onClick={() => onChange(s)}>
          {s === 'blocking' ? 'Blocking' : s === 'should' ? 'Should' : 'Nit'}
        </button>
      ))}
    </div>
  );
}

/**
 * A layer's patch with its findings drawn on the lines they're about. Click a
 * line (or Enter on it) to file a finding there, or to ask the reviewer about
 * it; Shift+click another line of the file to take a range. The first line you
 * write is the finding's title. Large files start folded.
 */
export function ReviewDiff({
  patch,
  findings,
  onFile,
  onSendLine,
  sessionName,
  onAsk,
  onAskFile,
  touch = false,
}: {
  patch: string;
  findings: Finding[];
  onFile?: (f: { path: string; line: number; title: string; body: string; severity: Severity }) => Promise<void>;
  /** Log a line comment and send it straight back to the originating/owner session. */
  onSendLine?: (f: { path: string; line: number; title: string; body: string; severity: Severity }) => Promise<void>;
  sessionName?: string | null;
  /** Bring the lines to the reviewer, with what you wrote as the start of your question. */
  onAsk?: (lines: AskedLines, note: string) => void;
  onAskFile?: (path: string) => void;
  /** A finger, not a pointer: a second tap stretches the selection, and a bar at the bottom asks or files. */
  touch?: boolean;
}) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  // The line you clicked, and the other end of a Shift+click range.
  const [open, setOpen] = useState<{ file: string; i: number; j?: number; writing?: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [sev, setSev] = useState<Severity>('should');
  const [busy, setBusy] = useState<'save' | 'send' | null>(null);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const marks = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of findings) {
      if (!f.path || !f.lineStart || f.state === 'dismissed' || f.state === 'proposed') continue;
      const k = `${f.path}:${f.lineStart}`;
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    return m;
  }, [findings]);

  if (!files.length) return <p className="panel-msg">No changes.</p>;

  function ask(lines: ReturnType<typeof parsePatch>[number]['lines'], path: string) {
    if (!open || !onAsk) return;
    onAsk(pickedLines(lines, path, open.i, open.j), draft.trim());
    setOpen(null);
    setDraft('');
  }

  async function submit(path: string, line: number, sendNow = false) {
    const { title, body } = splitNote(draft);
    const fn = sendNow ? onSendLine : onFile;
    if (!title || !fn) return;
    setBusy(sendNow ? 'send' : 'save');
    try {
      await fn({ path, line, title, body, severity: sev });
      setOpen(null);
      setDraft('');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="diff review-diff" data-rove=".dl.pickable">
      {files.map((f, fi) => {
        const big = f.lines.length > 400;
        const shut = folded.has(f.path) || (big && !unfolded.has(f.path));
        const toggle = () => {
          if (big) setUnfolded((s) => (s.has(f.path) ? new Set([...s].filter((x) => x !== f.path)) : new Set([...s, f.path])));
          else setFolded((s) => (s.has(f.path) ? new Set([...s].filter((x) => x !== f.path)) : new Set([...s, f.path])));
        };
        return (
          <section key={f.path} className="diff-block">
            <div className="diff-file-row">
              <button type="button" className="diff-file" onClick={toggle} aria-expanded={!shut}>
                <span className={`fold-mark ${shut ? 'shut' : ''}`} aria-hidden>
                  <Icon name="chevron-down" size={14} />
                </span>
                <span className="grow">{f.path}</span>
                <span className="add-n">+{f.add}</span>
                <span className="del-n">−{f.del}</span>
                {files.length > 1 && <span className="file-n">{`${fi + 1} of ${files.length}`}</span>}
              </button>
              {onAskFile && (
                <button type="button" className="icon-btn file-ask" onClick={() => onAskFile(f.path)} aria-label={`Discuss ${f.path} with the reviewer`} title="Discuss this file with the reviewer">
                  <Icon name="chat" size={16} />
                </button>
              )}
            </div>
            {shut ? (
              <button type="button" className="diff-fold" onClick={toggle}>
                Show {f.lines.length} lines
              </button>
            ) : (
              f.lines.map((l, i) => {
                const here = l.kind !== 'hunk' && l.kind !== 'del' && l.n !== null ? marks.get(`${f.path}:${l.n}`) : undefined;
                // A finding goes on a line of the new side; a question can be about any line, removed ones too.
                const fileable = !!onFile && l.kind !== 'hunk' && l.kind !== 'del' && l.n !== null;
                const pickable = l.kind !== 'hunk' && (fileable || !!onAsk);
                const mine = open?.file === f.path;
                const last = mine ? Math.max(open.i, open.j ?? open.i) : -1;
                const inRange = mine && i >= Math.min(open.i, open.j ?? open.i) && i <= last;
                // By touch, the box opens only once you choose Comment in the bar.
                const isOpen = mine && i === last && (!touch || !!open.writing);
                const anchor = mine ? f.lines[open.i] : null;
                const anchorFileable = !!onFile && !!anchor && anchor.kind !== 'del' && anchor.n !== null;
                const pick = (shift: boolean) => {
                  // By touch there's no Shift: a tap on another line of the file stretches the selection to it.
                  if ((shift || touch) && mine && !(touch && i === open.i && open.j === undefined)) setOpen({ file: f.path, i: open.i, j: i === open.i ? undefined : i });
                  else setOpen(mine && open.i === i && open.j === undefined ? null : { file: f.path, i });
                };
                return (
                  <div key={i}>
                    <div
                      className={`dl ${l.kind} ${pickable ? 'pickable' : ''} ${here ? 'marked' : ''} ${inRange ? 'picked' : ''}`}
                      tabIndex={pickable ? 0 : undefined}
                      onClick={(e) => pickable && pick(e.shiftKey)}
                      onKeyDown={(e) => {
                        if (pickable && e.key === 'Enter') {
                          e.preventDefault();
                          pick(e.shiftKey);
                        }
                      }}
                    >
                      <span className="ln">{here ? <span className={`mark sev-${here[0].severity}`} aria-label={`${here.length} finding${here.length > 1 ? 's' : ''}`} /> : null}{l.n ?? ''}</span>
                      <span className="code">{l.text || ' '}</span>
                    </div>
                    {here?.map((x) => {
                      const why = (x.note && x.state !== 'open' ? x.note : x.body.split('\n---\n')[0]).split('\n')[0].trim();
                      return (
                        <div key={x.id} className={`finding-inline sev-${x.severity} ${x.state}`}>
                          <span className="fi-head">
                            <span className={`sev-chip sev-${x.severity}`}>{x.severity}</span>
                            <span className="grow">{x.title}</span>
                            {x.state !== 'open' && <span className="hint">{STATE_WORD[x.state] ?? x.state}</span>}
                          </span>
                          {why && <span className="fi-body">{why.length > 200 ? `${why.slice(0, 199)}…` : why}</span>}
                        </div>
                      );
                    })}
                    {isOpen && (
                      <form
                        className="comment-box"
                        data-confirm
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (anchorFileable) void submit(f.path, anchor!.n!, !!onSendLine);
                        }}
                      >
                        {open.j !== undefined && <p className="hint range-hint">{(() => { const p = pickedLines(f.lines, f.path, open.i, open.j); return `${p.removed ? 'Removed lines' : 'Lines'} ${p.start}–${p.end}`; })()}</p>}
                        <textarea
                          autoFocus
                          value={draft}
                          disabled={busy !== null}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder={anchorFileable ? `Comment on ${f.path}:${anchor!.n}… Send directly to ${sessionName || 'the session'}, queue as a finding, or ask the reviewer.` : 'What do you want to know about these lines?'}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setOpen(null);
                            }
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              if (anchorFileable) void submit(f.path, anchor!.n!, !!onSendLine);
                              else ask(f.lines, f.path);
                            }
                          }}
                        />
                        <div className="row-actions">
                          {anchorFileable && <SeveritySeg value={sev} onChange={setSev} />}
                          <span className="spacer" />
                          <button type="button" className="btn ghost small" disabled={busy !== null} onClick={() => setOpen(null)}>
                            Cancel
                          </button>
                          {onAsk && (
                            <button type="button" className={`btn small ${anchorFileable ? '' : 'primary'}`} disabled={busy !== null} onClick={() => ask(f.lines, f.path)} title="Bring these lines to the reviewer, with what you wrote">
                              <Icon name="chat" size={14} /> Ask reviewer
                            </button>
                          )}
                          {anchorFileable && (
                            <button type="button" className="btn small" disabled={busy !== null || !draft.trim()} onClick={() => void submit(f.path, anchor!.n!, false)} title="Queue this comment so you can send several together">
                              {busy === 'save' ? 'Saving…' : 'Queue comment'}
                            </button>
                          )}
                          {anchorFileable && onSendLine && (
                            <button type="submit" className="btn primary small" disabled={busy !== null || !draft.trim()} title={`Send this comment straight to ${sessionName || 'the session'} to fix`}>
                              <Icon name="send" size={13} /> {busy === 'send' ? 'Sending…' : `Send to ${sessionName || 'session'}`}
                            </button>
                          )}
                          {anchorFileable && !onSendLine && (
                            <button type="submit" className="btn primary small" disabled={busy !== null || !draft.trim()}>
                              {busy === 'save' ? 'Saving…' : 'Add finding'}
                            </button>
                          )}
                        </div>
                      </form>
                    )}
                  </div>
                );
              })
            )}
          </section>
        );
      })}
      {touch && open && !open.writing && (() => {
        const f = files.find((x) => x.path === open.file);
        if (!f) return null;
        const p = pickedLines(f.lines, f.path, open.i, open.j);
        const anchor = f.lines[open.i];
        const fileable = !!onFile && anchor.kind !== 'del' && anchor.n !== null;
        return (
          <div className="pick-bar-touch" role="toolbar" aria-label={`Lines ${p.start} to ${p.end} of ${p.path}`}>
            <div className="ptb-head">
              <span className="ptb-what">
                <span className="ptb-title">{p.removed ? 'Removed lines' : 'Lines'} {p.start === p.end ? p.start : `${p.start}–${p.end}`}</span>
                <span className="hint">{p.path.split('/').pop()} · tap another line to stretch</span>
              </span>
              <button type="button" className="icon-btn round" aria-label="Clear the selection" onClick={() => setOpen(null)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="ptb-actions">
              {onAsk && (
                <button type="button" className="btn primary" onClick={() => ask(f.lines, f.path)}>
                  <Icon name="sparkle" size={15} /> Ask reviewer
                </button>
              )}
              {fileable && (
                <button type="button" className="btn" onClick={() => setOpen({ ...open, j: undefined, writing: true })}>
                  <Icon name="send" size={15} /> Comment / Send
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
