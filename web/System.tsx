import { useState } from 'react';
import { api } from './api.ts';
import { askConfirm, showError } from './ask.tsx';

// Settings → System: host-level actions. A restart bounces the daemon while
// tmux and the sessions keep running; this page reconnects on its own.
export function SystemPanel() {
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);

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
      setRestarting(true);
    } catch (e) {
      showError(e, "Couldn't restart the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sec-card">
      <h2>Server</h2>
      <p className="hint">Restart the ah server on this host after updating it or changing its config. Your sessions keep running, and this page reconnects by itself.</p>
      {restarting && <p className="panel-msg">Restarting… this page reconnects when the server is back.</p>}
      <button className="btn" disabled={busy || restarting} onClick={() => void restart()}>
        Restart server
      </button>
    </div>
  );
}
