import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import type { BranchList, Changes, CheckoutsOverview, CheckoutView, HostApi, PullInfo, WorktreeInfo } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import { Icon } from './icons.tsx';
import { Popover } from './ModelPicker.tsx';
import { SheetBar, useSheet } from './sheet.tsx';
import { errorText } from './errors.ts';

// The diff parser is its own module (web/patch.ts): plain TypeScript, so tests can load it.
export { parsePatch } from './patch.ts';
import { parsePatch, type Line } from './patch.ts';
import { every } from './poll.ts';

/**
 * Working changes beside the session (F34), and click-a-line to comment (F35):
 * the comment goes to the agent with the file, line and code attached.
 */
export function ChangesPanel({ client, uid, onComment }: { client: HostApi; uid: string; onComment?: (text: string) => Promise<void> }) {
  const [data, setData] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ file: string; i: number } | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    setError(null);
    // An unchanged answer keeps the old object: no re-parse, no diff re-render every 10 s.
    client.changes(uid).then((next) => setData((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))).catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
    return every(10_000, load);
  }, [uid, client]);

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
        {/* ↑↓ walk the commentable lines; Enter opens a comment on one. */}
        <div className="diff" data-rove=".dl[tabindex='0']">
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
                    tabIndex={l.kind !== 'hunk' && onComment ? 0 : undefined}
                    role={l.kind !== 'hunk' && onComment ? 'button' : undefined}
                    aria-label={l.kind !== 'hunk' && onComment ? `Comment on ${f.path} line ${l.n ?? ''}` : undefined}
                    onClick={() => {
                      if (l.kind === 'hunk' || !onComment) return;
                      setOpen(open?.file === f.path && open.i === i ? null : { file: f.path, i });
                      setDraft('');
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                        e.preventDefault();
                        e.currentTarget.click();
                      }
                    }}
                  >
                    <span className="ln">{l.n ?? '…'}</span>
                    <span className="code">{l.text || ' '}</span>
                  </div>
                  {open?.file === f.path && open.i === i && (
                    <div className="comment-box" data-confirm>
                      <textarea
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Comment for the agent… (Ctrl+Enter sends, Esc cancels)"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) {
                            e.preventDefault();
                            submit(f.path, l);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            const line = e.currentTarget.closest('.comment-box')?.previousElementSibling as HTMLElement | null;
                            setOpen(null);
                            line?.focus();
                          }
                        }}
                      />
                      <div className="actions">
                        <button className="btn ghost small" onClick={() => setOpen(null)}>
                          Cancel
                        </button>
                        <ConfirmButton className="btn primary small" disabled={!draft.trim()} onClick={() => submit(f.path, l)}>
                          Send to agent
                        </ConfirmButton>
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
            ⎇ {data.branch} · {files.length + untracked.length} file{files.length + untracked.length === 1 ? '' : 's'}{untracked.length ? ` (${untracked.length} new)` : ''} <span className="add-n">+{totals.add}</span> <span className="del-n">-{totals.del}</span>
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

