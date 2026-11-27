import { useEffect, useState } from 'react';
import { api, type Harnesses } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import { age, look } from './agents.ts';
import { errorText } from './errors.ts';
import { AgentLogo } from './logos.tsx';

const ANOTHER = '';

// Settings → Agents (server/harnesses.ts): every agent this host knows, which of them
// New session offers, and what each CLI's installed version said when last asked. A
// CLI that updates is read again (its --help), so new permission modes and effort
// levels show up without waiting for ah to learn them. Any other agent CLI on this
// host can be added by its command.
export function AgentsPanel() {
  const [data, setData] = useState<Harnesses | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState(ANOTHER);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');

  useEffect(() => {
    api
      .harnesses()
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);

  async function act(what: string, fn: () => Promise<Harnesses>, fail: string) {
    setBusy(what);
    try {
      setData(await fn());
      setError(null);
      return true;
    } catch (e) {
      showError(e, fail);
      return false;
    } finally {
      setBusy(null);
    }
  }

  // The switch moves at once; the host's answer (or the error, and the old state) follows.
  async function show(id: string, on: boolean) {
    const before = data;
    setData((d) => d && { ...d, agents: d.agents.map((x) => (x.id === id ? { ...x, hidden: !on } : x)) });
    if (!(await act(id, () => api.setHarnessHidden(id, !on), "Couldn't change it"))) setData(before);
  }

  async function bridge(on: boolean) {
    const before = data;
    setData((d) => d && { ...d, agents: d.agents.map((x) => (x.id === 'pi' ? { ...x, bridge: on } : x)) });
    if (!(await act('pi', () => api.setPiBridge(on), "Couldn't change it"))) setData(before);
  }

  const choose = (value: string) => {
    setPick(value);
    const s = data?.suggestions.find((x) => x.command === value);
    setName(s?.name ?? '');
    setCommand(s?.command ?? '');
  };

  async function add() {
    if (await act('add', () => api.addHarness({ name: name.trim(), command: command.trim() }), "Couldn't add the agent")) choose(ANOTHER);
  }

  const agents = data?.agents ?? [];
  const checked = agents.map((a) => a.checkedAt ?? 0).reduce((a, b) => Math.max(a, b), 0);

  return (
    <div className="system-panels">
      <section className="sec-card">
        <h2>Agents</h2>
        <p className="hint">
          New session offers the agents installed on this host. ah asks each one its version, and when it updates, reads what the new version offers: new permission
          modes and effort levels show up, and ones it dropped go.
        </p>
        {error && <p className="form-error">{error}</p>}
        {!data && !error && <p className="hint">Loading…</p>}
        {agents.length > 0 && (
          <ul className="rows agent-rows">
            {agents.map((a) => [
              <li key={a.id} className={`sec-row ${a.installed ? '' : 'absent'}`}>
                <span className="chip" style={{ '--agent': look(a.id).color } as React.CSSProperties}>
                  <AgentLogo id={a.id} size={16} />
                </span>
                <span className="stack">
                  <span className="name">{a.name}</span>
                  <span className="sub">
                    {a.installed ? [a.version ?? a.command, a.custom ? 'added here' : null].filter(Boolean).join(' · ') : `Not installed (${a.command.split(/\s+/)[0]})`}
                  </span>
                  {a.installed && a.changes.length > 0 && <span className="sub changes">{a.changes.join(' · ')}</span>}
                </span>
                {a.installed && (
                  <label className="agent-shown">
                    <input type="checkbox" switch="" checked={!a.hidden} disabled={busy === 'check' || busy === 'add'} onChange={(e) => void show(a.id, e.target.checked)} />
                    <span>New session</span>
                  </label>
                )}
                {a.custom && (
                  <button
                    className="btn ghost small danger"
                    disabled={!!busy}
                    onClick={() =>
                      void askConfirm({ title: `Remove ${a.name}?`, body: 'New session stops offering it. Sessions already running keep running.', confirm: 'Remove', danger: true }).then(
                        (ok) => ok && act(a.id, () => api.removeHarness(a.id), "Couldn't remove it"),
                      )
                    }
                  >
                    Remove
                  </button>
                )}
              </li>,
              // pi's bridge (experimental, docs/pi-bridge.md): a setting of pi's, in a row under it.
              a.installed && a.bridge !== undefined && (
                <li key={`${a.id}-bridge`} className="sec-row agent-bridge">
                  <span className="stack">
                    <span className="name">
                      Bridge <span className="experimental">Experimental</span>
                    </span>
                    <span className="sub">
                      Messages, Stop and approvals go to pi itself instead of being typed into its screen, and pi asks before commands and edits. For new sessions; running
                      ones keep what they started with.
                    </span>
                  </span>
                  <label className="agent-shown">
                    <input type="checkbox" switch="" checked={a.bridge} disabled={!!busy} onChange={(e) => void bridge(e.target.checked)} />
                    <span>Bridge</span>
                  </label>
                </li>
              ),
            ])}
          </ul>
        )}
        {data && (
          <div className="system-actions agents-check">
            <button className="btn" disabled={!!busy} onClick={() => void act('check', () => api.checkHarnesses(), "Couldn't check the agents")}>
              {busy === 'check' ? 'Checking…' : 'Check for updates'}
            </button>
            {checked > 0 && <span className="hint">Last checked {age(checked / 1000)}.</span>}
          </div>
        )}
      </section>

      <section className="sec-card">
        <h2>Add an agent</h2>
        <p className="hint">
          Any agent CLI on this host can run in a session: ah starts it in a terminal and keeps track of it like the others, without the GUI view, which needs ah to
          know its transcripts.
        </p>
        <form
          className="add-agent"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="field">
            <span>Agent</span>
            <select value={pick} onChange={(e) => choose(e.target.value)}>
              {data?.suggestions.map((s) => (
                <option key={s.command} value={s.command}>
                  {s.name} (on this host)
                </option>
              ))}
              <option value={ANOTHER}>Another command…</option>
            </select>
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aider" maxLength={40} />
          </label>
          <label className="field">
            <span>Command</span>
            <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="aider --no-auto-commits" maxLength={200} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          <button className="btn primary" disabled={!!busy || !name.trim() || !command.trim()}>
            {busy === 'add' ? 'Adding…' : 'Add agent'}
          </button>
        </form>
      </section>
    </div>
  );
}
