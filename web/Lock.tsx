import { useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { authApi, explain, passkeysAvailable, type AuthStatus } from './auth.ts';
import { AhMark } from './icons.tsx';

/**
 * Shown until this device is signed in. Passkey first; a host-issued setup code to
 * enroll a new device; the master password only if one was set on the host.
 */
export function Lock({ status, onUnlocked }: { status: AuthStatus; onUnlocked: () => void }) {
  const pk = passkeysAvailable();
  const [mode, setMode] = useState<'passkey' | 'code' | 'password'>(status.enrolled ? (pk.ok ? 'passkey' : status.password ? 'password' : 'code') : 'code');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onUnlocked();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock" data-confirm>
      <div className="lock-card">
        <div className="brand">
          <span className="logo"><AhMark /></span>
          <span className="brand-name">ah</span>
        </div>

        {mode === 'passkey' && (
          <>
            <h1>Unlock</h1>
            <p className="hint">Use the passkey you created for ah on this device or one synced to it.</p>
            <ConfirmButton className="btn primary big" disabled={busy} onClick={() => run(() => authApi.signIn())}>
              {busy ? 'Waiting for passkey…' : 'Unlock with passkey'}
            </ConfirmButton>
          </>
        )}

        {mode === 'code' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => authApi.addPasskey(code));
            }}
          >
            <h1>{status.enrolled ? 'Add this device' : 'Set up ah'}</h1>
            <p className="hint">
              Enter a one-time setup code from the host: it's printed when the server starts, or run <code>node bin/ah.js auth code</code> there. A signed-in device can
              also make one under Security.
            </p>
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXXX-XXXXX"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              spellCheck={false}
              autoFocus
            />
            {pk.ok ? (
              <ConfirmButton className="btn primary big" disabled={busy || code.replace(/[^A-Z0-9]/gi, '').length < 10}>
                {busy ? 'Creating passkey…' : 'Create a passkey'}
              </ConfirmButton>
            ) : (
              <p className="form-error">{pk.why}</p>
            )}
          </form>
        )}

        {mode === 'password' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => authApi.passwordSignIn(password));
            }}
          >
            <h1>Unlock</h1>
            <input className="code-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Master password" autoComplete="current-password" autoFocus />
            <ConfirmButton className="btn primary big" disabled={busy || !password}>
              {busy ? 'Checking…' : 'Unlock'}
            </ConfirmButton>
          </form>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="lock-alt">
          {status.enrolled && mode !== 'passkey' && pk.ok && (
            <button className="linkish" onClick={() => setMode('passkey')}>
              Use a passkey
            </button>
          )}
          {status.enrolled && mode !== 'code' && (
            <button className="linkish" onClick={() => setMode('code')}>
              New device? Use a setup code
            </button>
          )}
          {status.password && mode !== 'password' && (
            <button className="linkish" onClick={() => setMode('password')}>
              Use master password
            </button>
          )}
        </div>
        {!pk.ok && <p className="hint">{pk.why}</p>}
      </div>
    </div>
  );
}
