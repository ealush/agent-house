import { useEffect, useState } from 'react';
import { askConfirm } from './ask.tsx';
import { authApi, explain, passkeysAvailable, type Overview } from './auth.ts';
import { age } from './agents.ts';
import { api, deviceName, platformName, setDeviceName } from './api.ts';

const sec = (ms: number) => Math.floor(ms / 1000);

const EVENT_TEXT: Record<string, string> = {
  'auth.signin': 'Signed in',
  'auth.signout': 'Signed out',
  'auth.failed': 'Failed sign-in',
  'auth.passkey_added': 'Passkey added',
  'auth.passkey_removed': 'Passkey removed',
  'auth.code_issued': 'Setup code issued',
  'auth.password_set': 'Master password set',
  'auth.password_removed': 'Master password removed',
  'auth.token_created': 'Host token created',
  'auth.token_removed': 'Host token revoked',
  'session.create': 'Started a session',
  'session.resume': 'Resumed a session',
  'session.kill': 'Terminated a session',
  'session.send': 'Sent a message',
  'session.approve': 'Approved a prompt',
  'session.deny': 'Denied a prompt',
  'session.choose': 'Answered a prompt',
  'session.questions': "Answered an agent's questions",
  'session.interrupt': 'Stopped a turn',
  'session.fork': 'Forked a session',
  'session.relaunch': 'Relaunched a session',
  'session.settings': 'Changed model or effort',
  'session.switch': 'Switched branch',
  'session.branch': 'Created a branch',
  'file.upload': 'Uploaded a file',
  'snapshot.restore': 'Restored a snapshot',
  'snapshot.toggle': 'Turned snapshots on or off',
  'preview.start': 'Started a preview',
  'preview.stop': 'Stopped a preview',
  'prompts.clear': 'Cleared prompt history',
  'search.rebuild': 'Rebuilt the search index',
  'subscription.save': 'Saved a chat subscription',
  'subscription.remove': 'Removed a chat subscription',
  'subscription.default': 'Changed the default subscription',
  'system.restart': 'Restarted the server',
  'system.rebuild': 'Rebuilt and restarted',
  'system.uploads.clear': 'Cleared the uploads folder',
  'system.hooks.install': 'Installed agent hooks',
  'system.hooks.uninstall': 'Removed agent hooks',
  'system.desktop.install': 'Added ah to the app launcher',
  'system.desktop.uninstall': 'Removed ah from the app launcher',
  'worktree.remove': 'Removed a worktree',
};

/** Anything not named above still reads as words: "worktree.remove-bulk" → "Worktree remove bulk". */
const eventText = (e: string) => EVENT_TEXT[e] ?? (e.charAt(0).toUpperCase() + e.slice(1)).replace(/[._-]+/g, ' ');

