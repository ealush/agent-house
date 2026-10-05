import { useEffect, useMemo, useRef, useState } from 'react';
import type { BranchList, Changes, HostApi, PullInfo, WorktreeInfo } from './api.ts';
import { Icon } from './icons.tsx';
import { Popover } from './ModelPicker.tsx';

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

// ---------- branch picker: the header pill opens a dropdown of recent local
// branches plus remote-tracking ones; typing filters them, and a name that
// matches nothing is offered as a new branch to create.

export function BranchPicker({ client, windowId, current, onSwitched }: { client: HostApi; windowId: string; current: string; onSwitched: () => void }) {
  return (
    <Popover up={false} align="right" className="pill mono" title="Switch branch" label={<><Icon name="branch" size={12} /> {current}</>}>
      {(close) => <BranchMenu client={client} windowId={windowId} close={close} onSwitched={onSwitched} />}
    </Popover>
  );
}

function BranchMenu({ client, windowId, close, onSwitched }: { client: HostApi; windowId: string; close: () => void; onSwitched: () => void }) {
  const [list, setList] = useState<BranchList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    client.branches(windowId).then(setList).catch((e) => setLoadError((e as Error).message));
  }, [client, windowId]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = list?.branches ?? [];
    const kept = needle ? all.filter((b) => b.name.toLowerCase().includes(needle)) : all;
    return [...kept].sort((a, b) => Number(b.current) - Number(a.current));
  }, [list, q]);

  const name = q.trim();
  const create = name && !rows.some((b) => b.name === name) ? name : null;
  const count = rows.length + (create ? 1 : 0);
  const at = Math.min(active, Math.max(count - 1, 0));

  async function choose(branch: string) {
    if (busy) return;
    setBusy(branch);
    setError(null);
    try {
      await client.switchBranch(windowId, branch);
      close();
      onSwitched();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="picker branch-picker" aria-label="Switch branch">
      <div className="picker-title">Switch branch</div>
      <label className="field branch-search">
        <input
          autoFocus
          value={q}
          placeholder="Search or create a branch…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((i) => Math.min(count - 1, i + 1));
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter') {
              const pick = at < rows.length ? rows[at].name : create;
              if (pick) choose(pick);
            } else return;
            e.preventDefault();
          }}
        />
      </label>
      {loadError && <p className="panel-msg">{loadError}</p>}
      {!list && !loadError && <p className="panel-msg">Loading branches…</p>}
      {list && (
        <div className="branch-rows">
          {rows.map((b, i) => (
            <div key={b.name} className={`picker-row ${i === at ? 'on' : ''}`}>
              <button type="button" className="picker-name" disabled={!!busy} onMouseEnter={() => setActive(i)} onClick={() => choose(b.name)}
                title={b.remote ? 'Remote branch — checks out with tracking' : b.current ? 'Current branch' : `Switch to ${b.name}`}>
                <Icon name="branch" size={13} />
                <span className="branch-name">{b.name}</span>
                {b.current && <span className="check">✓</span>}
                {b.remote && !b.current && <span className="hint">remote</span>}
                {busy === b.name && <span className="hint">switching…</span>}
              </button>
            </div>
          ))}
          {create && (
            <div className={`picker-row ${rows.length === at ? 'on' : ''}`}>
              <button type="button" className="picker-name" disabled={!!busy} onMouseEnter={() => setActive(rows.length)} onClick={() => choose(create)}
                title={`Create a new branch ${create}`}>
                <Icon name="plus" size={13} />
                <span className="branch-name">Create “{create}”</span>
                {busy === create && <span className="hint">switching…</span>}
              </button>
            </div>
          )}
          {!count && <p className="panel-msg">No branches yet — type a name to create one.</p>}
        </div>
      )}
      {error && <div className="picker-foot"><span>{error}</span></div>}
    </div>
  );
}

/** PR number for the session's branch, linked when one exists. Otherwise nothing. */
export function PrLink({ client, windowId, branch }: { client: HostApi; windowId: string; branch: string }) {
  const [pr, setPr] = useState<PullInfo | null>(null);
  useEffect(() => {
    setPr(null);
    client
      .pull(windowId)
      .then((p) => setPr(p.number && p.url ? p : null))
      .catch(() => {});
  }, [client, windowId, branch]);
  if (!pr?.number || !pr.url) return null;
  return (
    <a className="pill mono" href={pr.url} target="_blank" rel="noreferrer" title={`Pull request #${pr.number}`}>
      #{pr.number}
    </a>
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
