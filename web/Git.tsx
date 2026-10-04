import { useEffect, useRef, useState } from 'react';
import { api, type Changes, type WorktreeInfo } from './api.ts';

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return ref;
}

// Read-only review of a session's working changes (F34): status, stat, patch.
export function ChangesDialog({ windowId, onClose }: { windowId: string; onClose: () => void }) {
  const ref = useModal();
  const [data, setData] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.changes(windowId).then(setData).catch((e) => setError(e.message));
  };
  useEffect(load, [windowId]);

  return (
    <dialog ref={ref} className="dialog capture" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="capture-head">
        <h2>Changes{data ? <span className="hint"> · {data.branch}</span> : null}</h2>
        <button className="btn ghost small" onClick={load}>
          Refresh
        </button>
        <button className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="changes">
        {error && <p className="form-error">{error}</p>}
        {!data && !error && <p className="hint">Loading…</p>}
        {data && data.files.length === 0 && <p className="hint">Working tree clean.</p>}
        {data && data.files.length > 0 && (
          <ul className="files">
            {data.files.map((f) => (
              <li key={f.path}>
                <code className={`code c-${f.code[0] === '?' ? 'new' : f.code[0]}`}>{f.code}</code> <a href={`#diff-${f.path}`}>{f.path}</a>
              </li>
            ))}
          </ul>
        )}
        {data?.patch && <Patch text={data.patch} />}
        {data?.truncated && <p className="hint">Patch truncated; open a shell for the rest.</p>}
      </div>
    </dialog>
  );
}

function Patch({ text }: { text: string }) {
  return (
    <pre className="patch">
      {text.split('\n').map((line, i) => {
        const file = line.startsWith('diff --git ') ? line.split(' b/')[1] : undefined;
        const cls = line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : file ? 'file' : '';
        return (
          <div key={i} id={file ? `diff-${file}` : undefined} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

// Managed worktrees (F30): who uses them, what's dirty, and cleanup of orphans.
export function WorktreesDialog({ onClose, onShell }: { onClose: () => void; onShell: (path: string) => void }) {
  const ref = useModal();
  const [list, setList] = useState<WorktreeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.worktrees().then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function remove(wt: WorktreeInfo) {
    const dirty = wt.dirty > 0;
    const msg = dirty
      ? `${wt.branch} has ${wt.dirty} uncommitted change${wt.dirty > 1 ? 's' : ''}. Delete them and remove the worktree?`
      : `Remove worktree ${wt.branch}? The branch itself is kept.`;
    if (!confirm(msg)) return;
    try {
      await api.removeWorktree(wt.path, dirty);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <dialog ref={ref} className="dialog wide" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="capture-head">
        <h2>Worktrees</h2>
        <button className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="changes">
        {error && <p className="form-error">{error}</p>}
        {list?.length === 0 && <p className="hint">No ah-managed worktrees. Tick “Isolated git worktree” when starting a session.</p>}
        <ul className="worktrees">
          {list?.map((wt) => (
            <li key={wt.path}>
              <div className="item-main">
                <span className="item-name">⎇ {wt.branch}</span>
                <span className="item-sub">
                  {wt.repo.split('/').pop()} · {wt.dirty ? `${wt.dirty} uncommitted` : 'clean'} · {wt.ahead} ahead
                  {wt.live.length ? ` · in use by ${wt.live.map((l) => l.name).join(', ')}` : ' · orphaned'}
                </span>
              </div>
              <button className="btn small" onClick={() => onShell(wt.path)}>
                Shell
              </button>
              <button className="btn ghost small danger" disabled={wt.live.length > 0} onClick={() => remove(wt)} title={wt.live.length ? 'In use' : 'Remove'}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
}
