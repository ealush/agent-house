import type { Win } from './api.ts';

/**
 * The one set of words for what a session is doing, wherever it shows:
 * inbox rows and sections, a session's header, taglines. A shell that is
 * printing is "working" like an agent; one that finished a command while
 * you were away has "new output" (an agent there is "done").
 */
export function statusWord(w: Pick<Win, 'status' | 'agent'>): string {
  switch (w.status) {
    case 'waiting': return 'needs you';
    case 'busy': return 'working';
    case 'attention': return w.agent ? 'done' : 'new output';
    default: return 'idle';
  }
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
