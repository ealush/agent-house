import { useEffect, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { look } from './agents.ts';
import { api, type EnvState, type EnvVar } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import { errorText } from './errors.ts';

// Session environment (server/env.ts): variables every session window starts
// with, and chat subscriptions whose key sessions get too. A running process
// keeps the environment it started with, so the sessions that predate a
// change are listed with a restart.
/** hint: a stored secret, masked, shown in the empty value field while editing. */
type Form = { editing: boolean; name: string; value: string; hint: string; secret: boolean; secretTouched: boolean };

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH/i;

export function EnvironmentPanel() {
  const [state, setState] = useState<EnvState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState<Set<string>>(new Set());

  const load = () =>
    api.env().then(
      (s) => {
        setState(s);
        setError(null);
      },
      (e) => setError(e.message),
    );
  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!form || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveEnv({ name: form.name.trim(), secret: form.secret, ...(form.value || !form.editing ? { value: form.value } : {}) });
      setForm(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: EnvVar) {
    if (!(await askConfirm({ title: `Remove ${v.name}?`, body: 'Sessions started from now on go without it. Running ones keep it until they restart.', confirm: 'Remove', danger: true }))) return;
    try {
      await api.removeEnv(v.name);
      await load();
    } catch (e) {
      showError(e, "Couldn't remove the variable");
    }
  }

  async function restart(uid: string) {
    setRestarting((s) => new Set(s).add(uid));
    try {
      await api.relaunch(uid, {});
      await load();
    } catch (e) {
      showError(e, "Couldn't restart the session");
    } finally {
      setRestarting((s) => {
        const next = new Set(s);
        next.delete(uid);
        return next;
      });
    }
  }

  // One at a time: each restart stops and resumes a conversation.
  async function restartAll(uids: string[]) {
    for (const uid of uids) await restart(uid);
  }

  const empty = state && !state.vars.length && !state.exports.length;
  const ready = state?.stale.filter((s) => !s.restart) ?? [];

  return (
    <div className="env-panels">
      <div className="sec-card" data-confirm>
        <h2>Session environment</h2>
        <p className="hint">
          Every session ah starts on this host gets these variables: new sessions, resumes and restarts. Use them for keys and settings your agents' tools need, like an
          image API key for a CLI the agent runs. Secret values stay on this host, alongside ah's other secrets, and once saved show only their first and last few characters.
        </p>
        {error && <p className="form-error">{error}</p>}
        {!state && !error && <p className="hint">Loading…</p>}
        {empty && !form && <p className="hint">No variables yet.</p>}
        {state && !empty && (
          <ul className="worktrees">
            {state.vars.map((v) => (
              <li key={v.name}>
                <div className="stack">
                  <span className="mono">{v.name}</span>
                  <span className="sub env-value">
                    {v.secret ? (
                      <>
                        Secret · <span className="mono">{v.hint}</span>
                      </>
                    ) : v.value ? (
                      <span className="mono">{v.value}</span>
                    ) : (
                      'Empty'
                    )}
                  </span>
                </div>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => setForm({ editing: true, name: v.name, value: v.value ?? '', hint: v.hint ?? '', secret: v.secret, secretTouched: true })}
                >
                  Edit
                </button>
                <button className="btn ghost small danger" disabled={busy} onClick={() => remove(v)}>
                  Delete
                </button>
              </li>
            ))}
            {state.exports.map((x) => (
              <li key={x.name}>
                <div className="stack">
                  <span className="mono">{x.name}</span>
                  <span className="sub">Key of the “{x.subscription}” subscription</span>
                </div>
                <button className="btn small" onClick={() => (location.hash = 'settings/subscriptions')}>
                  Edit
                </button>
              </li>
            ))}
          </ul>
        )}
        {form ? (
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input
                value={form.name}
                disabled={busy || form.editing}
                maxLength={128}
                placeholder="OPENAI_API_KEY"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm({ ...form, name, secret: form.secretTouched ? form.secret : SECRET_NAME.test(name) });
                }}
              />
            </label>
            <label className="field">
              <span>Value</span>
              <input
                type={form.secret ? 'password' : 'text'}
                value={form.value}
                disabled={busy}
                maxLength={8192}
                placeholder={(form.secret && form.hint) || undefined}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
              {form.secret && form.hint && <small className="field-hint">Saved. Type a new value to replace it.</small>}
            </label>
          </div>
        ) : (
          <button className="btn small" onClick={() => setForm({ editing: false, name: '', value: '', hint: '', secret: false, secretTouched: false })}>
            Add variable
          </button>
        )}
        {form && (
          <>
            <label className="check">
              <input type="checkbox" disabled={busy} checked={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.checked, secretTouched: true })} />
              <span>Secret: hide the value once saved</span>
            </label>
            <div className="actions">
              <button className="btn ghost small" disabled={busy} onClick={() => setForm(null)}>
                Cancel
              </button>
              <ConfirmButton className="btn primary small" disabled={busy || !form.name.trim()} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </ConfirmButton>
            </div>
          </>
        )}
      </div>

      {state && state.stale.length > 0 && (
        <div className="sec-card">
          <h2>Running sessions</h2>
          <p className="hint">
            {state.stale.length === 1 ? 'This session started' : 'These sessions started'} before the last change and still {state.stale.length === 1 ? 'has' : 'have'}{' '}
            the old values. Restarting resumes the same conversation in a fresh process. Shells pick up changes in new windows.
          </p>
          <ul className="worktrees">
            {state.stale.map((s) => (
              <li key={s.uid}>
                <div className="stack">
                  <span>{s.title}</span>
                  <span className="sub">
                    {look(s.agent).name}
                    {s.restart ? ` · ${s.restart}` : ''}
                  </span>
                </div>
                <button className="btn small" disabled={!!s.restart || restarting.has(s.uid)} onClick={() => restart(s.uid)}>
                  {restarting.has(s.uid) ? 'Restarting…' : 'Restart'}
                </button>
              </li>
            ))}
          </ul>
          {ready.length > 1 && (
            <button className="btn small" disabled={restarting.size > 0} onClick={() => void restartAll(ready.map((s) => s.uid))}>
              Restart {ready.length} idle sessions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
