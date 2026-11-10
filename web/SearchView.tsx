import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostApi, SearchHit, SearchResponse } from './api.ts';
import { AgentLogo } from './logos.tsx';
import { Highlighted } from './Switcher.tsx';
import { errorText } from './errors.ts';
import { dayYear } from './dates.ts';

// Full-page content search (issue #9): the thorough path behind Cmd-K's
// "See all results". One call to the hub's /api/search/all fans out to every
// host; results are grouped per session by the server, paginated here, and
// can be narrowed by scope, role, and date.
export function SearchView({
  initialQuery,
  client,
  onOpenHit,
}: {
  initialQuery: string;
  client: HostApi;
  onOpenHit: (host: string, hit: SearchHit, target?: number) => void;
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

  const hits = [...(resp?.results ?? []), ...extra];
  const loaded = (resp?.results.length ?? 0) + extra.length;

  return (
    <div className="page search-page" data-title="Search">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">Search<span className="period">.</span></h1>
          <p className="tagline">Every conversation and side chat, on every host. A result opens at its turn.</p>
        </div>
      </header>

      {/* Every control is a labelled field, styled as every other field in ah. */}
      <div className="search-controls">
        <label className="field search-q">
          <span>Search</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Words to find"
            aria-label="Search conversations"
            enterKeyHint="search"
            // Results are live; the keyboard's Search key puts the on-screen keyboard away to show them.
            onKeyDown={(e) => e.key === 'Enter' && document.documentElement.dataset.keyboard !== undefined && e.currentTarget.blur()}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
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

      {error && <p className="panel-msg">{error}</p>}
      {resp && !resp.enabled && <p className="panel-msg">Content search is off. Turn it on in Settings → Search.</p>}
      {resp?.building && <p className="panel-msg">Indexing conversations; results may still be partial…</p>}
      {resp?.notes.map((n) => (
        <p key={n.host} className="panel-msg">
          {n.host}: {n.error}; its results are missing.
        </p>
      ))}

      <div className="search-results">
        {resp && queryText.length >= 2 && hits.length === 0 && !busy && <p className="panel-msg">No matches.</p>}
        {hits.map((hit) => (
          <article key={`${hit.host}:${hit.kind}:${hit.ref ?? hit.uid}`} className="search-hit">
            <button className="search-hit-head" onClick={() => onOpenHit(hit.host, hit)}>
              <span className="chip">
                <AgentLogo id={hit.harness} />
              </span>
              <span className="stack">
                <span className="name">{hit.title}</span>
                <span className="sub">
                  {[hit.host, hit.kind === 'chat' ? 'side chat' : hit.harness, dayYear(hit.at), `${hit.matches} match${hit.matches === 1 ? '' : 'es'}`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {hit.cwd && <span className="sub">{hit.cwd}</span>}
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
    </div>
  );
}