export function BranchPicker({ client, uid, current, onSwitched }: { client: HostApi; uid: string; current: string; onSwitched: () => void }) {
  const [dirty, setDirty] = useState(0);
  useEffect(() => {
    let dead = false;
    const load = () => {
      client.branches(uid).then((l) => {
        if (!dead) setDirty(l.dirty ?? 0);
      }).catch(() => {});
    };
    load();
    const stop = every(10_000, load);
    return () => {
      dead = true;
      stop();
    };
  }, [client, uid, current]);
  const title = dirty > 0 ? `Switch branch · ${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : 'Switch branch';
  return (
    <Popover up={false} align="right" className="pill mono" title={title} label={<><Icon name="branch" size={12} /> {current}{dirty > 0 && <span className="dirty-marker" aria-hidden="true" title={`${dirty} uncommitted change${dirty === 1 ? '' : 's'}`}>*</span>}</>}>
      {(close) => <BranchMenu client={client} uid={uid} close={close} onSwitched={onSwitched} />}
    </Popover>
  );
}

function BranchMenu({ client, uid, close, onSwitched }: { client: HostApi; uid: string; close: () => void; onSwitched: () => void }) {
  const [list, setList] = useState<BranchList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    client.branches(uid).then(setList).catch((e) => setLoadError(errorText(e)));
  }, [client, uid]);

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
    // A branch checked out in another worktree can never switch here — git
    // refuses even after its session is terminated, because the managed
    // worktree is kept so the ended session can resume. Fail inline with the
    // same actionable message the server returns, without a round trip.
    const held = rows.find((b) => b.name === branch)?.worktree;
    if (held) {
      setError(`branch '${branch}' is already checked out in worktree at '${held}' — open that worktree, or remove it (the branch itself is kept) to free the name`);
      return;
    }
    setBusy(branch);
    setError(null);
    try {
      await client.switchBranch(uid, branch);
      close();
      onSwitched();
    } catch (e) {
      setError(errorText(e));
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
          {rows.map((b, i) => {
            const held = !b.current && !!b.worktree;
            return (
            <div key={b.name} className={`picker-row ${i === at ? 'on' : ''}`}>
              <button type="button" className="picker-name" disabled={!!busy || held} onMouseEnter={() => setActive(i)} onClick={() => choose(b.name)}
                title={held ? `Already checked out in worktree at ${b.worktree} — open that worktree or remove it (the branch is kept)` : b.remote ? 'Remote branch — checks out with tracking' : b.current ? ((list?.dirty ?? 0) > 0 ? `Current branch · ${list!.dirty} uncommitted change${list!.dirty === 1 ? '' : 's'}` : 'Current branch') : `Switch to ${b.name}`}>
                <Icon name="branch" size={13} />
                <span className="branch-name">{b.name}{b.current && (list?.dirty ?? 0) > 0 && <span className="dirty-marker" aria-hidden="true">*</span>}</span>
                {b.current && <span className="check">✓</span>}
                {held && !b.current && <span className="hint">in worktree</span>}
                {!held && b.remote && !b.current && <span className="hint">remote</span>}
                {busy === b.name && <span className="hint">switching…</span>}
              </button>
            </div>
            );
          })}
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

/**
 * A phone's way to the branch: its header has no room for the pill, so the session's
 * ··· menu opens this sheet, the same switcher, with the pull request when there is one.
 */
export function BranchSheet({ client, uid, branch, onSwitched, onClose }: { client: HostApi; uid: string; branch: string; onSwitched: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(ref, onClose);
  const [pr, setPr] = useState<PullInfo | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    client
      .pull(uid)
      .then((p) => setPr(p.number && p.url ? p : null))
      .catch(() => {});
  }, [client, uid, branch]);
  return (
    <dialog ref={ref} className="dialog branch-sheet" aria-label="Branch" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <SheetBar onClose={dismiss} title="Branch" />
      <p className="branch-now">
        <Icon name="branch" size={14} /> <span className="mono">{branch}</span>
        {pr?.url && (
          <a className="btn small" href={pr.url} target="_blank" rel="noreferrer">
            Pull request #{pr.number}
          </a>
        )}
      </p>
      <BranchMenu client={client} uid={uid} close={dismiss} onSwitched={onSwitched} />
    </dialog>
  );
}

/** PR number for the session's branch, linked when one exists. Otherwise nothing. */
export function PrLink({ client, uid, branch }: { client: HostApi; uid: string; branch: string }) {
  const [pr, setPr] = useState<PullInfo | null>(null);
  useEffect(() => {
    setPr(null);
    client
      .pull(uid)
      .then((p) => setPr(p.number && p.url ? p : null))
      .catch(() => {});
  }, [client, uid, branch]);
  if (!pr?.number || !pr.url) return null;
  return (
    <a className="pill" href={pr.url} target="_blank" rel="noreferrer" title={`Pull request #${pr.number}`}>
      #{pr.number}
    </a>
  );
}

