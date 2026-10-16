import { useMemo, useState } from 'react';
import { parsePatch } from '../Git.tsx';
import type { Finding } from '../reviewApi.ts';

export type Severity = 'blocking' | 'should' | 'nit';

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
 * line (or Enter on it) to file a finding there; the first line you write is
 * its title. Large files start folded.
 */
export function ReviewDiff({ patch, findings, onFile }: { patch: string; findings: Finding[]; onFile?: (f: { path: string; line: number; title: string; body: string; severity: Severity }) => Promise<void> }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const [open, setOpen] = useState<{ file: string; i: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [sev, setSev] = useState<Severity>('should');
  const [busy, setBusy] = useState(false);
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

  async function submit(path: string, line: number) {
    const { title, body } = splitNote(draft);
    if (!title || !onFile) return;
    setBusy(true);
    try {
      await onFile({ path, line, title, body, severity: sev });
      setOpen(null);
      setDraft('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="diff review-diff" data-rove=".dl.pickable">
      {files.map((f) => {
        const big = f.lines.length > 400;
        const shut = folded.has(f.path) || (big && !unfolded.has(f.path));
        const toggle = () => {
          if (big) setUnfolded((s) => (s.has(f.path) ? new Set([...s].filter((x) => x !== f.path)) : new Set([...s, f.path])));
          else setFolded((s) => (s.has(f.path) ? new Set([...s].filter((x) => x !== f.path)) : new Set([...s, f.path])));
        };
        return (
          <section key={f.path} className="diff-block">
            <button type="button" className="diff-file" onClick={toggle} aria-expanded={!shut}>
              <span className="grow">{f.path}</span>
              <span className="add-n">+{f.add}</span>
              <span className="del-n">−{f.del}</span>
            </button>
            {shut ? (
              <button type="button" className="diff-fold" onClick={toggle}>
                Show {f.lines.length} lines
              </button>
            ) : (
              f.lines.map((l, i) => {
                const here = l.kind !== 'hunk' && l.kind !== 'del' && l.n !== null ? marks.get(`${f.path}:${l.n}`) : undefined;
                const pickable = !!onFile && l.kind !== 'hunk' && l.kind !== 'del' && l.n !== null;
                const isOpen = open?.file === f.path && open.i === i;
                return (
                  <div key={i}>
                    <div
                      className={`dl ${l.kind} ${pickable ? 'pickable' : ''} ${here ? 'marked' : ''}`}
                      tabIndex={pickable ? 0 : undefined}
                      onClick={() => pickable && setOpen(isOpen ? null : { file: f.path, i })}
                      onKeyDown={(e) => {
                        if (pickable && e.key === 'Enter') {
                          e.preventDefault();
                          setOpen(isOpen ? null : { file: f.path, i });
                        }
                      }}
                    >
                      <span className="ln">{here ? <span className={`mark sev-${here[0].severity}`} aria-label={`${here.length} finding${here.length > 1 ? 's' : ''}`} /> : null}{l.n ?? ''}</span>
                      <span className="code">{l.text || ' '}</span>
                    </div>
                    {here?.map((x) => (
                      <div key={x.id} className={`finding-inline sev-${x.severity} ${x.state}`}>
                        <span className="dot" />
                        <span className="grow">{x.title}</span>
                        <span className="hint">{x.state === 'open' ? x.severity : x.state}</span>
                      </div>
                    ))}
                    {isOpen && (
                      <form
                        className="comment-box"
                        data-confirm
                        onSubmit={(e) => {
                          e.preventDefault();
                          void submit(f.path, l.n!);
                        }}
                      >
                        <textarea
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder={`What should change at ${f.path}:${l.n}? The first line is the title.`}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setOpen(null);
                            }
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              void submit(f.path, l.n!);
                            }
                          }}
                        />
                        <div className="row-actions">
                          <SeveritySeg value={sev} onChange={setSev} />
                          <span className="spacer" />
                          <button type="button" className="btn ghost small" onClick={() => setOpen(null)}>
                            Cancel
                          </button>
                          <button type="submit" className="btn primary small" disabled={busy || !draft.trim()}>
                            Add finding
                          </button>
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
    </div>
  );
}
