import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { HostApi, QueueItem } from './api.ts';
import { showError } from './ask.tsx';
import { Icon } from './icons.tsx';
import { removeOutgoing, useOutbox } from './outbox.ts';
import { shortcutTitle } from './shortcuts.tsx';
import { uploadSummary } from './uploads.ts';
import { every } from './poll.ts';
import { placeOf } from './requeue.ts';

/**
 * Follow-ups waiting for a working agent, stacked on top of the composer (the way
 * Codex shows its queue). Steer stops the turn and sends one now; edit takes it
 * back into the box, and queued again it goes back where it was. What you just queued shows here at once, before the server
 * has answered. Enter in an empty composer steers the top row (steerFirst).
 * With two or more queued, each row has a grip: drag it (mouse or touch), or
 * focus it and press ↑/↓, to change what goes next.
 */
export type QueueTrayHandle = {
  /** Steer the first queued message. False when there is none to steer yet. */
  steerFirst: () => boolean;
};

/** `before`: the message it came out from in front of, to go back before (none for the last). */
type Props = { client: HostApi; uid: string; queued: number; onEdit: (text: string, before?: string) => void; onChange: () => void };

export const QueueTray = forwardRef<QueueTrayHandle, Props>(function QueueTray({ client, uid, queued, onEdit, onChange }, ref) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const outbox = useOutbox(uid);
  const mine = outbox.filter((o) => o.state === 'queued');
  const waiting = mine.length > 0;
  const live = useRef(true);
  // A drag in progress: which row, where it started, and the slot it would land in.
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; dy: number; rowH: number; startY: number } | null>(null);
  const dragging = useRef(false);
  dragging.current = !!drag;

  const load = async () => {
    const started = Date.now();
    try {
      const list = await client.queue(uid);
      if (!live.current) return;
      // Mid-drag the rows stay where your finger put them; the next poll catches up.
      if (!dragging.current) setItems(list);
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
    return every(3000, load);
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

  // Messages on their way out. A steer can take seconds (the server stops the turn
  // and waits for it to settle) while the list still shows them, so a second Enter
  // must go to the next row, not resend one the server already took. A ref, so two
  // presses before a render still see each other.
  const sending = useRef(new Set<string>());
  const [, rerender] = useState(0);
  const steer = async (q: QueueItem) => {
    if (sending.current.has(q.id)) return;
    sending.current.add(q.id);
    rerender((n) => n + 1);
    await act(() => client.sendNow(uid, q.id), 'send it now');
    sending.current.delete(q.id);
    rerender((n) => n + 1);
  };
  useImperativeHandle(ref, () => ({
    steerFirst: () => {
      const next = items.find((q) => !sending.current.has(q.id));
      if (!next) return false;
      void steer(next);
      return true;
    },
  }));

  // Reorder: shown at once, then the server's order (a message sent meanwhile is just gone).
  const move = (id: string, to: number) => {
    const from = items.findIndex((q) => q.id === id);
    if (from < 0 || to === from) return;
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    setItems(next);
    void act(() => client.moveQueued(uid, id, to), 'reorder the queue');
  };
  const canMove = items.length > 1;
  // While dragging, rows keep their place in the page (moving the node would drop
  // the pointer capture); the dragged one follows the pointer, the ones it passes
  // slide over by a row.
  const offset = (i: number) => {
    if (!drag) return 0;
    if (i === drag.from) return drag.dy;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -drag.rowH;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return drag.rowH;
    return 0;
  };

  const pendingRows = mine.filter((o) => o.confirmedAt === undefined || !items.some((i) => i.text === o.text));
  if (!items.length && !pendingRows.length) return null;
  return (
    <ul className="queue-tray" aria-label="Queued messages">
      {items.map((q, i) => (
        <li
          key={q.id}
          className={`queue-row ${drag?.id === q.id ? 'dragging' : drag ? 'shifting' : ''}`}
          style={drag ? { transform: `translateY(${offset(i)}px)` } : undefined}
        >
          {canMove ? (
            <button
              type="button"
              className="queue-grip"
              title="Drag to reorder (or ↑/↓)"
              aria-label={`Move “${q.text.slice(0, 40)}”, position ${i + 1} of ${items.length}`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                const rowH = e.currentTarget.closest('li')?.getBoundingClientRect().height ?? 32;
                setDrag({ id: q.id, from: i, to: i, dy: 0, rowH, startY: e.clientY });
              }}
              onPointerMove={(e) => {
                if (!drag || drag.id !== q.id) return;
                const dy = e.clientY - drag.startY;
                const to = Math.max(0, Math.min(items.length - 1, drag.from + Math.round(dy / drag.rowH)));
                setDrag({ ...drag, dy, to });
              }}
              onPointerUp={() => {
                if (!drag) return;
                setDrag(null);
                move(drag.id, drag.to);
              }}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                e.preventDefault();
                e.stopPropagation();
                const to = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)));
                move(q.id, to);
                // Keep the keyboard on the row it is carrying.
                const list = e.currentTarget.closest('ul');
                requestAnimationFrame(() => list?.querySelectorAll<HTMLElement>('.queue-grip')[to]?.focus());
              }}
            >
              <Icon name="grip" size={15} />
            </button>
          ) : (
            <span className="queue-grip-slot" />
          )}
          <span className="queue-text" title={q.text}>{uploadSummary(q.text)}</span>
          {sending.current.has(q.id) ? (
            <span className="queue-state">Sending…</span>
          ) : (
            <button type="button" className="queue-steer" title={shortcutTitle('Stop the current turn and send this now', 'send-now')} onClick={() => steer(q)}>
              <Icon name="reply" size={14} /> Steer
            </button>
          )}
          <button
            type="button"
            className="icon-btn small"
            title="Edit: take it out of the queue and back into the box"
            aria-label="Edit"
            onClick={() =>
              act(async () => {
                const before = placeOf(items, q.id);
                await client.clearQueue(uid, q.id);
                onEdit(q.text, before);
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
          <span className="queue-grip-slot" />
          <span className="queue-text" title={o.text}>{uploadSummary(o.text)}</span>
          <span className="queue-state">Queuing…</span>
        </li>
      ))}
    </ul>
  );
});
