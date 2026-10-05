import { useEffect, useRef, useState } from 'react';
import type { HostApi, QueueItem } from './api.ts';

/** Review pending follow-ups and cancel just the ones you no longer want. */
export function QueueDialog({ client, uid, onClose, onChange }: {
  client: HostApi; uid: string; onClose: () => void; onChange: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);

  useEffect(() => {
    dialog.current?.showModal();
    let stopped = false;
    const load = async () => {
      const current = ++version.current;
      try {
        const next = await client.queue(uid);
        if (!stopped && current === version.current) { setItems(next); setError(null); }
      } catch (e) {
        if (!stopped && current === version.current) setError((e as Error).message);
      }
    };
    load();
    const timer = window.setInterval(load, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [client, uid]);

  async function remove(id?: string) {
    if (busy) return;
    setBusy(true);
    ++version.current;
    try {
      await client.clearQueue(uid, id);
      const next = await client.queue(uid);
      ++version.current;
      setItems(next);
      setError(null);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="dialog queue-dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="capture-head">
        <h2>Queued messages</h2>
        <button className="btn ghost small" onClick={onClose}>Close</button>
      </div>
      <div className="queue-body">
        <p className="hint">Sent in order when the agent is free. Messages already sent cannot be cancelled.</p>
        {error && <p role="alert">{error}</p>}
        {items === null && !error && <p className="hint">Loading…</p>}
        {items?.length === 0 && <p className="hint">No queued messages.</p>}
        <ol className="queue-items">
          {items?.map((item) => (
            <li key={item.id}>
              <pre>{item.text}</pre>
              <button className="btn small" disabled={busy} onClick={() => remove(item.id)}>Cancel message</button>
            </li>
          ))}
        </ol>
        {!!items?.length && <button className="btn ghost small danger queue-clear-all" disabled={busy} onClick={() => remove()}>Cancel all queued messages</button>}
      </div>
    </dialog>
  );
}