/** Who can get in, from where, and what happened lately. */
export function Security({ onLocked }: { onLocked: () => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    authApi
      .overview()
      .then(setO)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setError(explain(e));
    }
    load();
  }

  const pk = passkeysAvailable();
  const current = o?.sessions.find((s) => s.current);
  // Sign-in turned off in the host's config: passkeys, devices and locking mean nothing.
  const signin = o?.enabled !== false;
  const [name, setName] = useState(deviceName);

  return (
    <div className="security">
      {/* Settings is the page; this is its first section, introduced in a line. */}
      <div className="settings-intro">
        {signin ? (
          <>
            <p className="hint">
              Tailscale decides which devices can reach ah; signing in decides who can use it. Devices sign out after {o?.idleHours ?? '…'}h unused, and after {o?.maxDays ?? '…'} days
              regardless.
            </p>
            <button
              className="btn"
              onClick={() =>
                act(async () => {
                  await authApi.signOut();
                  onLocked();
                })
              }
            >
              Lock now
            </button>
          </>
        ) : (
          <p className="hint">
            Sign-in is off on this host (<code>"auth": {'{'} "mode": "off" {'}'}</code> in its config), so anyone who can reach ah gets a shell. Remove that line and restart ah to require passkeys again.
          </p>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {notice && <p className="hint">{notice}</p>}

      <section className="sec-card">
        <h2>This device</h2>
        <p className="hint">Other devices call it this: in “Continue from …”, on a draft you started here, and when it is viewing a session.</p>
        <form
          className="device-name"
          onSubmit={(e) => {
            e.preventDefault();
            setDeviceName(name);
            setName(deviceName());
            setNotice('Device renamed.');
          }}
        >
          <label className="field">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={platformName()} aria-label="Device name" maxLength={40} autoCapitalize="words" />
          </label>
          <button className="btn" disabled={name.trim() === deviceName()}>Rename</button>
        </form>
      </section>

      {signin && (
      <>
      <section className="sec-card">
        <h2>Add a device</h2>
        {code && code.until > Date.now() ? (
          <>
            <div className="big-code">{code.code}</div>
            <p className="hint">On the new device, open ah and enter this code within 10 minutes. It works once.</p>
          </>
        ) : (
          <>
            <p className="hint">Creates a one-time setup code for another phone, tablet or computer. Passkeys synced through iCloud or Google work without one.</p>
            <button className="btn primary" onClick={() => act(async () => {
              const c = await authApi.newCode();
              setCode({ code: c.code, until: Date.now() + c.ttlMinutes * 60_000 });
            })}>
              Create setup code
            </button>
          </>
        )}
        {current?.via === 'password' && pk.ok && (
          <button className="btn" onClick={() => act(() => authApi.addPasskey(), 'Passkey added for this device.')}>
            Add a passkey on this device
          </button>
        )}
      </section>

      <section className="sec-card">
      <h2>Passkeys</h2>
      <ul className="rows">
        {o?.passkeys.map((p) => (
          <li key={p.id} className="sec-row">
            <span className="stack">
              <span className="name">{p.label}</span>
              <span className="sub">
                {p.rpID} · added {age(sec(p.createdAt))} · used {age(sec(p.lastUsedAt))}
              </span>
            </span>
            <button
              className="btn ghost small danger"
              onClick={() =>
                void askConfirm({
                  title: `Remove passkey "${p.label}"?`,
                  body: 'It can no longer be used to sign in.',
                  confirm: 'Remove',
                  danger: true,
                }).then((ok) => {
                  if (ok) void act(() => authApi.removePasskey(p.id));
                })
              }
            >
              Remove
            </button>
          </li>
        ))}
        {o && !o.passkeys.length && <li className="sec-row hint">No passkeys yet.</li>}
      </ul>
      </section>

      <section className="sec-card">
      <h2>Signed-in devices</h2>
      <ul className="rows">
        {o?.sessions.map((s) => (
          <li key={s.id} className="sec-row">
            <span className="stack">
              <span className="name">
                {s.label} {s.current && <span className="pill attention">this device</span>}
              </span>
              <span className="sub">
                via {s.via} · signed in {age(sec(s.createdAt))} · last seen {age(sec(s.lastSeenAt))}
              </span>
            </span>
            {!s.current && (
              <button className="btn ghost small danger" onClick={() => act(() => authApi.revoke(s.id), `Signed out ${s.label}.`)}>
                Sign out
              </button>
            )}
          </li>
        ))}
        {o && !o.sessions.length && <li className="sec-row hint">No signed-in devices (sign-in is off).</li>}
      </ul>
      {o && o.sessions.length > 1 && (
        <p>
          <button
            className="btn small"
            onClick={() =>
              void askConfirm({
                title: 'Sign out every other device?',
                body: 'Those devices will need to sign in again.',
                confirm: 'Sign out',
                danger: true,
              }).then((ok) => {
                if (ok) void act(() => authApi.signOutEverywhere(), 'Every other device was signed out.');
              })
            }
          >
            Sign out everywhere else
          </button>
        </p>
      )}
      </section>

      {!!o?.tokens.length && (
        <section className="sec-card">
          <h2>Hosts that can reach this one</h2>
          <ul className="rows">
            {o.tokens.map((t) => (
              <li key={t.id} className="sec-row">
                <span className="stack">
                  <span className="name">{t.name}</span>
                  <span className="sub">
                    issued {age(sec(t.createdAt))} · {t.lastUsedAt ? `used ${age(sec(t.lastUsedAt))}` : 'never used'}
                  </span>
                </span>
                <button className="btn ghost small danger" onClick={() => act(() => authApi.removeToken(t.id))}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sec-card">
        <h2>Master password</h2>
        <p className="hint">
          {o?.password ? 'Set. ' : 'Not set. '}A fallback for browsers without passkeys; it can only be set or removed on the host: <code>node bin/ah.js auth password</code>.
        </p>
      </section>

      </>
      )}

      <section className="sec-card">
        <h2>Prompt history</h2>
        <p className="hint">
          Recently sent messages are kept on the host (for “recent prompts”) and may contain anything you pasted. Set <code>promptHistory</code> to 0 in the config to keep none.
        </p>
        <button
          className="btn small"
          onClick={() =>
            void askConfirm({
              title: 'Delete the saved prompt history?',
              body: 'Recently sent messages kept on this host will be removed.',
              confirm: 'Delete',
              danger: true,
            }).then((ok) => {
              if (ok) void act(() => api.clearPrompts(), 'Prompt history cleared.');
            })
          }
        >
          Clear prompt history
        </button>
      </section>

      <section className="sec-card">
      <h2>Recent activity</h2>
      <ul className="rows audit">
        {o?.audit.map((a, i) => (
          <li key={i} className="sec-row">
            <span className={`stack ${a.event === 'auth.failed' ? 'bad' : ''}`}>
              <span className="name">{eventText(a.event)}</span>
              <span className="sub">{[a.device, a.label, a.via, a.reason, a.from, a.by].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="when">{age(sec(Date.parse(a.at)))}</span>
          </li>
        ))}
      </ul>
      {o && !o.audit.length && <p className="hint">Nothing yet. Sign-ins, failures and session actions show here.</p>}
      </section>
    </div>
  );
}
