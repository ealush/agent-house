import { useEffect, useState } from 'react';
import { api, type DesktopStatus, type HooksStatus } from './api.ts';
import { copyText } from './selection.ts';
import { askConfirm, showError } from './ask.tsx';
import { clearUploads, rebuildServer, restartServer } from './settingsMenu.ts';
import { age, look } from './agents.ts';

// Settings → System: host-level actions. A restart bounces the daemon while
// tmux and the sessions keep running; this page reconnects on its own.
// Rebuild and restart also deletes dist and builds the UI from this checkout first.
export function SystemPanel() {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'restart' | 'rebuild' | null>(null);
  const [uploadsNote, setUploadsNote] = useState<string | null>(null);

  async function restart() {
    setBusy(true);
    if (await restartServer()) setPhase('restart');
    setBusy(false);
  }

  async function rebuild() {
    setBusy(true);
    const ok = await rebuildServer(() => setPhase('rebuild'));
    setPhase(ok ? 'restart' : null);
    setBusy(false);
  }

  async function clear() {
    setBusy(true);
    setUploadsNote(null);
    const note = await clearUploads();
    if (note) setUploadsNote(note);
    setBusy(false);
  }

  return (
    <div className="system-panels">
      <HooksCard />
      <DesktopCard />
      <div className="sec-card">
        <h2>Server</h2>
        <p className="hint">
          Restart the ah server on this host after updating it or changing its config. Rebuild and restart clears the old build, builds the UI again from this checkout, and then restarts. Reload page loads the app again on this device only. Sessions keep running, and this page reconnects by itself.
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
          <button className="btn" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
      <div className="sec-card">
        <h2>Uploads</h2>
        <p className="hint">Pasted and dropped files are stored in ~/.cache/ah/uploads on this host.</p>
        {uploadsNote && <p className="hint">{uploadsNote}</p>}
        <button className="btn" disabled={busy || phase !== null} onClick={() => void clear()}>
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
      <ScreenRules audit={status?.audit} onReset={() => void api.resetScreenAudit().then(() => api.hooks().then(setStatus), (e) => showError(e, "Couldn't reset the check"))} />
      <div className="system-actions">
        {/* The accent marks what's left to do: installed, reinstalling is upkeep, not the next step. */}
        <button className={on ? 'btn' : 'btn primary'} disabled={busy} onClick={() => void change('install')}>
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

/**
 * How well the screen rules (what sessions without hooks rely on) kept up with
 * the prompts hooks reported. A miss means a hookless session would have read
 * "done" while it waited for you: the agent's TUI changed under the rules.
 */
function ScreenRules({ audit, onReset }: { audit: HooksStatus['audit']; onReset: () => void }) {
  const rows = Object.entries(audit ?? {}).filter(([, a]) => a.checked > 0);
  if (!rows.length) return null;
  return (
    <div className="screen-rules">
      <h3>Screen rules</h3>
      <p className="hint">Every prompt a hook reports also tests the screen reading that sessions without hooks rely on.</p>
      <ul className="hook-status">
        {rows.map(([id, a]) => (
          <li key={id}>
            <span className={`dot ${a.missed ? 'offline' : 'online'}`} /> {look(id).name}:{' '}
            {a.missed
              ? `missed ${a.missed} of ${a.checked} prompt${a.checked === 1 ? '' : 's'}, last ${age(a.last?.at ?? 0)} ago. Without hooks, these would have shown as done while waiting for you.`
              : `caught all ${a.checked} prompt${a.checked === 1 ? '' : 's'}`}
          </li>
        ))}
      </ul>
      {rows.map(([id, a]) =>
        a.last ? (
          <details key={id} className="screen-miss">
            <summary>The last {look(id).name} prompt the rules missed</summary>
            <pre>{a.last.screen}</pre>
          </details>
        ) : null,
      )}
      {rows.some(([, a]) => a.missed) && (
        <button className="btn" onClick={onReset}>
          Start counting again
        </button>
      )}
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
        <button className={status.installed ? 'btn' : 'btn primary'} disabled={busy} onClick={() => void change('install')}>
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
