import { useEffect, useState } from 'react';
import type { HostApi, PreviewInfo } from './api.ts';
import { showError } from './ask.tsx';
import { Icon } from './icons.tsx';

/**
 * The session's dev server in a browser pane (server/preview.ts). It runs on the
 * host; ah proxies it on a port of its own, behind the same sign-in, so the page
 * loads the same from a phone as from the host. Ports the session's processes
 * listen on are offered; any other can be typed.
 */
export function PreviewPanel({ client, uid }: { client: HostApi; uid: string }) {
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const load = () =>
    client
      .preview(uid)
      .then(setInfo)
      .catch(() => {});
  useEffect(() => {
    void load();
    // A dev server takes a moment to start listening; keep the suggestions fresh.
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, uid]);

  const start = async (target: number) => {
    setBusy(true);
    try {
      await client.startPreview(uid, target);
      await load();
      setReload((n) => n + 1);
    } catch (e) {
      showError(e, "Couldn't start the preview");
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    try {
      await client.stopPreview(uid);
      await load();
    } catch (e) {
      showError(e, "Couldn't stop the preview");
    }
  };

  // Previews are served by the host that runs the session, on its own address.
  if (client.base) {
    return (
      <div className="preview-panel">
        <p className="hint preview-empty">Previews work for sessions on this host for now.</p>
      </div>
    );
  }
  if (!info) return <div className="preview-panel"><p className="hint preview-empty">Loading…</p></div>;

  const p = info.preview;
  const url = p ? `${location.protocol}//${location.hostname}:${p.port}/` : '';
  const others = info.ports.filter((port) => port !== p?.target);

  const picker = (
    <form
      className="preview-pick"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(typed);
        if (Number.isInteger(n) && n > 0 && n < 65536) void start(n);
      }}
    >
      {info.ports.length > 0 && (
        <div className="preview-ports">
          {(p ? others : info.ports).map((port) => (
            <button key={port} type="button" className="btn small" disabled={busy} onClick={() => start(port)}>
              localhost:{port}
            </button>
          ))}
        </div>
      )}
      <label className="field preview-port">
        <span>Port</span>
        <input inputMode="numeric" placeholder="6006" value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))} />
      </label>
      <button type="submit" className="btn small primary" disabled={busy || !typed}>
        Preview
      </button>
    </form>
  );

  if (!p) {
    return (
      <div className="preview-panel">
        <div className="preview-empty">
          <Icon name="globe" size={22} />
          <p>Preview a dev server running in this session (Storybook, Vite, Next…). It runs on the host and shows here, on any device.</p>
          {!info.live && <p className="hint">The session isn’t running.</p>}
          {info.live && !info.ports.length && <p className="hint">Nothing in this session is listening on a port yet. Start the dev server, or type its port.</p>}
          {info.live && picker}
        </div>
      </div>
    );
  }

  return (
    <div className="preview-panel live">
      <div className="preview-bar">
        <button type="button" className="icon-btn small" title="Reload" aria-label="Reload" onClick={() => setReload((n) => n + 1)}>
          <Icon name="reload" size={15} />
        </button>
        <span className="preview-url mono" title={`localhost:${p.target} on the host, shown through ${url}`}>
          localhost:{p.target}
        </span>
        {others.length > 0 && (
          <select className="preview-switch" aria-label="Preview another port" value="" onChange={(e) => e.target.value && void start(Number(e.target.value))}>
            <option value="">Switch…</option>
            {others.map((port) => (
              <option key={port} value={port}>
                localhost:{port}
              </option>
            ))}
          </select>
        )}
        <a className="icon-btn small" href={url} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open in a new tab">
          <Icon name="external" size={15} />
        </a>
        <button type="button" className="icon-btn small" title="Stop the preview (the dev server keeps running)" aria-label="Stop the preview" onClick={stop}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <iframe
        key={`${p.port}:${p.target}:${reload}`}
        className="preview-frame"
        src={url}
        title={`Preview of localhost:${p.target}`}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
}
