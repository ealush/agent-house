import { useEffect, useState } from 'react';
import { api, type SearchStatus } from './api.ts';
import { askConfirm, showError } from './ask.tsx';

// Content search controls (issue #9): what is indexed, and the off switch
// that deletes the index. The index lives on this host only; the text in it
// already lives on this host in the transcripts and chat store.
export function SearchSettingsPanel() {
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.searchStatus().then(setStatus).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggle(on: boolean) {
    if (!on && !(await askConfirm({ title: 'Turn off content search?', body: 'The search index on this host is deleted, not just hidden. Transcripts and chats themselves are untouched.', confirm: 'Turn off and delete index', danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.searchSetEnabled(on));
    } catch (e) {
      showError(e, "Couldn't change content search");
    } finally {
      setBusy(false);
    }
  }

  async function rebuild() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.searchRebuild());
    } catch (e) {
      showError(e, "Couldn't start a rebuild");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sec-card">
      <h2>Search</h2>
      <p className="hint">
        Content search indexes this host's agent transcripts and side chats so Cmd-K and the search page can find what was said, not just session titles. The index
        stays on this host, in the same database file as the chats themselves, and is only served to your signed-in devices.
      </p>
      {error && <p className="panel-msg">{error}</p>}
      {!status && !error && <p className="panel-msg">Loading…</p>}
      {status && (
        <>
          <label className="search-toggle">
            <input type="checkbox" switch="" checked={status.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
            <span>Content search on this host</span>
          </label>
          {status.enabled ? (
            <>
              <p className="hint">
                {status.building
                  ? `Indexing… ${status.sourcesIndexed} of ${status.sourcesKnown} sources so far, ${status.entries} entries.`
                  : `${status.entries} entries indexed (${status.transcriptEntries} from transcripts, ${status.chatEntries} from chats) across ${status.sourcesIndexed} sources.`}
                {status.lastBuiltAt ? ` Last pass ${new Date(status.lastBuiltAt).toLocaleTimeString()}.` : ''}
              </p>
              <button className="btn" disabled={busy} onClick={() => void rebuild()}>
                Rebuild index
              </button>
            </>
          ) : (
            <p className="hint">The index is deleted. Turning search back on rebuilds it from the transcripts and chats on this host.</p>
          )}
        </>
      )}
    </div>
  );
}
