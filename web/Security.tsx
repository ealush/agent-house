import { useEffect, useState } from 'react';
import { authApi, explain, passkeysAvailable, type Overview } from './auth.ts';
import { age } from './agents.ts';

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
};

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

  return (
    <div className="page security">
      <header className="page-head">
        <div className="grow">
          <h1>Security</h1>
          <p>
            Tailscale decides which devices can reach ah; signing in decides who can use it. Devices sign out after {o?.idleHours ?? '…'}h unused, and after {o?.maxDays ?? '…'} days
            regardless.
          </p>
        </div>
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
      </header>

      {error && <p className="form-error">{error}</p>}
      {notice && <p className="hint">{notice}</p>}

      <h2 className="section-label first">Add a device</h2>
      <div className="sec-card">
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
      </div>

      <h2 className="section-label">Passkeys</h2>
      <ul className="rows">
        {o?.passkeys.map((p) => (
          <li key={p.id} className="sec-row">
            <span className="stack">
              <span className="name">{p.label}</span>
              <span className="sub">
                {p.rpID} · added {age(sec(p.createdAt))} · used {age(sec(p.lastUsedAt))}
              </span>
            </span>
            <button className="btn ghost small danger" onClick={() => confirm(`Remove passkey "${p.label}"?`) && act(() => authApi.removePasskey(p.id))}>
              Remove
            </button>
          </li>
        ))}
        {o && !o.passkeys.length && <li className="sec-row hint">No passkeys yet.</li>}
      </ul>

      <h2 className="section-label">
        <span className="grow">Signed-in devices</span>
      </h2>
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
      </ul>
      {o && o.sessions.length > 1 && (
        <p>
          <button className="btn small" onClick={() => confirm('Sign out every other device?') && act(() => authApi.signOutEverywhere(), 'Every other device was signed out.')}>
            Sign out everywhere else
          </button>
        </p>
      )}

      {!!o?.tokens.length && (
        <>
          <h2 className="section-label">Hosts that can reach this one</h2>
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
        </>
      )}

      <h2 className="section-label">Master password</h2>
      <p className="hint">
        {o?.password ? 'Set. ' : 'Not set. '}A fallback for browsers without passkeys; it can only be set or removed on the host: <code>node bin/ah.js auth password</code>.
      </p>

      <h2 className="section-label">Recent activity</h2>
      <ul className="rows audit">
        {o?.audit.map((a, i) => (
          <li key={i} className="sec-row">
            <span className={`stack ${a.event === 'auth.failed' ? 'bad' : ''}`}>
              <span className="name">{EVENT_TEXT[a.event] ?? a.event}</span>
              <span className="sub">{[a.device, a.label, a.via, a.reason, a.from, a.by].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="when">{age(sec(Date.parse(a.at)))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
