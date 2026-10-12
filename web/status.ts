import type { Win } from './api.ts';

/**
 * The one set of words for what a session is doing, wherever it shows:
 * inbox rows and sections, a session's header, taglines. A shell that is
 * printing is "working" like an agent; one that finished a command while
 * you were away has "new output" (an agent there is "done").
 */
export function statusWord(w: Pick<Win, 'status' | 'agent' | 'limit'>): string {
  // Stopped on the plan's usage limit is neither done nor idle: it can't go on yet.
  if (w.limit && w.status !== 'busy' && w.status !== 'waiting') return 'limited';
  switch (w.status) {
    case 'waiting': return 'needs you';
    case 'busy': return 'working';
    case 'attention': return w.agent ? 'done' : 'new output';
    default: return 'idle';
  }
}

/** The pill's class: its status, or `limit` while stopped on the usage limit. */
export function statusClass(w: Pick<Win, 'status' | 'limit'>): string {
  return w.limit && w.status !== 'busy' && w.status !== 'waiting' ? 'limit' : w.status;
}

/** "1 session needs you. 3 working. 6 idle." — or "All quiet." */
export function statusCounts(windows: Pick<Win, 'status'>[]): string {
  const waiting = windows.filter((w) => w.status === 'waiting').length;
  const working = windows.filter((w) => w.status === 'busy').length;
  const rest = windows.length - waiting - working;
  const parts = [
    waiting ? `${waiting} session${waiting === 1 ? ' needs' : 's need'} you` : null,
    working ? `${working} working` : null,
    rest ? `${rest} idle` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join('. ')}.` : 'All quiet.';
}