// ---------- managed worktrees (F30)

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function fmtAge(atSeconds: number): string {
  if (!atSeconds) return '';
  const days = Math.floor((Date.now() / 1000 - atSeconds) / 86400);
  if (days >= 1) return `idle ${days}d`;
  const hours = Math.floor((Date.now() / 1000 - atSeconds) / 3600);
  if (hours >= 1) return `idle ${hours}h`;
  return 'active just now';
}

/** Size cell: allocated bytes when measured, a state note otherwise. Measured sizes keep the state in the tooltip. */
function sizeLabel(wt: WorktreeInfo): { text: string; title: string } {
  if (wt.sizeTooLarge) return { text: 'too large to measure', title: 'This worktree has too many files to size in the background.' };
  if (wt.sizeBytes === null) return { text: 'measuring…', title: 'Size is being measured in the background.' };
  const exact = `${wt.sizeBytes.toLocaleString()} bytes on disk${wt.logicalBytes !== null ? `, ${wt.logicalBytes.toLocaleString()} bytes of files` : ''}`;
  return { text: `${wt.sizePartial ? '~' : ''}${fmtSize(wt.sizeBytes)} on disk`, title: exact };
}

export function WorktreesDialog({
  client,
  onClose,
  onShell,
  onOpenSession,
  onNewSession,
  supportsCheckouts = false,
}: {
  client: HostApi;
  onClose: () => void;
  onShell: (path: string) => void;
  onOpenSession?: (uid: string) => void;
  onNewSession?: (cwd: string) => void;
  supportsCheckouts?: boolean;
}) {
  if (supportsCheckouts) {
    return <CheckoutsDialog client={client} onClose={onClose} onShell={onShell} onOpenSession={onOpenSession} onNewSession={onNewSession} />;
  }
  return <LegacyWorktreesDialog client={client} onClose={onClose} onShell={onShell} />;
}

