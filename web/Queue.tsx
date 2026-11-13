import { useEffect, useRef, useState } from 'react';
import type { HostApi, QueueItem } from './api.ts';
import { shortcutTitle } from './shortcuts.tsx';
import { errorText } from './errors.ts';
import { every } from './poll.ts';

/** This conversation's queue, as a side panel: review, send now, or cancel follow-ups. */
export function QueuePanel({ client, uid, onChange }: {
  client: HostApi; uid: string; onChange: () => void;
}) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const current = ++version.current;
      try {
        const next = await client.queue(uid);
        if (!stopped && current === version.current) { setItems(next); setError(null); }
      } catch (e) {
        if (!stopped && current === version.current) setError(errorText(e));
      }
    };
    load();
    const stop = every(1500, load);
    return () => { stopped = true; stop(); };
  }, [client, uid]);

  async function refresh() {
    ++version.current;
    try {
      const next = await client.queue(uid);
      ++version.current;
      setItems(next);
      setError(null);
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function remove(id?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await client.clearQueue(uid, id);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally { setBusy(false); }
  }

  /** Urgent follow-up: stop the live turn and deliver this message right away. */
  async function sendNow(item: QueueItem) {
    if (busy) return;
    setBusy(true);
    try {
      await client.sendNow(uid, item.id);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="queue-panel">
      <p className="hint">Queued for this conversation, sent in order when the agent is free. Messages already sent cannot be cancelled.</p>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p className="hint">Loading…</p>}
      {items?.length === 0 && <p className="hint">No queued messages.</p>}
      <ol className="queue-items" data-rove>
        {items?.map((item) => (
          <QueueRow key={item.id} item={item} first={item === items[0]} busy={busy} onSendNow={() => sendNow(item)} onCancel={() => remove(item.id)} />
        ))}
      </ol>
      {!!items?.length && <button className="btn ghost small danger queue-clear-all" disabled={busy} onClick={() => remove()}>Cancel all queued</button>}
    </div>
  );
}

/** One queued follow-up: collapsed to its first line until expanded. */
function QueueRow({ item, first, busy, onSendNow, onCancel }: {
  item: QueueItem; first: boolean; busy: boolean; onSendNow: () => void; onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const firstLine = item.text.split('\n')[0];
  const collapsible = item.text.length > 160 || firstLine.length < item.text.length;
  const preview = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
  return (
    <li>
      {open || !collapsible ? <pre>{item.text}</pre> : <pre className="queue-preview">{preview}</pre>}
      {collapsible && (
        <button className="btn ghost small queue-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Collapse' : 'Expand'}
        </button>
      )}
      <div className="queue-actions">
        <button className="btn primary small" disabled={busy} onClick={onSendNow} title={first ? shortcutTitle('Stop the current turn and deliver this message now', 'send-now') : 'Stop the current turn and deliver this message now'}>
          Send now
        </button>
        <button className="btn small" disabled={busy} onClick={onCancel}>Cancel message</button>
      </div>
    </li>
  );
}
