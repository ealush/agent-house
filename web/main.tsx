import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

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

createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>,
);
