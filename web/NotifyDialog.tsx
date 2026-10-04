import { useEffect, useRef, useState } from 'react';
import { disablePush, enablePush, pushStatus, pushSupport, type PushEvents } from './notify.ts';

// Per-device notification opt-in (F25). Push arrives even when ah isn't open.
export function NotifyDialog({ onClose, onChange }: { onClose: () => void; onChange: (active: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const support = pushSupport();
  const [events, setEvents] = useState<PushEvents>({ waiting: false, done: false });
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    if (support === 'ok')
      pushStatus()
        .then((e) => {
          if (e) setEvents(e);
          setActive(!!e);
        })
        .catch(() => {});
  }, []);

  async function save(next: PushEvents) {
    setBusy(true);
    setError(null);
    try {
      if (next.waiting || next.done) await enablePush(next);
      else await disablePush();
      setEvents(next);
      setActive(next.waiting || next.done);
      onChange(next.waiting || next.done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <form method="dialog">
        <h2>Notifications on this device</h2>
        {support === 'insecure' && (
          <p className="hint">Push needs HTTPS. Open ah through <code>pnpm serve</code> (your *.ts.net address) to enable it.</p>
        )}
        {support === 'unsupported' && (
          <p className="hint">This browser can't receive push. On iPhone/iPad, use Share → Add to Home Screen and open ah from there.</p>
        )}
        {support === 'ok' && (
          <>
            <label className="check">
              <input type="checkbox" disabled={busy} checked={events.waiting} onChange={(e) => save({ ...events, waiting: e.target.checked })} />
              <span>
                <strong>Needs you</strong> <span className="hint">— an agent is waiting for input or permission</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" disabled={busy} checked={events.done} onChange={(e) => save({ ...events, done: e.target.checked })} />
              <span>
                <strong>Finished</strong> <span className="hint">— an agent completed a turn</span>
              </span>
            </label>
            <p className="hint">{active ? 'Push is on for this device, even when ah is closed.' : 'Off for this device.'}</p>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button className="btn ghost">Close</button>
        </div>
      </form>
    </dialog>
  );
}
