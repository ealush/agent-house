import { useEffect, useState } from 'react';
import { api, type SpacesList } from './api.ts';
import { age } from './agents.ts';
import { errorText } from './errors.ts';
import { KIND_LABEL } from './spaces.ts';

// Settings → Spaces (docs/spec/17-spaces.md, SPC-6): where plain Spaces live on this host,
// and the Spaces taken off the list, each to put back.
export function SpacesPanel() {
  const [list, setList] = useState<SpacesList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    api
      .spaces()
      .then(setList)
      .catch((e) => setError(errorText(e)));
  useEffect(() => void load(), []);

  async function restore(name: string) {
    setBusy(name);
    setError(null);
    try {
      await api.restoreSpace(name);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const plain = list?.spaces.filter((s) => s.kind === 'space') ?? [];
  return (
    <div className="env-panels">
      <div className="sec-card">
        <h2>Spaces</h2>
        <p className="hint">
          A Space is where sessions belong: a repository, a folder, or a plain Space with no repository, whose agents share its preferences and memory. Plain Spaces are folders in{' '}
          <code>{list?.root ?? '~/spaces'}</code> (<code>spaces.root</code> in the host's config). Make one from the Inbox's title menu.
        </p>
        {error && <p className="form-error">{error}</p>}
        {!list && !error && <p className="hint">Loading…</p>}
        {list && (plain.length ? (
          <ul className="worktrees">
            {plain.map((s) => (
              <li key={s.name}>
                <div className="stack">
                  <span>{s.name}</span>
                  <span className="sub">
                    {s.conversations === 1 ? '1 conversation' : `${s.conversations} conversations`}
                    {s.live ? ` · ${s.live} running` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No plain Spaces yet.</p>
        ))}
      </div>
      <div className="sec-card">
        <h2>Removed</h2>
        <p className="hint">Spaces taken off the Inbox. Their conversations are only hidden, and a plain Space's folder waits in the archive: Restore puts both back.</p>
        {list && !list.removed.length && <p className="hint">Nothing removed.</p>}
        {list && list.removed.length > 0 && (
          <ul className="worktrees">
            {list.removed.map((r) => (
              <li key={r.name}>
                <div className="stack">
                  <span>{r.name}</span>
                  <span className="sub">
                    {KIND_LABEL[r.kind]} · {r.conversations === 1 ? '1 conversation' : `${r.conversations} conversations`} · removed {age(r.removedAt)}
                    {r.path ? (
                      <>
                        {' · '}
                        <span className="mono">{r.path}</span>
                      </>
                    ) : null}
                  </span>
                </div>
                <button className="btn small" disabled={busy === r.name} onClick={() => void restore(r.name)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
