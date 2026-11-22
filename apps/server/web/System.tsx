import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, deviceName, type DesktopStatus, type HooksStatus, type LoggingStatus } from './api.ts';
import { asJsonl, clientLog, lastMinutes, type Window } from './clientLog.ts';
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
      <DeveloperCard />
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

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The bundle's time windows: the last n minutes, everything kept, or a range you pick. */
const SPANS: Array<{ id: string; label: string; name: string; minutes: number | null }> = [
  { id: '15m', label: '15m', name: 'Last 15 minutes', minutes: 15 },
  { id: '1h', label: '1h', name: 'Last hour', minutes: 60 },
  { id: '6h', label: '6h', name: 'Last 6 hours', minutes: 360 },
  { id: '24h', label: '24h', name: 'Last 24 hours', minutes: 1440 },
  { id: 'all', label: 'All', name: 'Everything kept', minutes: null },
  { id: 'range', label: 'Range', name: 'A range', minutes: null },
];

/** A datetime-local input's value for `t` (local time, to the minute). */
const localInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/**
 * Settings → System → Developer: the host's log (server/devlog.ts) and this device's
 * (clientLog.ts), each off until turned on. This device's goes to the host as a bundle
 * for an agent to read, or downloads, for the time you pick.
 */
function DeveloperCard() {
  const [status, setStatus] = useState<LoggingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [span, setSpan] = useState('1h');
  const [from, setFrom] = useState(() => localInput(Date.now() - 30 * 60_000));
  const [to, setTo] = useState(() => localInput(Date.now()));
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const mine = useSyncExternalStore(clientLog.subscribe, () => clientLog.on);
  // Re-read on every change: the count and the window's count follow the log.
  const count = useSyncExternalStore(clientLog.subscribe, () => clientLog.entries().length);
  useEffect(() => {
    api.logging().then(setStatus).catch(() => {});
  }, []);

  const window = (): Window => {
    if (span !== 'range') return lastMinutes(SPANS.find((s) => s.id === span)!.minutes);
    return { from: Date.parse(from), to: Date.parse(to) + 59_999 };
  };
  const picked = clientLog.entries(window());
  const badRange = span === 'range' && !(Date.parse(from) <= Date.parse(to));

  async function setHost(on: boolean) {
    setBusy(true);
    try {
      setStatus(await api.setLogging(on));
    } catch (e) {
      showError(e, "Couldn't change the host's log");
    } finally {
      setBusy(false);
    }
  }

  const client = () => ({ app: 'web', device: deviceName(), version: '', build: '', os: navigator.userAgent.slice(0, 64) });

  async function sendBundle() {
    setBusy(true);
    setSent(null);
    try {
      const r = await api.sendClientLog({ client: client(), note: note.trim() || undefined, entries: picked });
      setSent(r.file);
      setNote('');
      setStatus(await api.logging().catch(() => status));
    } catch (e) {
      showError(e, "Couldn't send this device's log");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const w = window();
    const blob = new Blob([asJsonl(picked, { ...client(), note: note.trim() || undefined, from: w.from ? new Date(w.from).toISOString() : undefined, to: w.to ? new Date(w.to).toISOString() : undefined })], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ah-log-${deviceName().replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  async function clear() {
    if (!(await askConfirm({ title: "Clear this device's log?", body: 'Everything it kept is deleted from this browser. Bundles already sent stay on the host.', confirm: 'Clear', danger: true }))) return;
    clientLog.clear();
  }

  return (
    <div className="sec-card">
      <h2>Developer</h2>
      <p className="hint">Logs for finding out what went wrong: what was sent, the requests made and the ones that failed, restarts and errors. Each is off until you turn it on.</p>
      <h3 className="log-part">This host</h3>
      <label className="search-toggle">
        <input type="checkbox" switch="" checked={!!status?.server} disabled={busy || !status} onChange={(e) => void setHost(e.target.checked)} />
        <span>Keep a log on this host</span>
      </label>
      <p className="hint">
        A folder a day; folders older than the last {status?.keepDays ?? 3} days are deleted. It holds the messages sent (their words, and their attachments' sizes but never the
        files), every request, the queue, restarts and errors. Never passwords, tokens or cookies.
      </p>
      {status && (
        <div className="bind-line">
          <code className="mono">{status.dir}</code>
          <button className="btn small ghost" onClick={() => void copyText(status.dir)}>
            Copy
          </button>
        </div>
      )}
      {!!status?.days.length && (
        <ul className="hook-status">
          {status.days.map((d) => (
            <li key={d.day}>
              {d.day}: {d.files.length === 1 ? '1 file' : `${d.files.length} files`}, {kb(d.files.reduce((n, f) => n + f.bytes, 0))}
            </li>
          ))}
        </ul>
      )}
      <h3 className="log-part">This device</h3>
      <label className="search-toggle">
        <input type="checkbox" switch="" checked={mine} onChange={(e) => clientLog.set(e.target.checked)} />
        <span>Keep a log on this device</span>
      </label>
      <p className="hint">Kept in this browser for 3 days: messages sent and their attachments' sizes, each request and why one failed, the live connection dropping, errors.</p>
      {(mine || count > 0) && (
        <>
          <div className="seg" role="radiogroup" aria-label="Time to include">
            {SPANS.map((o) => (
              <button key={o.id} role="radio" aria-checked={span === o.id} aria-label={o.name} title={o.name} className={span === o.id ? 'on' : ''} onClick={() => setSpan(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
          {span === 'range' && (
            <div className="log-range">
              <label className="field">
                <span>From</span>
                <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field">
                <span>To</span>
                <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
          )}
          <p className="hint">
            {badRange ? 'The range ends before it starts.' : `${picked.length.toLocaleString()} of ${count.toLocaleString()} entries in this time.`}
          </p>
          <label className="field log-note">
            <span>Note</span>
            <textarea rows={2} placeholder="What went wrong? Optional; it goes with the bundle." value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {sent && (
            <>
              <p className="hint">Sent. An agent on this host can read it at:</p>
              <div className="bind-line">
                <code className="mono">{sent}</code>
                <button className="btn small ghost" onClick={() => void copyText(sent)}>
                  Copy
                </button>
              </div>
            </>
          )}
          <div className="system-actions">
            <button className="btn primary" disabled={busy || badRange || !picked.length} onClick={() => void sendBundle()}>
              Send to host
            </button>
            <button className="btn" disabled={badRange || !picked.length} onClick={download}>
              Download
            </button>
            <button className="btn" disabled={!count} onClick={() => void clear()}>
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}
