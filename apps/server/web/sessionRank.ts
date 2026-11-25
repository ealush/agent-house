// The composer's "#" completion: live sessions to reference (`#<uid>`), the most recently
// active first (apps/ios's CompletionTrigger.sessions does the same).
import type { Win } from './api.ts';

/** The sessions matching `q` but `currentUid`, at most 20, as completion items. */
export function rankSessions(sessions: Win[], q: string, currentUid: string, currentSpace?: string): Array<{ value: string; label: string; detail: string }> {
  const query = q.toLowerCase();
  return sessions
    .filter((s) => s.uid !== currentUid)
    .map((s) => {
      const title = (s.title || s.name).toLowerCase();
      const space = (s.space || s.project || '').toLowerCase();
      const uid = s.uid.toLowerCase();
      const textScore = !query ? 1 : title.startsWith(query) ? 4 : title.includes(query) ? 3 : uid.startsWith(query) ? 2 : space.includes(query) ? 1 : 0;
      if (textScore === 0) return { s, score: 0 };
      const isWorker = s.supervision?.managedBy === currentUid ? 20 : 0;
      const sameSpace = currentSpace && (s.space || s.project) === currentSpace ? 10 : 0;
      const isChief = s.supervision?.role === 'chief' ? 2 : 0;
      return { s, score: textScore + isWorker + sameSpace + isChief };
    })
    .filter((x) => x.score > 0)
    // The most recent first; among equally recent, the closer match and relation.
    .sort((a, b) => b.s.activity - a.s.activity || b.score - a.score)
    .slice(0, 20)
    .map(({ s }) => {
      const roleTag = s.supervision?.role === 'chief' ? 'Chief' : s.supervision?.managedBy === currentUid ? 'Sub-session' : s.supervision?.role;
      const detail = [roleTag, s.space || s.project, s.agent || 'shell', s.uid].filter(Boolean).join(' · ');
      return { value: `#${s.uid} `, label: s.title || s.name, detail };
    });
}
