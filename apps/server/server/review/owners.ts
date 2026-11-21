// Who a review's findings belong to. A stack, and each layer, stores its owner as the
// session's uid and its conversation key; sessions come and go (a resume can give the
// conversation a new uid, an ended one lingers in history). One rule decides which
// session that stored pair means now, for showing the owner and for sending to it:
// a review never shows one session and dispatches to another.
import type { SessionLite } from './service.ts';

/**
 * The session a stored owner means: the conversation if it's running, else that session
 * if it's running, else the conversation's ended record, else the session's.
 */
export function resolveSession(sessions: readonly SessionLite[], key: string | null, uid: string | null): SessionLite | null {
  if (!key && !uid) return null;
  const byKey = (x: SessionLite) => !!key && x.key === key;
  const byUid = (x: SessionLite) => !!uid && x.uid === uid;
  return sessions.find((x) => x.live && byKey(x)) ?? sessions.find((x) => x.live && byUid(x)) ?? sessions.find(byKey) ?? sessions.find(byUid) ?? null;
}
