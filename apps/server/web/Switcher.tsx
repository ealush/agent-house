import { useEffect, useMemo, useRef, useState } from 'react';
import { plainSnippet } from './snippet.ts';
import type { HistoryItem, SearchHit, SearchQuery, SearchResponse, Win } from './api.ts';
import { Keycaps, MOD } from './shortcuts.tsx';
import { look } from './agents.ts';
import { day } from './dates.ts';
import { age as ago } from './agents.ts';
import { AgentLogo } from './logos.tsx';
import { historyLine, sessionLine } from './sessionLine.tsx';
import { useSavedGroups } from './groupOrder.ts';
import { sidebarOrder } from './sessionOrder.ts';
import { SheetBar, useSheet } from './sheet.tsx';

type Props = {
  windows: Win[];
  history: HistoryItem[];
  /** Host names to run content search against (each answers for itself). */
  hosts: string[];
  onSearchContent: (host: string, q: SearchQuery) => Promise<SearchResponse>;
  onPick: (key: string) => void;
  onResume: (host: string, ref: string) => void;
  /** Open a content hit: a transcript at its seq, or a chat at its message. */
  onContent: (host: string, hit: SearchHit) => void;
  /** Open a live session as a new pane beside the focused one (⌘↵ / Ctrl+↵). Absent when splitting is unavailable. */
  onSplit?: (key: string) => void;
  /** Opened to pick a new pane (Open as a new pane, Pane mode o): plain Enter tiles too. */
  tile?: boolean;
  /** Open the full search page with the current query. */
  onShowAll: (q: string) => void;
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

export type Filters = { h?: string; s?: string; p?: string; m?: string; in?: string; role?: string };

/** `h:claude s:waiting p:vest m:opus in:chats role:user free text` → filters + fuzzy text (F27, issue #9). */
export function parseQuery(q: string): { text: string; f: Filters } {
  const f: Filters = {};
  const text = q
    .split(/\s+/)
    .filter((tok) => {
      const m = tok.match(/^(h|s|p|m|in|role):(.+)$/);
      if (m) f[m[1] as keyof Filters] = m[2].toLowerCase();
      return !m;
    })
    .join(' ');
  return { text, f };
}

const has = (v: string | null | undefined, want?: string) => !want || (v ?? '').toLowerCase().includes(want);

type Row = { kind: 'win'; w: Win; s: number } | { kind: 'hist'; h: HistoryItem; s: number };

/** Renders a server snippet as plain prose, turning its highlight markers into <mark>. */
export function Highlighted({ snippet }: { snippet: string }) {
  snippet = plainSnippet(snippet);
  const out: React.ReactNode[] = [];
  let marked = false;
  let buf = '';
  let n = 0;
  const flush = () => {
    if (!buf) return;
    out.push(marked ? <mark key={n++}>{buf}</mark> : <span key={n++}>{buf}</span>);
    buf = '';
  };
  for (const ch of snippet) {
    if (ch === '\u0001') {
      flush();
      marked = true;
    } else if (ch === '\u0002') {
      flush();
      marked = false;
    } else buf += ch;
  }
  flush();
  return <>{out}</>;
}

const hitDate = (at: number) => (at ? day(at) : '');

export function Switcher({ windows, history, hosts, onSearchContent, onPick, onResume, onContent, onShowAll, onSplit, onClose, tile = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(ref, onClose);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [content, setContent] = useState<SearchHit[]>([]);
  const [contentNote, setContentNote] = useState<string | null>(null);
  const runId = useRef(0);

  useEffect(() => ref.current?.showModal(), []);

  const savedGroups = useSavedGroups(hosts.length > 1);
  const results = useMemo(() => {
    const { text, f } = parseQuery(q);
    const rank = new Map(sidebarOrder(windows, hosts.length > 1, savedGroups).map((w, i) => [w.key, i]));
    const live: Row[] = windows
      .filter((w) => (has(w.agent ?? w.command, f.h) || has(w.host, f.h)) && has(w.status, f.s) && has(w.project, f.p) && has(w.model, f.m))
      .map((w) => ({ kind: 'win' as const, w, s: score(text, `${w.title} ${w.name} ${w.project} ${w.agent ?? w.command} ${w.session} ${w.branch ?? ''}`) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || (rank.get(a.w.key) ?? 0) - (rank.get(b.w.key) ?? 0));
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
  }, [windows, history, hosts, q, savedGroups]);

  // Content search (issue #9): debounced, one query per host, merged below
  // the metadata results under their own heading.
  useEffect(() => {
    const { text, f } = parseQuery(q);
    const id = ++runId.current;
    if (text.trim().length < 2) {
      setContent([]);
      setContentNote(null);
      return;
    }
    const timer = setTimeout(async () => {
      const query: SearchQuery = {
        q: text,
        ...(f.in === 'transcripts' || f.in === 'chats' ? { scope: f.in } : {}),
        ...(f.role ? { role: f.role } : {}),
        ...(f.p ? { project: f.p } : {}),
        ...(f.h ? { host: f.h } : {}),
        ...(f.m ? { model: f.m } : {}),
        limit: 8,
      };
      const settled = await Promise.allSettled(hosts.map((h) => onSearchContent(h, query)));
      if (runId.current !== id) return;
      const hits: SearchHit[] = [];
      let anyEnabled = false;
      let building = false;
      for (const [index, s] of settled.entries()) {
        if (s.status !== 'fulfilled') continue;
        anyEnabled ||= s.value.enabled;
        building ||= s.value.building;
        hits.push(...s.value.results.map((hit) => ({ ...hit, host: hosts[index] })));
      }
      setContent(hits.slice(0, 8));
      setContentNote(!anyEnabled ? 'Content search is off (Settings → Search).' : building && !hits.length ? 'Indexing conversations…' : null);
    }, 250);
    return () => { clearTimeout(timer); runId.current++; };
  }, [q, hosts, onSearchContent]);

  const choose = (r: Row) => (r.kind === 'win' ? onPick(r.w.key) : onResume(r.h.host, r.h.ref));
  const navCount = results.length + content.length;
  const liveRows = results.filter((r) => r.kind === 'win');
  const histRows = results.filter((r) => r.kind === 'hist');
  const chooseNav = (n: number, split = false) => {
    const r = n < results.length ? results[n] : undefined;
    if (r?.kind === 'win' && split && onSplit) {
      onSplit(r.w.key);
      return;
    }
    if (r) choose(r);
    else if (content[n - results.length]) onContent(content[n - results.length].host, content[n - results.length]);
  };

  return (
    <dialog ref={ref} className="dialog switcher" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <input
        autoFocus
        value={q}
        // The filter syntax is a keyboard hint; a phone's narrow field shows just the purpose.
        placeholder={tile ? 'Open as a new pane…' : matchMedia('(hover: none)').matches ? 'Jump, resume or search…' : 'Jump, resume, or search conversations  ·  h:claude p:space in:chats'}
        enterKeyHint="go"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setI((i) => Math.max(0, Math.min(navCount - 1, i + 1)));
          else if (e.key === 'ArrowUp') setI((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter' && navCount > 0) chooseNav(Math.min(i, navCount - 1), tile || e.metaKey || e.ctrlKey);
          else return;
          e.preventDefault();
        }}
      />
      {navCount === 0 && <p className="switch-empty">Nothing matches. Try h:claude or p:ah.</p>}
      {liveRows.length > 0 && (
        <>
          {histRows.length > 0 && <div className="switch-head">Sessions</div>}
          <ul>
            {liveRows.map((r, j) => {
              if (r.kind !== 'win') return null;
              const { color } = look(r.w.agent);
              return (
                <li key={r.w.key}>
                  <button className={`switch-item ${j === i ? 'on' : ''}`} style={{ '--agent': color } as React.CSSProperties} onMouseEnter={() => setI(j)} onClick={() => choose(r)}>
                    <span className="chip">
                      <AgentLogo id={r.w.agent} />
                    </span>
                    <span className="stack">
                      <span className="name">
                        {r.w.title}
                        {r.w.fork ? ' ⑂' : ''}
                      </span>
                      <span className="sub">{sessionLine(r.w, { project: true, host: hosts.length > 1 })}</span>
                    </span>
                    <span className={`dot ${r.w.status}`} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {histRows.length > 0 && (
        <>
          <div className="switch-head">History</div>
          <ul>
            {histRows.map((r, j) => {
              if (r.kind !== 'hist') return null;
              const idx = liveRows.length + j;
              const { color } = look(r.h.harness);
              return (
                <li key={`${r.h.host}:${r.h.ref}`}>
                  <button className={`switch-item ${idx === i ? 'on' : ''}`} style={{ '--agent': color } as React.CSSProperties} onMouseEnter={() => setI(idx)} onClick={() => choose(r)}>
                    <span className="chip">
                      <AgentLogo id={r.h.harness} />
                    </span>
                    <span className="stack">
                      <span className="name">
                        {r.h.title}
                        {r.h.fork ? ' ⑂' : ''}
                      </span>
                      <span className="sub">
                        {historyLine(r.h, { project: true, host: hosts.length > 1 })} · {ago(r.h.at)}
                      </span>
                    </span>
                    <span className="pill">Resume</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(content.length > 0 || contentNote) && (
        <>
          <div className="switch-head">In conversations</div>
          {contentNote && <p className="switch-note">{contentNote}</p>}
          <ul>
            {content.map((hit, j) => {
              const idx = results.length + j;
              const first = hit.excerpts[0];
              return (
                <li key={`${hit.host}:${hit.kind}:${hit.ref ?? hit.uid}`}>
                  <button className={`switch-item ${idx === i ? 'on' : ''}`} onMouseEnter={() => setI(idx)} onClick={() => onContent(hit.host, hit)}>
                    <span className="chip">
                      <AgentLogo id={hit.harness} />
                    </span>
                    <span className="stack">
                      <span className="name">{hit.title}</span>
                      <span className="sub">
                        {[hosts.length > 1 ? hit.host : null, hit.kind === 'chat' ? 'side chat' : hit.harness, hitDate(hit.at), `${hit.matches} match${hit.matches === 1 ? '' : 'es'}`].filter(Boolean).join(' · ')}
                      </span>
                      {first && (
                        <span className="excerpt">
                          <Highlighted snippet={first.snippet} />
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {parseQuery(q).text.trim().length >= 2 && (
        <button className="switch-all" onClick={() => onShowAll(parseQuery(q).text.trim())}>
          See all results for “{parseQuery(q).text.trim()}” →
        </button>
      )}
      <div className="switch-foot" aria-hidden>
        <span>
          <Keycaps keys={['↑', '↓']} /> move
        </span>
        <span>
          <Keycaps keys={['↵']} /> {tile ? 'open as a new pane' : `open${onSplit ? ' or resume' : ''}`}
        </span>
        {onSplit && !tile && (
          <span>
            <Keycaps keys={[MOD(), '↵']} /> open as a new pane
          </span>
        )}
        <span>
          <Keycaps keys={['Esc']} /> close
        </span>
      </div>
    </dialog>
  );
}
