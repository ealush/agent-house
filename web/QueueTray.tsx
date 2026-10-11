import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { HostApi, QueueItem } from './api.ts';
import { showError } from './ask.tsx';
import { Icon } from './icons.tsx';
import { removeOutgoing, useOutbox } from './outbox.ts';
import { shortcutTitle } from './shortcuts.tsx';

/**
 * Follow-ups waiting for a working agent, stacked on top of the composer (the way
 * Codex shows its queue). Steer stops the turn and sends one now; edit takes it
 * back into the box. What you just queued shows here at once, before the server
 * has answered. Enter in an empty composer steers the top row (steerFirst).
 */
export type QueueTrayHandle = {
  /** Steer the first queued message. False when there is none to steer yet. */
  steerFirst: () => boolean;
};

type Props = { client: HostApi; uid: string; queued: number; onEdit: (text: string) => void; onChange: () => void };

export const QueueTray = forwardRef<QueueTrayHandle, Props>(function QueueTray({ client, uid, queued, onEdit, onChange }, ref) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const outbox = useOutbox(uid);
  const mine = outbox.filter((o) => o.state === 'queued');
  const waiting = mine.length > 0;
  const live = useRef(true);

  const load = async () => {
    const started = Date.now();
    try {
      const list = await client.queue(uid);
      if (!live.current) return;
      setItems(list);
      // The server's list now holds what it confirmed before this fetch began: drop
      // our copies (a message the agent already took went into the transcript).
      removeOutgoing(mine.filter((o) => o.confirmedAt !== undefined && o.confirmedAt <= started).map((o) => o.id));
    } catch {}
  };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Rows on screen keep the poll going: the session list's count can lag a moment
  // behind the server, and the tray must not blink empty while it catches up.
  const showing = items.length > 0;
  useEffect(() => {
    if (!queued && !waiting && !showing) return;
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, uid, queued, waiting, showing, mine.some((o) => o.confirmedAt)]);

  const act = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn();
    } catch (e) {
      showError(e, `Couldn't ${what}`);
    }
    await load();
    onChange();
  };

  const steer = (q: QueueItem) => act(() => client.sendNow(uid, q.id), 'send it now');
  useImperativeHandle(ref, () => ({
    steerFirst: () => {
      if (!items[0]) return false;
      void steer(items[0]);
      return true;
    },
  }));

  const pendingRows = mine.filter((o) => o.confirmedAt === undefined || !items.some((i) => i.text === o.text));
  if (!items.length && !pendingRows.length) return null;
  return (
    <ul className="queue-tray" aria-label="Queued messages">
      {items.map((q) => (
        <li key={q.id} className="queue-row">
          <Icon name="queue" size={15} />
          <span className="queue-text" title={q.text}>{q.text}</span>
          <button type="button" className="queue-steer" title={shortcutTitle('Stop the current turn and send this now', 'send-now')} onClick={() => steer(q)}>
            <Icon name="reply" size={14} /> Steer
          </button>
          <button
            type="button"
            className="icon-btn small"
            title="Edit: take it out of the queue and back into the box"
            aria-label="Edit"
            onClick={() =>
              act(async () => {
                await client.clearQueue(uid, q.id);
                onEdit(q.text);
              }, 'edit it')
            }
          >
            <Icon name="edit" size={15} />
          </button>
          <button type="button" className="icon-btn small" title="Remove from the queue" aria-label="Remove" onClick={() => act(() => client.clearQueue(uid, q.id), 'remove it')}>
            <Icon name="trash" size={15} />
          </button>
        </li>
      ))}
      {pendingRows.map((o) => (
        <li key={o.id} className="queue-row pending">
          <Icon name="queue" size={15} />
          <span className="queue-text" title={o.text}>{o.text}</span>
          <span className="queue-state">Queuing…</span>
        </li>
      ))}
    </ul>
  );
});
