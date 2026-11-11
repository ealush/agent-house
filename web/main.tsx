import { Component, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AskHost } from './ask.tsx';
import { Lock } from './Lock.tsx';
import { authApi, type AuthStatus } from './auth.ts';
import { openStateEarly, setUnauthorizedHandler } from './api.ts';
import { initTheme } from './theme.ts';
import { confirmKey } from './confirm.ts';
import { installSlide } from './slide.ts';
import { installEdges } from './edges.ts';
import { installHardwareKeyboard } from './hardwareKeyboard.ts';
import { installWindowControls } from './windowControls.ts';
import { installPointer } from './pointer.ts';
import { installSwitch } from './switch.ts';

initTheme();
// Every segmented control and toggle slides under a finger, as on iOS (slide.ts).
installSlide();
// The screen's side edges swipe ah's way, never the browser's Back on top of it (edges.ts).
installEdges();
installHardwareKeyboard();
installWindowControls();
// Hover is the trackpad's and the Pencil's, never a finger's tap left behind (pointer.ts).
installPointer();
installSwitch();
// ⌘↵ / Ctrl+↵ presses the main button, signed in or on the lock screen (confirm.ts).
window.addEventListener('keydown', confirmKey);
// Fonts ship with the app: nothing loads from third parties.
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/rubik';
import './tokens.css';
import './styles.css';
import './site-theme.css';

/** A crash shows what happened and a way out, never a blank screen. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <h1>Something broke</h1>
        <p className="hint">If you just updated ah, restart the server (pnpm serve) and reload.</p>
        <pre className="ask-box code">{String(this.state.error.stack ?? this.state.error)}</pre>
        <p>
          <button className="btn light" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      </div>
    );
  }
}

/**
 * Nothing of the app mounts (no state stream, no terminals) until this device is
 * signed in. Any 401 later (expired, revoked, locked elsewhere) comes back here.
 */
function Gate() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const check = () =>
    authApi
      .status()
      .then(setStatus)
      // An older server without auth routes: nothing to gate.
      .catch(() => setStatus({ enabled: false, enrolled: true, authenticated: true, password: false }));

  useEffect(() => {
    check();
    setUnauthorizedHandler(check);
    window.addEventListener('ah:unauthorized', check);
    return () => window.removeEventListener('ah:unauthorized', check);
  }, []);

  if (!status) return null;
  if (status.enabled && !status.authenticated) return <Lock status={status} onUnlocked={check} />;
  return <App onLock={check} />;
}

// The state stream and the sign-in check set off together: the app mounts on the check, and
// finds its first state already on the way (or here).
openStateEarly();

createRoot(document.getElementById('root')!).render(
  <Boundary>
    <AskHost />
    <Gate />
  </Boundary>,
);
