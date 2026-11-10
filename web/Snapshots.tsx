import { useEffect, useRef, useState } from 'react';
import type { HostApi, SnapshotInfo, SnapshotList, Win } from './api.ts';
import { askConfirm } from './ask.tsx';
import { errorText } from './errors.ts';

const time = (at: number) => (at ? new Date(at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Per-turn snapshots for this session (F39): one row per turn, taken before
 * the turn started. Restoring returns the files to that state; a safety
 * snapshot of the current state is taken first, so a restore can be undone
 * by restoring the safety row.
 */
export function SnapshotsPanel({ client, w, onChange }: { client: HostApi; w: Win; onChange: () => void }) {
  const [data, setData] = useState<SnapshotList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const uid = w.uid;

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const current = ++version.current;
      try {
        const next = await client.snapshots(uid);
        if (!stopped && current === version.current) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!stopped && current === version.current) setError(errorText(e));
      }
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, uid]);

  async function refresh() {
    ++version.current;
    try {
      setData(await client.snapshots(uid));
      setError(null);
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function restore(snap: SnapshotInfo) {
    if (busy) return;
    const list = data?.snapshots ?? [];
    const above = list.filter((s) => s.turn > snap.turn && s.kind === 'turn').length;
    const branchNote = snap.branch && data?.branch && snap.branch !== data.branch ? ` The snapshot was taken on branch ${snap.branch}; you are on ${data.branch} now.` : '';
    const ok = await askConfirm({
      title: `Restore to before turn ${snap.turn}?`,
      body: `Files return to how they were before turn ${snap.turn}.${above ? ` File changes from ${above} later turn${above === 1 ? '' : 's'} are undone.` : ''} A safety snapshot of the current state is taken first, so this can itself be undone.${branchNote}`,
      confirm: 'Restore',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      let out;
      try {
        out = await client.restoreSnapshot(uid, snap.turn);
      } catch (e) {
        // A working agent must be stopped first; offer the interrupt once, plainly.
        if (!/agent is working/i.test(errorText(e))) throw e;
        const stop = await askConfirm({
          title: 'The agent is working',
          body: 'Stop the current turn and restore now? The turn is interrupted; the restore still takes a safety snapshot first.',
          confirm: 'Stop and restore',
          danger: true,
        });
        if (!stop) return;
        out = await client.restoreSnapshot(uid, snap.turn, true);
      }
      await refresh();
      // The files are back; only the agent's picture of them may be stale.
      if (!out.notified) setError('Restored, but the agent could not be told. Ask it to run git status and re-read changed files before it continues.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(enabled: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await client.toggleSnapshots(uid, enabled);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="queue-panel snapshots-panel">
      {data?.available !== false && (
        <p className="hint">A snapshot of the files is taken before each turn starts. Restoring one returns the files to that state.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {data && !data.available && <p className="hint">Snapshots unavailable: this session's folder is not a git repository.</p>}
      {data?.partial && data.available && <p className="hint">Snapshots may be partial for turns typed straight into the terminal (no hooks).</p>}
      {data?.available && (
        <label className="snapshot-toggle">
          <input type="checkbox" switch="" checked={data.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} /> Take snapshots for this
          session
        </label>
      )}
      {data === null && !error && <p className="hint">Loading…</p>}
      {data?.snapshots.length === 0 && data.available && <p className="hint">No snapshots yet. The next turn will take the first one.</p>}
      {/* Each row names its turn: no list numbers beside "Before turn 4". */}
      <ul className="queue-items">
        {data?.snapshots.map((s) => (
          <li key={s.id}>
            <div className="snapshot-row">
              <strong>{s.kind === 'safety' ? `Safety snapshot (turn ${s.turn})` : `Before turn ${s.turn}`}</strong>
              <span className="hint">
                {time(s.createdAt)}
                {s.branch ? ` · ${s.branch}` : ''}
              </span>
            </div>
            {s.promptExcerpt && <pre className="queue-preview">{s.promptExcerpt}</pre>}
            <p className="hint">
              {s.filesChanged} file{s.filesChanged === 1 ? '' : 's'} changed since the previous snapshot (+{s.insertions} / -{s.deletions})
              {s.skipped.length ? ` · ${s.skipped.length} oversized file${s.skipped.length === 1 ? '' : 's'} skipped` : ''}
              {s.submodules ? ' · has submodules' : ''}
            </p>
            <div className="queue-actions">
              <button className="btn small" disabled={busy} onClick={() => restore(s)}>
                Restore
              </button>
            </div>
          </li>
        ))}
      </ul>
      {data && data.snapshots.length > 0 && (
        <p className="hint">Snapshot commits are kept by refs under refs/ah-snapshots, so your own git gc cannot collect them while they are listed here.</p>
      )}
    </div>
  );
}
