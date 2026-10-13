// Past sessions a blank one can turn into: a new session's empty GUI offers the
// newest conversations from the same project, and picking one resumes it in place.
import { createContext } from 'react';
import type { HistoryItem, Win } from './api.ts';

export type Resumer = {
  history: HistoryItem[];
  /** Resume without navigating; the session key it came back under, or null when it failed (already reported). */
  resume: (h: HistoryItem) => Promise<string | null>;
  /** Close a session that never started a conversation: no confirmation, no navigation. */
  discard: (w: Win) => void;
};

export const ResumeContext = createContext<Resumer | null>(null);

/** The newest past sessions in this session's project, on its host. */
export function recentFor(history: HistoryItem[], w: Win, count = 4): HistoryItem[] {
  return history
    .filter((h) => h.host === w.host && h.project === w.project && h.ref !== w.uid && h.harness !== 'shell')
    .sort((a, b) => b.at - a.at)
    .slice(0, count);
}
