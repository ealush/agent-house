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

/**
 * Something here nobody has looked at yet: a turn that ended unseen (`attention`, cleared
 * once a device views it, docs/spec/01-foundation.md) or a question waiting on you. Lists
 * set these names in bold and the rest, already read or still working, plain (the app's
 * `SessionDTO.Status.unseen`).
 */
export function unseen(w: Pick<Win, 'status'>): boolean {
  return w.status === 'attention' || w.status === 'waiting';
}

/** The pill's class: its status, or `limit` while stopped on the usage limit. */
export function statusClass(w: Pick<Win, 'status' | 'limit'>): string {
  return w.limit && w.status !== 'busy' && w.status !== 'waiting' ? 'limit' : w.status;
}

/**
 * "1 session needs you. 3 working. 1 done. 6 idle." — or "All quiet." Each
 * status counts under its own word (statusWord), so the sentence agrees with
 * the sections and pills below it.
 */
export function statusCounts(windows: Pick<Win, 'status'>[] & Partial<Pick<Win, 'agent' | 'limit'>>[]): string {
  const counts = new Map<string, number>();
  for (const w of windows) {
    const word = statusWord({ agent: null, limit: null, ...w } as Pick<Win, 'status' | 'agent' | 'limit'>);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const n = (word: string) => counts.get(word) ?? 0;
  const waiting = n('needs you');
  const parts = [
    waiting ? `${waiting} session${waiting === 1 ? ' needs' : 's need'} you` : null,
    ...['working', 'limited', 'done', 'new output', 'idle'].map((word) => (n(word) ? `${n(word)} ${word}` : null)),
  ].filter(Boolean);
  return parts.length ? `${parts.join('. ')}.` : 'All quiet.';
}
