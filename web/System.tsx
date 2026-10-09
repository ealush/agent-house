import { useState } from 'react';
import { api } from './api.ts';
import { askConfirm, showError } from './ask.tsx';

// Settings → System: host-level actions. A restart bounces the daemon while
// tmux and the sessions keep running; this page reconnects on its own.
// Rebuild and restart also deletes dist and builds the UI from this checkout first.
export function SystemPanel() {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'restart' | 'rebuild' | null>(null);
  const [uploadsNote, setUploadsNote] = useState<string | null>(null);

  async function restart() {
    if (
      !(await askConfirm({
        title: 'Restart the ah server?',
        body: 'The page disconnects for a few seconds while the server restarts. Sessions keep running.',
        confirm: 'Restart',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.restart();
      setPhase('restart');
    } catch (e) {
      showError(e, "Couldn't restart the server");
    } finally {
      setBusy(false);
    }
  }

  async function rebuild() {
    if (
      !(await askConfirm({
        title: 'Rebuild and restart?',
        body: 'The old build is deleted, the UI is built again from this checkout, and then the server restarts. This takes longer than a restart. Sessions keep running.',
        confirm: 'Rebuild and restart',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setPhase('rebuild');
    try {
      await api.rebuild();
      setPhase('restart');
    } catch (e) {
      setPhase(null);
      showError(e, "Couldn't rebuild the server");
    } finally {
      setBusy(false);
    }
  }

  async function clearUploads() {
    if (
      !(await askConfirm({
        title: 'Clear the uploads folder?',
        body: 'Everything in ~/.cache/ah/uploads is deleted.',
        confirm: 'Clear uploads',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setUploadsNote(null);
    try {
      const { removed } = await api.clearUploads();
      setUploadsNote(removed === 0 ? 'Uploads folder is already empty.' : removed === 1 ? 'Cleared 1 file from the uploads folder.' : `Cleared ${removed} files from the uploads folder.`);
    } catch (e) {
      showError(e, "Couldn't clear the uploads folder");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="system-panels">
      <div className="sec-card">
        <h2>Server</h2>
        <p className="hint">
          Restart the ah server on this host after updating it or changing its config. Rebuild and restart clears the old build, builds the UI again from this checkout, and then restarts. Sessions keep running, and this page reconnects by itself.
        </p>
        {phase === 'restart' && <p className="panel-msg">Restarting… this page reconnects when the server is back.</p>}
        {phase === 'rebuild' && <p className="panel-msg">Clearing the old build and rebuilding… the server restarts when the build finishes, and this page reconnects.</p>}
        <div className="system-actions">
          <button className="btn" disabled={busy || phase !== null} onClick={() => void restart()}>
            Restart server
          </button>
          <button className="btn" disabled={busy || phase !== null} onClick={() => void rebuild()}>
            Rebuild and restart
          </button>
        </div>
      </div>
      <div className="sec-card">
        <h2>Uploads</h2>
        <p className="hint">Pasted and dropped files are stored in ~/.cache/ah/uploads on this host.</p>
        {uploadsNote && <p className="hint">{uploadsNote}</p>}
        <button className="btn" disabled={busy || phase !== null} onClick={() => void clearUploads()}>
          Clear uploads folder
        </button>
      </div>
    </div>
  );
}
