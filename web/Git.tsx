import { useEffect, useMemo, useRef, useState } from 'react';
import type { Changes, HostApi, WorktreeInfo } from './api.ts';

// ---------- unified diff → files / lines with real line numbers

type Line = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; n: number | null };
type FileDiff = { path: string; add: number; del: number; lines: Line[] };

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | null = null;
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      f = { path: raw.split(' b/').slice(1).join(' b/') || raw, add: 0, del: 0, lines: [] };
      files.push(f);
    } else if (!f || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) {
      continue;
    } else if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      oldN = Number(m?.[1] ?? 0);
      newN = Number(m?.[2] ?? 0);
      f.lines.push({ kind: 'hunk', text: raw.replace(/^@@[^@]*@@\s?/, '… ') || '…', n: null });
    } else if (raw.startsWith('+')) {
      f.add++;
      f.lines.push({ kind: 'add', text: raw.slice(1), n: newN++ });
    } else if (raw.startsWith('-')) {
      f.del++;
      f.lines.push({ kind: 'del', text: raw.slice(1), n: oldN++ });
    } else if (raw.startsWith(' ')) {
      f.lines.push({ kind: 'ctx', text: raw.slice(1), n: newN++ });
      oldN++;
    }
  }
  return files;
}

/**
 * Working changes beside the session (F34), and click-a-line to comment (F35):
 * the comment goes to the agent with the file, line and code attached.
 */
export function ChangesPanel({ client, windowId, onComment }: { client: HostApi; windowId: string; onComment?: (text: string) => Promise<void> }) {
  const [data, setData] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ file: string; i: number } | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    setError(null);
    client.changes(windowId).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
    const t = window.setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [windowId, client]);

  const files = useMemo(() => (data ? parsePatch(data.patch) : []), [data]);
  const untracked = data?.files.filter((f) => f.code === '??' || f.code === '?') ?? [];
  const totals = files.reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });

  async function submit(file: string, line: Line) {
    if (!draft.trim() || !onComment) return;
    const where = line.n ? `${file}:${line.n}` : file;
    await onComment(`Comment on ${where}${line.kind === 'del' ? ' (removed line)' : ''}:\n> ${line.text.trim()}\n\n${draft.trim()}`);
    setDraft('');
    setOpen(null);
  }

  return (
    <>
      <div className="panel-body">
        {error && <p className="panel-msg">{error}</p>}
        {!data && !error && <p className="panel-msg">Loading changes…</p>}
        {data && !files.length && !untracked.length && <p className="panel-msg">Working tree clean on {data.branch}.</p>}
        <div className="diff">
          {files.map((f) => (
            <section key={f.path}>
              <div className="diff-file">
                <span className="grow">{f.path}</span>
                <span className="add-n">+{f.add}</span>
                <span className="del-n">-{f.del}</span>
              </div>
              {f.lines.map((l, i) => (
                <div key={i}>
                  <div
                    className={`dl ${l.kind}`}
                    onClick={() => {
                      if (l.kind === 'hunk' || !onComment) return;
                      setOpen(open?.file === f.path && open.i === i ? null : { file: f.path, i });
                      setDraft('');
                    }}
                  >
                    <span className="ln">{l.n ?? '…'}</span>
                    <span className="code">{l.text || ' '}</span>
                  </div>
                  {open?.file === f.path && open.i === i && (
                    <div className="comment-box">
                      <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Comment for the agent…" />
                      <div className="actions">
                        <button className="btn ghost small" onClick={() => setOpen(null)}>
                          Cancel
                        </button>
                        <button className="btn primary small" disabled={!draft.trim()} onClick={() => submit(f.path, l)}>
                          Send to agent
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
          {untracked.length > 0 && (
            <section>
              <div className="diff-file">
                <span className="grow">untracked</span>
                <span className="add-n">{untracked.length}</span>
              </div>
              {untracked.map((u) => (
                <div key={u.path} className="dl ctx">
                  <span className="ln">?</span>
                  <span className="code">{u.path}</span>
                </div>
              ))}
            </section>
          )}
          {data?.truncated && <p className="panel-msg">Patch truncated; open a shell for the rest.</p>}
        </div>
      </div>
      <div className="panel-foot">
        {data ? (
          <>
            ⎇ {data.branch} · {files.length} file{files.length === 1 ? '' : 's'} <span className="add-n">+{totals.add}</span> <span className="del-n">-{totals.del}</span>
            {onComment ? ' · click a line to comment for the agent' : ''}
          </>
        ) : (
          ' '
        )}
      </div>
    </>
  );
}

// ---------- managed worktrees (F30)

export function WorktreesDialog({ client, onClose, onShell }: { client: HostApi; onClose: () => void; onShell: (path: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [list, setList] = useState<WorktreeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => client.worktrees().then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    ref.current?.showModal();
    load();
  }, []);

  async function remove(wt: WorktreeInfo) {
    const dirty = wt.dirty > 0;
    const msg = dirty
      ? `${wt.branch} has ${wt.dirty} uncommitted change${wt.dirty > 1 ? 's' : ''}. Delete them and remove the worktree?`
      : `Remove worktree ${wt.branch}? The branch itself is kept.`;
    if (!confirm(msg)) return;
    try {
      await client.removeWorktree(wt.path, dirty);
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
      {error && <p className="panel-msg">{error}</p>}
      {list?.length === 0 && <p className="panel-msg">No ah-managed worktrees yet. Tick “Isolated git worktree” when starting a session.</p>}
      <ul className="worktrees">
        {list?.map((wt) => (
          <li key={wt.path}>
            <div className="stack">
              <span>⎇ {wt.branch}</span>
              <span className="sub">
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
    </dialog>
  );
}
