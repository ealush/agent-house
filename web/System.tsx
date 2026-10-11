import { useEffect, useState } from 'react';
import { api, type DesktopStatus, type HooksStatus } from './api.ts';
import { copyText } from './selection.ts';
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
        <h2>This device</h2>
        <p className="hint">Load the app again on this device, for example after an update. Sessions keep running.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
      <HooksCard />
      <DesktopCard />
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

/** Agent status hooks: exact working / needs-you / done, and Claude's questions in full. */
function HooksCard() {
  const [status, setStatus] = useState<HooksStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.hooks().then(setStatus).catch(() => {});
  }, []);
  const on = !!status && status.claude.wired === status.claude.of;

  async function change(action: 'install' | 'uninstall') {
    if (
      action === 'uninstall' &&
      !(await askConfirm({ title: 'Remove the agent hooks?', body: 'ah falls back to reading the screen for status. Your other hooks stay.', confirm: 'Remove', danger: true }))
    )
      return;
    setBusy(true);
    try {
      const r = await api.setHooks(action);
      setStatus(r.status);
      setNotes(r.messages);
    } catch (e) {
      showError(e, "Couldn't change the hooks");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sec-card">
      <h2>Agent hooks</h2>
      <p className="hint">
        With hooks, Claude Code and Codex tell ah exactly when they are working, waiting for you, or done, and Claude's questions arrive whole. Without them, ah reads the screen,
        which is slower and can miss a prompt. Installing adds entries that run ah's hook script; your own hooks are kept, and each file is backed up first.
      </p>
      {status && (
        <ul className="hook-status">
          <li>
            <span className={`dot ${on ? 'online' : 'offline'}`} /> Claude Code: {status.claude.wired}/{status.claude.of} events <span className="mono hint">{status.claude.file}</span>
          </li>
          <li>
            <span className={`dot ${status.codex.wired ? 'online' : 'offline'}`} /> Codex: {status.codex.wired ? 'wired' : status.codex.otherNotify ? 'another notify program is set' : 'not wired'}{' '}
            <span className="mono hint">{status.codex.file}</span>
          </li>
        </ul>
      )}
      {notes.map((n) => (
        <p key={n} className="hint">
          {n}
        </p>
      ))}
      <div className="system-actions">
        <button className="btn primary" disabled={busy} onClick={() => void change('install')}>
          {on ? 'Reinstall hooks' : 'Install hooks'}
        </button>
        {(status?.claude.wired || status?.codex.wired) && (
          <button className="btn" disabled={busy} onClick={() => void change('uninstall')}>
            Remove hooks
          </button>
        )}
      </div>
    </div>
  );
}

/** ah in the host's app launcher (an Omarchy web app), and a key for it. */
function DesktopCard() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.desktop().then(setStatus).catch(() => {});
  }, []);

  async function change(action: 'install' | 'uninstall') {
    setBusy(true);
    try {
      const r = await api.setDesktop(action);
      setStatus(r.status);
      setNotes(r.messages);
    } catch (e) {
      showError(e, "Couldn't change the launcher");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <div className="sec-card">
      <h2>Desktop app</h2>
      <p className="hint">
        Open ah from the app launcher{status.omarchy ? ' (Super+Space)' : ''} in a window of its own, without browser tabs or toolbars{status.omarchy ? ', like every other Omarchy web app' : ''}. It opens{' '}
        <span className="mono">{status.url}</span>.
      </p>
      <ul className="hook-status">
        <li>
          <span className={`dot ${status.installed ? 'online' : 'offline'}`} /> {status.installed ? 'In the app launcher' : 'Not in the app launcher'} <span className="mono hint">{status.file}</span>
        </li>
      </ul>
      {notes.map((n) => (
        <p key={n} className="hint">
          {n}
        </p>
      ))}
      <div className="system-actions">
        <button className="btn primary" disabled={busy} onClick={() => void change('install')}>
          {status.installed ? 'Update launcher' : 'Add to app launcher'}
        </button>
        {status.installed && (
          <button className="btn" disabled={busy} onClick={() => void change('uninstall')}>
            Remove
          </button>
        )}
      </div>
      <p className="hint">For a key of its own, add this to ~/.config/hypr/bindings.conf:</p>
      <div className="bind-line">
        <code className="mono">{status.bind}</code>
        <button className="btn small ghost" onClick={() => void copyText(status.bind)}>
          Copy
        </button>
      </div>
    </div>
  );
}