function CheckoutsDialog({
  client,
  onClose,
  onShell,
  onOpenSession,
  onNewSession,
}: {
  client: HostApi;
  onClose: () => void;
  onShell: (path: string) => void;
  onOpenSession?: (uid: string) => void;
  onNewSession?: (cwd: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(ref, onClose);
  const [data, setData] = useState<CheckoutsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [gcBusy, setGcBusy] = useState(false);

  const load = () => client.checkouts().then((next) => { setData(next); setError(null); }).catch((e) => setError(errorText(e)));
  useEffect(() => {
    ref.current?.showModal();
    load();
    return every(3000, load);
  }, [client]);

  async function runGcNow() {
    if (gcBusy) return;
    setGcBusy(true);
    setSummary(null);
    try {
      const res = await client.runCheckoutsGc(false);
      setSummary(
        res.reclaimed.length
          ? `Reclaimed ${res.reclaimed.length} checkout${res.reclaimed.length === 1 ? '' : 's'} (${fmtSize(res.reclaimedBytes)}). Branches preserved.`
          : 'No eligible clean checkouts to reclaim right now.',
      );
      load();
    } catch (e) {
      showError(e, "Couldn't run cleanup");
    } finally {
      setGcBusy(false);
    }
  }

  async function togglePin(c: CheckoutView) {
    setBusyId(c.id);
    try {
      await client.pinCheckout(c.id, !c.pinned);
      load();
    } catch (e) {
      showError(e, "Couldn't update pin");
    } finally {
      setBusyId(null);
    }
  }

  async function runCheck(c: CheckoutView) {
    setBusyId(c.id);
    try {
      const updated = await client.checkCheckout(c.id);
      setSummary(
        updated.integration?.clean
          ? `${c.branch ?? c.id} merges cleanly into ${updated.integration.trunk}.`
          : updated.integration?.conflicts.length
            ? `${c.branch ?? c.id} conflicts with ${updated.integration.trunk} in ${updated.integration.conflicts.join(', ')}.`
            : updated.integration?.error ?? 'Compatibility check complete.',
      );
      load();
    } catch (e) {
      showError(e, "Couldn't check compatibility");
    } finally {
      setBusyId(null);
    }
  }

  async function recreate(c: CheckoutView) {
    setBusyId(c.id);
    try {
      await client.recreateCheckout(c.id);
      setSummary(`Recreated checkout ${c.branch ?? c.id}.`);
      load();
    } catch (e) {
      showError(e, "Couldn't recreate checkout");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(c: CheckoutView) {
    const dirty = c.dirty > 0;
    const ok = await askConfirm({
      title: `Remove ${c.branch ?? c.id}?`,
      body: dirty
        ? `${c.dirty} uncommitted change${c.dirty === 1 ? '' : 's'} will be deleted. The branch itself is kept.`
        : 'The worktree checkout will be reclaimed. The branch itself is kept so the session can resume.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setBusyId(c.id);
    try {
      await client.removeCheckout(c.id, dirty || c.pinned);
      load();
    } catch (e) {
      showError(e, "Couldn't remove checkout");
    } finally {
      setBusyId(null);
    }
  }

  const s = data?.storage;
  return (
    <dialog ref={ref} className="dialog wide" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <div className="capture-head">
        <h2>Checkouts &amp; Storage</h2>
        <button className="btn ghost small desk-close" onClick={onClose}>
          Close
        </button>
      </div>

      {s && (
        <div className="sec-card" style={{ padding: '12px 14px', margin: '0 14px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <strong>{fmtSize(s.totalBytes)}</strong> across {s.counts.total} worktree{s.counts.total === 1 ? '' : 's'}
              <span className="hint">
                {' '}· Active {fmtSize(s.activeBytes)} · Retained {fmtSize(s.retainedBytes)} · Reclaimable {fmtSize(s.reclaimableBytes)}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="pill">
                Auto-cleanup: {s.gcEnabled ? 'On' : 'Off'}
                {s.underPressure ? ' · Low disk' : s.overBudget ? ' · Over budget' : ''}
              </span>
              {s.counts.reclaimable > 0 && (
                <button className="btn small" disabled={gcBusy} onClick={runGcNow}>
                  {gcBusy ? 'Cleaning…' : `Reclaim ${fmtSize(s.reclaimableBytes)}`}
                </button>
              )}
            </div>
          </div>
          {s.diskFreeBytes !== null && (
            <div className="hint" style={{ marginTop: 4 }}>
              {fmtSize(s.diskFreeBytes)} free on disk · Clean merged checkouts reclaimed after {data.policy.mergedRetentionHours}h; clean unmerged after {data.policy.unmergedRetentionDays}d (branches kept).
            </div>
          )}
        </div>
      )}

      {summary && <p className="panel-msg">{summary}</p>}
      {error && <p className="panel-msg">{error}</p>}
      {data && data.repositories.length === 0 && (
        <p className="panel-msg">No tracked repository checkouts yet. New coding-agent sessions in Git repositories automatically receive their own isolated checkout.</p>
      )}

      {data?.repositories.map((repo) => (
        <section key={repo.repoRoot} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, margin: '0 14px 6px' }}>
            <h3 className="section-label" style={{ margin: 0 }}>
              {repo.name} <span className="hint">({repo.trunk}) · {repo.activeCount} active</span>
              {repo.overlapCount > 0 && (
                <span className="pill" style={{ marginLeft: 8, color: 'var(--warn, #e5a93c)' }}>
                  {repo.overlapCount} overlap{repo.overlapCount === 1 ? '' : 's'}
                </span>
              )}
            </h3>
            {onNewSession && (
              <button
                className="btn small"
                onClick={() => {
                  onClose();
                  onNewSession(repo.repoRoot);
                }}
              >
                + Parallel session
              </button>
            )}
          </div>
          <ul className="worktrees">
            {repo.checkouts.map((c) => {
              const isBusy = busyId === c.id;
              return (
                <li key={c.id} className={c.lifecycle === 'reclaimed' ? 'dim' : undefined}>
                  <div className="stack">
                    <span>
                      {c.kind === 'main' ? '⌂ main' : `⎇ ${c.branch ?? '(detached)'}`}
                      {c.pinned && <span className="pill" style={{ marginLeft: 6 }}>pinned</span>}
                      {c.kind === 'worktree' && c.managed === false && (
                        <span className="pill" title="Not made by ah: never cleaned up automatically, only by hand." style={{ marginLeft: 6 }}>
                          kept
                        </span>
                      )}
                      {c.lifecycle === 'reclaimed' && <span className="pill" style={{ marginLeft: 6 }}>reclaimed</span>}
                      {c.ports && <span className="hint" style={{ marginLeft: 6 }}>:{c.ports.start}–{c.ports.end}</span>}
                    </span>
                    <span className="sub">
                      {c.owner ? (
                        <>
                          {c.owner.agent} ·{' '}
                          {onOpenSession && c.owner.live ? (
                            <button
                              type="button"
                              className="btn ghost small"
                              style={{ padding: '0 4px', minHeight: 0 }}
                              onClick={() => {
                                onClose();
                                onOpenSession(c.owner!.uid);
                              }}
                            >
                              {c.owner.title}
                            </button>
                          ) : (
                            c.owner.title
                          )}
                          {' '}({c.owner.status})
                        </>
                      ) : (
                        c.lifecycle
                      )}
                      {c.exists && (
                        <>
                          {' '}· {c.dirty ? `${c.dirty} uncommitted` : 'clean'} · {c.ahead} ahead
                          {c.merged ? ' · merged' : ''}
                          {c.sizeBytes !== null ? ` · ${fmtSize(c.sizeBytes)}` : ''}
                        </>
                      )}
                      {c.lastActivityAt ? ` · ${fmtAge(c.lastActivityAt)}` : ''}
                    </span>
                    {c.overlaps.length > 0 && (
                      <span className="sub" style={{ color: 'var(--warn, #e5a93c)' }}>
                        Overlaps with {c.overlaps.map((o) => `${o.branch ?? o.checkoutId} (${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? ` +${o.files.length - 3}` : ''})`).join('; ')}
                      </span>
                    )}
                    {c.integration && (
                      <span className="sub" style={{ color: c.integration.clean ? 'var(--ok, #4caf50)' : 'var(--danger, #e55)' }}>
                        {c.integration.clean
                          ? `✓ Compatible with ${c.integration.trunk} (${c.integration.trunkSha})`
                          : c.integration.conflicts.length
                            ? `✕ Conflicts with ${c.integration.trunk}: ${c.integration.conflicts.join(', ')}`
                            : `✕ ${c.integration.error ?? 'Check failed'}`}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {c.kind === 'worktree' && c.exists && c.branch && (
                      <button className="btn ghost small" disabled={isBusy} onClick={() => runCheck(c)} title={`Non-destructive merge-tree check against ${repo.trunk}`}>
                        Check merge
                      </button>
                    )}
                    {c.kind === 'worktree' && (
                      <button className="btn ghost small" disabled={isBusy} onClick={() => togglePin(c)} title={c.pinned ? 'Allow automatic cleanup' : 'Exempt from automatic cleanup'}>
                        {c.pinned ? 'Unpin' : 'Pin'}
                      </button>
                    )}
                    {c.exists ? (
                      <button className="btn small" onClick={() => onShell(c.path)}>
                        Shell
                      </button>
                    ) : (
                      c.kind === 'worktree' && (
                        <button className="btn small" disabled={isBusy} onClick={() => recreate(c)}>
                          Recreate
                        </button>
                      )
                    )}
                    {c.kind === 'worktree' && c.exists && (
                      <button className="btn ghost small danger" disabled={isBusy || c.lifecycle === 'active'} onClick={() => remove(c)} title={c.lifecycle === 'active' ? 'In use' : 'Reclaim checkout (branch kept)'}>
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </dialog>
  );
}

function LegacyWorktreesDialog({ client, onClose, onShell }: { client: HostApi; onClose: () => void; onShell: (path: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(ref, onClose);
  const [list, setList] = useState<WorktreeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bySize, setBySize] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const load = () => client.worktrees().then((rows) => { setList(rows); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => {
    ref.current?.showModal();
    load();
    return every(2000, load);
  }, [client]);

  const orphans = useMemo(() => (list ?? []).filter((wt) => wt.orphan), [list]);
  const totalBytes = (list ?? []).reduce((n, wt) => n + (wt.sizeBytes ?? 0), 0);
  const orphanBytes = orphans.reduce((n, wt) => n + (wt.sizeBytes ?? 0), 0);
  const anyMeasured = (list ?? []).some((wt) => wt.sizeBytes !== null);
  const rows = useMemo(() => {
    const all = [...(list ?? [])];
    // Unmeasured and partial rows sort last: their true place is unknown.
    if (bySize) all.sort((a, b) => Number(a.sizePartial || a.sizeBytes === null) - Number(b.sizePartial || b.sizeBytes === null) || (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
    return all;
  }, [list, bySize]);
  const picked = orphans.filter((wt) => selected.has(wt.path));
  const pickedBytes = picked.reduce((n, wt) => n + (wt.sizeBytes ?? 0), 0);

  async function remove(wt: WorktreeInfo) {
    const dirty = wt.dirty > 0;
    const ok = await askConfirm({
      title: `Remove ${wt.branch}?`,
      body: dirty
        ? `${wt.dirty} uncommitted change${wt.dirty === 1 ? '' : 's'} will be deleted. The branch itself is kept.`
        : 'The worktree will be removed. The branch itself is kept.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await client.removeWorktree(wt.path, dirty);
      load();
    } catch (e) {
      showError(e, "Couldn't remove the worktree");
    }
  }

  function startCleanup() {
    // Clean orphans start checked; dirty ones are listed unchecked, and
    // checking one opts that item into the force path only.
    setSelected(new Set(orphans.filter((wt) => wt.dirty === 0).map((wt) => wt.path)));
    setSummary(null);
    setSelecting(true);
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function removeSelected() {
    if (!picked.length || busy) return;
    const lines = picked.map((wt) => `⎇ ${wt.branch} · ${sizeLabel(wt).text}${wt.dirty ? ` · ${wt.dirty} uncommitted (will be force-removed)` : ''}`);
    const ok = await askConfirm({
      title: `Remove ${picked.length} worktree${picked.length === 1 ? '' : 's'}?`,
      body: `${lines.join('\n')}\n\nAbout ${fmtSize(pickedBytes)} will be reclaimed. Branches are kept. Every item is re-checked before removal: one that came back into use or changed state is skipped and reported.`,
      confirm: 'Remove selected',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { results } = await client.removeWorktreesBulk(
        picked.map((wt) => wt.path),
        picked.filter((wt) => wt.dirty > 0).map((wt) => wt.path),
      );
      const done = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const reclaimed = done.reduce((n, r) => n + r.reclaimedBytes, 0);
      setSummary(
        `Removed ${done.length} worktree${done.length === 1 ? '' : 's'}, reclaimed about ${fmtSize(reclaimed)}.` +
          (failed.length ? ` ${failed.length} skipped: ${failed.map((r) => `${r.path.split('/').pop()} (${r.error ?? 'failed'})`).join('; ')}` : ''),
      );
      setSelecting(false);
      setSelected(new Set());
      load();
    } catch (e) {
      showError(e, "Couldn't remove the worktrees");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog wide" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <div className="capture-head">
        <h2>Worktrees</h2>
        <button className="btn ghost small desk-close" onClick={onClose}>
          Close
        </button>
      </div>
      {list && list.length > 0 && (
        <p className="panel-msg">
          {list.length} worktree{list.length === 1 ? '' : 's'}
          {anyMeasured ? `, using ${fmtSize(totalBytes)}` : ', measuring sizes…'} · {orphans.length} orphaned
          {orphans.length && anyMeasured ? ` (${fmtSize(orphanBytes)})` : ''}
        </p>
      )}
      {summary && <p className="panel-msg">{summary}</p>}
      {error && <p className="panel-msg">{error}</p>}
      {list?.length === 0 && <p className="panel-msg">No ah-managed worktrees yet. Tick “Isolated git worktree” when starting a session.</p>}
      {list && list.length > 0 && (
        <div className="actions">
          <button className="btn ghost small" onClick={() => setBySize((v) => !v)}>
            {bySize ? 'Default order' : 'Sort by size'}
          </button>
          {!selecting && orphans.length > 0 && (
            <button className="btn small" onClick={startCleanup}>
              Clean up orphans
            </button>
          )}
          {selecting && (
            <>
              <button className="btn ghost small" disabled={busy} onClick={() => setSelecting(false)}>
                Cancel
              </button>
              <button className="btn small danger" disabled={busy || !picked.length} onClick={() => removeSelected()}>
                {busy ? 'Removing…' : `Remove ${picked.length} selected (about ${fmtSize(pickedBytes)})`}
              </button>
            </>
          )}
        </div>
      )}
      <p className="panel-msg hint">Removing a worktree deletes its checkout. The branch itself is kept.</p>
      {(() => {
        const live = rows.filter((wt) => wt.live.length > 0);
        const rest = rows.filter((wt) => wt.live.length === 0);
        const restHead = rest.length > 0 && rest.every((wt) => wt.orphan) ? 'Orphaned' : 'Not in use';
        const renderRow = (wt: WorktreeInfo) => {
          const size = sizeLabel(wt);
          const inUse = wt.live.length > 0;
          return (
            <li key={wt.path} className={selecting && !wt.orphan ? 'dim' : undefined}>
              {selecting && (
                <input
                  type="checkbox"
                  className="wt-check"
                  disabled={!wt.orphan}
                  checked={selected.has(wt.path)}
                  onChange={() => toggle(wt.path)}
                  title={!wt.orphan ? 'Live or resumable session; cannot be removed in bulk' : wt.dirty ? 'Uncommitted changes; checking opts into force removal' : 'Remove this orphan'}
                />
              )}
              <div className="stack">
                <span>⎇ {wt.branch}</span>
                <span className="sub">
                  {wt.repo.split('/').pop()} · {wt.dirty ? `${wt.dirty} uncommitted` : 'clean'} · {wt.ahead} ahead
                  {inUse ? ` · in use by ${wt.live.map((l) => l.name).join(', ')}` : wt.orphan ? ' · orphaned' : ' · saved session'}
                  {wt.lastActivityAt ? ` · ${fmtAge(wt.lastActivityAt)}` : ''}
                </span>
                <span className="sub" title={size.title}>
                  {size.text}
                </span>
              </div>
              {!selecting && (
                <>
                  <button className="btn small" onClick={() => onShell(wt.path)}>
                    Open shell
                  </button>
                  <button className="btn ghost small danger" disabled={inUse} onClick={() => remove(wt)} title={inUse ? 'In use' : 'Remove'}>
                    Remove
                  </button>
                </>
              )}
            </li>
          );
        };
        return (
          <>
            {live.length > 0 && (
              <>
                <h3 className="section-label">In use</h3>
                <ul className="worktrees">{live.map(renderRow)}</ul>
              </>
            )}
            {rest.length > 0 && (
              <>
                <h3 className="section-label">{restHead}</h3>
                {restHead === 'Orphaned' && <p className="panel-msg hint">No session uses these any more.</p>}
                <ul className="worktrees">{rest.map(renderRow)}</ul>
              </>
            )}
          </>
        );
      })()}
    </dialog>
  );
}
