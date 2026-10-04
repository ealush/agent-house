import { useEffect, useMemo, useRef, useState } from 'react';
import type { Win } from './api.ts';
import { look } from './agents.ts';

type Props = { windows: Win[]; onPick: (id: string) => void; onClose: () => void };

// Subsequence match, scoring contiguous runs and word starts higher.
function score(query: string, text: string): number {
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

export function Switcher({ windows, onPick, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);

  useEffect(() => ref.current?.showModal(), []);

  const results = useMemo(
    () =>
      windows
        .map((w) => ({ w, s: score(q, `${w.name} ${w.project} ${w.agent ?? w.command} ${w.session}`) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s || b.w.activity - a.w.activity)
        .slice(0, 12),
    [windows, q],
  );

  return (
    <dialog ref={ref} className="dialog switcher" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <input
        autoFocus
        value={q}
        placeholder="Jump to session…"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setI((i) => Math.min(results.length - 1, i + 1));
          else if (e.key === 'ArrowUp') setI((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter' && results[i]) onPick(results[i].w.id);
          else return;
          e.preventDefault();
        }}
      />
      <ul>
        {results.map(({ w }, idx) => {
          const { color, glyph } = look(w.agent);
          return (
            <li key={w.id}>
              <button className={`item ${idx === i ? 'selected' : ''} ${w.status}`} style={{ '--agent': color } as React.CSSProperties} onMouseEnter={() => setI(idx)} onClick={() => onPick(w.id)}>
                <span className="chip">{glyph}</span>
                <span className="item-main">
                  <span className="item-name">{w.name}</span>
                  <span className="item-sub">
                    {w.project} · {w.session}
                  </span>
                </span>
                <span className={`status ${w.status}`} />
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
