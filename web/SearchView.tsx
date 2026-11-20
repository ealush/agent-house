import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryItem, HostApi, SearchHit, SearchResponse, State, Win } from './api.ts';
import { AgentLogo } from './logos.tsx';
import { Highlighted } from './Switcher.tsx';
import { errorText } from './errors.ts';
import { dayYear } from './dates.ts';
import { look } from './agents.ts';
import { Rows } from './Inbox.tsx';
import { HistoryRows } from './HistoryRows.tsx';

/** Every word typed is somewhere in the row: its title, project, agent, model, host or folder. */
const matches = (words: string[], fields: (string | null | undefined)[]) => {
  const hay = fields.join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
};

// Search is where every session and conversation is, the ended ones too: History
// lives here. With nothing typed it lists them all, live sessions first; typing
// filters both lists at once, here in the page. From two letters on, it also
// searches what was said (issue #9), the thorough path behind Cmd-K's "See all
// results": one call to the hub's /api/search/all fans out to every host;
// results are grouped per session by the server, paginated here, and can be
// narrowed by scope, role, and date.
export function SearchView({
  initialQuery,
  client,
  onOpenHit,
  state,
  narrow,
  touch,
  onOpen,
  onResume,
  onForget,
  onFork,
  onMove,
}: {
  initialQuery: string;
  client: HostApi;
  onOpenHit: (host: string, hit: SearchHit, target?: number) => void;
  state: State;
  narrow: boolean;
  touch: boolean;
  onOpen: (w: Win) => void;
  onResume: (h: HistoryItem) => void;
  onForget: (h: HistoryItem) => void;
  onFork?: (h: HistoryItem) => void;
  onMove?: (h: HistoryItem) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [scope, setScope] = useState<'all' | 'transcripts' | 'chats'>('all');
  const [role, setRole] = useState<'' | 'user' | 'agent'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [resp, setResp] = useState<SearchResponse | null>(null);
  const [extra, setExtra] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runId = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  // A phone's four filters would push the first result off the screen: they wait behind a button.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersOn = [scope !== 'all', !!role, !!from, !!to].filter(Boolean).length;

  // "/" finds, as in most lists a power user knows (GitHub, Gmail), unless you are typing.
  useEffect(() => {
    const slash = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], .xterm, dialog')) return;
      e.preventDefault();
      field.current?.focus();
    };
    window.addEventListener('keydown', slash);
    return () => window.removeEventListener('keydown', slash);
  }, []);

  const queryText = q.trim();
  const run = useCallback(
    async (offset: number) => {
      const id = ++runId.current;
      if (queryText.length < 2) {
        setBusy(false);
        setResp(null);
        setExtra([]);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const out = await client.search(
          { q: queryText, ...(scope !== 'all' ? { scope } : {}), ...(role ? { role } : {}), limit: 20, offset, ...(from ? { from: Date.parse(`${from}T00:00:00Z`) } : {}), ...(to ? { to: Date.parse(`${to}T23:59:59.999Z`) } : {}) },
          true,
        );
        if (runId.current !== id) return;
        if (offset === 0) {
          setResp(out);
          setExtra([]);
        } else {
          setExtra((prev) => [...prev, ...out.results]);
        }
      } catch (e) {
        if (runId.current === id) setError(errorText(e));
      } finally {
        if (runId.current === id) setBusy(false);
      }
    },
    [client, queryText, scope, role, from, to],
  );

  useEffect(() => {
    const t = setTimeout(() => void run(0), 300);
    return () => { clearTimeout(t); runId.current++; };
  }, [run]);

  const multiHost = state.hosts.length > 1;
  const words = queryText.toLowerCase().split(/\s+/).filter(Boolean);
  const live = state.windows
    .filter((w) => !words.length || matches(words, [w.title, w.project, w.agent, look(w.agent).name, w.model, w.host, w.cwd]))
    .sort((a, b) => b.activity - a.activity);
  const past = words.length ? state.history.filter((h) => matches(words, [h.title, h.project, h.harness, h.model, h.host, h.cwd])) : state.history;
  const content = queryText.length >= 2;
  const hits = content ? [...(resp?.results ?? []), ...extra] : [];
  const loaded = (resp?.results.length ?? 0) + extra.length;
  const nothingYet = !state.windows.length && !state.history.length;
  // Nothing in either list, and nothing said either (or too short a query to look).
  const noMatches = !!words.length && !live.length && !past.length && (!content || (!!resp && !busy && !hits.length));

  return (
    <div className="page search-page" data-title="Search" data-rove="button.row, button.resume, button.search-hit-head">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">Search<span className="period">.</span></h1>
          <p className="tagline">Every session and past conversation, on every host. Type to narrow them, and to find what was said.</p>
        </div>
      </header>

      <label className="field search-q">
        <input
          ref={field}
          type="search"
          // A phone (or an iPad) comes here to look through the list: its keyboard would cover it.
          autoFocus={!narrow && !touch}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={nothingYet ? 'Words to find' : `Filter ${state.windows.length + state.history.length}, or find words said`}
          aria-label="Search sessions and conversations"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => {
            // The on-screen keyboard's Search key puts it away, to show what was found.
            if (e.key === 'Enter' && document.documentElement.dataset.keyboard !== undefined) return e.currentTarget.blur();
            // Down from the field lands on the first row; Enter opens it.
            const first = e.currentTarget.closest('.page')?.querySelector<HTMLElement>('.search-lists button.row, .search-lists button.resume, button.search-hit-head');
            if (first && (e.key === 'ArrowDown' || e.key === 'Enter')) {
              e.preventDefault();
              if (e.key === 'Enter') first.click();
              else first.focus();
            } else if (e.key === 'Escape') {
              // Clears first; an empty field lets go, back to the list.
              e.preventDefault();
              if (q) setQ('');
              else e.currentTarget.blur();
            }
          }}
        />
      </label>

      {nothingYet && (
        <div className="empty-state">
          <p className="empty-title">Nothing here yet.</p>
          <p className="hint">Your sessions are listed here, and when one ends its conversation stays here to be resumed.</p>
        </div>
      )}
      {noMatches && <p className="empty-state">No matches.</p>}

      <div className="search-lists">
        {live.length > 0 && (
          <section>
            <h2 className="section-label first">
              Sessions <span className="count">{live.length}</span>
            </h2>
            <Rows windows={live} multiHost={multiHost} narrow={narrow} onOpen={onOpen} />
          </section>
        )}
        {past.length > 0 && (
          <section>
            <h2 className={`section-label ${live.length ? '' : 'first'}`}>
              History <span className="count">{past.length}</span>
            </h2>
            <HistoryRows
              items={past}
              multiHost={multiHost}
              canMoveAnywhere={state.hosts.filter((x) => x.online).length > 1}
              onResume={onResume}
              onForget={onForget}
              onFork={onFork}
              onMove={onMove}
              touch={touch}
              narrow={narrow}
            />
          </section>
        )}
      </div>

      {/* With nothing found anywhere, "No matches" says it once; the content filters stay while one is on, to undo it. */}
      {content && (!noMatches || filtersOn > 0) && (
        <section className="search-content">
          <h2 className={`section-label ${live.length || past.length ? '' : 'first'}`}>
            In conversations {!!resp?.enabled && resp.total > 0 && <span className="count">{resp.total}</span>}
          </h2>
          {/* These narrow what was said, not the lists above: they sit with the results they filter. */}
          {narrow && (
            <button className="btn small search-filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
              {filtersOpen ? 'Hide filters' : `Filter what was said${filtersOn ? ` · ${filtersOn} on` : ''}`}
            </button>
          )}
          {(filtersOpen || !narrow) && (
            <div className="search-controls">
              <label className="field">
                <span>In</span>
                <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Scope">
                  <option value="all">Everything</option>
                  <option value="transcripts">Conversations only</option>
                  <option value="chats">Side chats only</option>
                </select>
              </label>
              <label className="field">
                <span>Who</span>
                <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="Role">
                  <option value="">Anyone</option>
                  <option value="user">You</option>
                  <option value="agent">The agent</option>
                </select>
              </label>
              <label className="field">
                <span>From</span>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field">
                <span>To</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
          )}

          {error && <p className="panel-msg">{error}</p>}
          {resp && !resp.enabled && <p className="panel-msg">Content search is off. Turn it on in Settings → Search.</p>}
          {resp?.building && <p className="panel-msg">Indexing conversations; results may still be partial…</p>}
          {resp?.notes.map((n) => (
            <p key={n.host} className="panel-msg">
              {n.host}: {n.error}; its results are missing.
            </p>
          ))}

          <div className="search-results">
            {resp?.enabled && hits.length === 0 && !busy && !noMatches && <p className="panel-msg">Nothing said matches.</p>}
            {hits.map((hit) => (
              <article key={`${hit.host}:${hit.kind}:${hit.ref ?? hit.uid}`} className="search-hit">
                <button className="search-hit-head" onClick={() => onOpenHit(hit.host, hit)}>
                  <span className="chip">
                    <AgentLogo id={hit.harness} />
                  </span>
                  <span className="stack">
                    <span className="name">{hit.title}</span>
                    <span className="sub">
                      {/* The count first: a narrow screen cuts the end of this line. */}
                      {[`${hit.matches} match${hit.matches === 1 ? '' : 'es'}`, hit.host, hit.kind === 'chat' ? 'side chat' : hit.harness, dayYear(hit.at)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {hit.cwd && <span className="sub path">{hit.cwd}</span>}
                  </span>
                </button>
                <div className="search-excerpts">
                  {hit.excerpts.map((ex, i) => (
                    <button key={i} className="search-excerpt" onClick={() => onOpenHit(hit.host, hit, ex.seq ?? ex.msgId ?? undefined)}>
                      <span className="search-excerpt-role">{ex.role === 'assistant' ? 'agent' : ex.role}</span>
                      <span>
                        <Highlighted snippet={ex.snippet} />
                      </span>
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>

          {resp && loaded < resp.total && (
            <button className="btn" disabled={busy} onClick={() => void run(loaded)}>
              {busy ? 'Loading…' : 'Load more'}
            </button>
          )}
          {busy && !resp && <p className="panel-msg">Searching…</p>}
        </section>
      )}
    </div>
  );
}
