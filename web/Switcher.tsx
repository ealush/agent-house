import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryItem, Win } from './api.ts';
import { look } from './agents.ts';
import { age as ago } from './agents.ts';

type Props = {
  windows: Win[];
  history: HistoryItem[];
  onPick: (key: string) => void;
  onResume: (host: string, ref: string) => void;
  onClose: () => void;
};

// Subsequence match, scoring contiguous runs and word starts higher.
export function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let s = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 1;
    s += run + (found === 0 || /[\s/·:_-]/.test(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return s;
}

type Filters = { h?: string; s?: string; p?: string; m?: string };

/** `h:claude s:waiting p:vest m:opus free text` → filters + fuzzy text (F27). */
export function parseQuery(q: string): { text: string; f: Filters } {
  const f: Filters = {};
  const text = q
    .split(/\s+/)
    .filter((tok) => {
      const m = tok.match(/^([hspm]):(.+)$/);
      if (m) f[m[1] as keyof Filters] = m[2].toLowerCase();
      return !m;
    })
    .join(' ');
  return { text, f };
}

const has = (v: string | null | undefined, want?: string) => !want || (v ?? '').toLowerCase().includes(want);

type Row = { kind: 'win'; w: Win; s: number } | { kind: 'hist'; h: HistoryItem; s: number };

export function Switcher({ windows, history, onPick, onResume, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);

  useEffect(() => ref.current?.showModal(), []);

  const results = useMemo(() => {
    const { text, f } = parseQuery(q);
    const live: Row[] = windows
      .filter((w) => (has(w.agent ?? w.command, f.h) || has(w.host, f.h)) && has(w.status, f.s) && has(w.project, f.p) && has(w.model, f.m))
      .map((w) => ({ kind: 'win' as const, w, s: score(text, `${w.title} ${w.name} ${w.project} ${w.agent ?? w.command} ${w.session} ${w.branch ?? ''}`) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || b.w.activity - a.w.activity);
    // History only joins once you type: the empty switcher is for jumping between live sessions.
    const past: Row[] =
      text || f.h || f.p || f.m
        ? history
            .filter((h) => (has(h.harness, f.h) || has(h.host, f.h)) && has(h.project, f.p) && has(h.model, f.m) && (!f.s || 'ended saved'.includes(f.s)))
            .map((h) => ({ kind: 'hist' as const, h, s: score(text, `${h.title} ${h.project} ${h.harness}`) }))
            .filter((r) => r.s > 0)
            .sort((a, b) => b.s - a.s || b.h.at - a.h.at)
        : [];
    return [...live, ...past].slice(0, 14);
  }, [windows, history, q]);

  const choose = (r: Row) => (r.kind === 'win' ? onPick(r.w.key) : onResume(r.h.host, r.h.ref));

  return (
    <dialog ref={ref} className="dialog switcher" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <input
        autoFocus
        value={q}
        placeholder="Jump or resume…  h:claude s:waiting p:vest m:opus"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setI((i) => Math.min(results.length - 1, i + 1));
          else if (e.key === 'ArrowUp') setI((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter' && results[i]) choose(results[i]);
          else return;
          e.preventDefault();
        }}
      />
      <ul>
        {results.map((r, idx) => {
          const agent = r.kind === 'win' ? r.w.agent : r.h.harness;
          const { color, glyph } = look(agent);
          return (
            <li key={r.kind === 'win' ? r.w.key : `${r.h.host}:${r.h.ref}`}>
              <button className={`switch-item ${idx === i ? 'on' : ''}`} style={{ '--agent': color } as React.CSSProperties} onMouseEnter={() => setI(idx)} onClick={() => choose(r)}>
                <span className="chip">{glyph}</span>
                <span className="stack">
                  <span className="name">{r.kind === 'win' ? r.w.title : r.h.title}</span>
                  <span className="sub">{r.kind === 'win' ? [r.w.host, r.w.project, r.w.detail].filter(Boolean).join(' · ') : `${r.h.host} · ${r.h.project} · ${ago(r.h.at)}`}</span>
                </span>
                {r.kind === 'win' ? <span className={`dot ${r.w.status}`} /> : <span className="pill">resume</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
