// Pure helpers for the Space Portal (space-scoped notes, files/artifacts, tasks, and
// Chief of Staff orchestration). Zero React/DOM dependencies so unit tests run directly.
import type { SpaceView, Win } from './api.ts';
import type { Note } from './notes.ts';

/** Strips trailing slashes (keeping root `/` intact). */
function trimSlash(p: string): string {
  const s = p.trim();
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** Expands a Space's short path (`~/spaces/Trips`) into an absolute path using the host's `home`. */
export function expandSpacePath(shortPath: string | null | undefined, home: string): string | null {
  if (!shortPath) return null;
  const p = trimSlash(shortPath);
  if (!p) return null;
  if (p === '~') return trimSlash(home) || null;
  if (p.startsWith('~/')) return `${trimSlash(home)}/${p.slice(2)}`;
  return p.startsWith('/') ? p : null;
}

/** Compares two folder paths (accepting either `~` or absolute forms on the same host). */
export function sameSpacePath(a: string | null | undefined, b: string | null | undefined, home: string): boolean {
  const ea = expandSpacePath(a, home);
  const eb = expandSpacePath(b, home);
  return !!ea && !!eb && ea === eb;
}

/** Notes that belong to a Space on `host` (matching its folder path). */
export function notesInSpace(notes: Note[], host: string, spacePath: string | null, home: string): Note[] {
  const abs = expandSpacePath(spacePath, home);
  if (!abs) return [];
  return notes.filter((n) => n.project && n.project.host === host && sameSpacePath(n.project.path, abs, home));
}

/**
 * Live Chief of Staff sessions for a Space:
 * - If a Chief has `supervision.space` set, it belongs ONLY to that Space.
 * - Otherwise (fleet-wide/unscoped Chief), it matches when its Space (`w.space || w.project`) is `spaceName`.
 * Never enforces a limit of one: multiple chiefs per Space are returned in opening order.
 */
export function chiefsInSpace(windows: Win[], spaceName: string, host: string): Win[] {
  return windows.filter((w) => {
    if (w.host !== host || w.supervision?.role !== 'chief') return false;
    if (w.supervision.space) return w.supervision.space === spaceName;
    return (w.space || w.project) === spaceName;
  });
}

/** Live sessions directly supervised by `chiefUid` on the same host. */
export function workersOf(windows: Win[], chiefUid: string, host: string): Win[] {
  return windows.filter((w) => w.host === host && w.supervision?.managedBy === chiefUid);
}

/** Live sessions inside a Space that are not chiefs and have no supervisor yet. */
export function unmanagedInSpace(windows: Win[], spaceName: string, host: string): Win[] {
  return windows.filter(
    (w) =>
      w.host === host &&
      (w.space || w.project) === spaceName &&
      w.supervision?.role !== 'chief' &&
      !w.supervision?.managedBy,
  );
}

/** Builds the opening operational brief for a Space Chief of Staff launched from the Space Portal. */
export function buildSpaceChiefBrief(o: {
  spaceName: string;
  spacePath: string | null;
  spaceKind?: SpaceView['kind'];
  sessions?: Array<{ uid: string; title: string; agent: string | null; status: string }>;
  customInstructions?: string;
}): string {
  const lines: string[] = [
    `You are a Chief of Staff for the "${o.spaceName}" Space in Agent House.`,
    o.spacePath ? `Space folder: ${o.spacePath} (${o.spaceKind ?? 'space'}).` : `Space kind: ${o.spaceKind ?? 'space'}.`,
    '',
    'Your role:',
    `- Coordinate, supervise, and unblock all sessions inside the "${o.spaceName}" Space.`,
    '- Maintain continuity across this Space using its notes, shared memory (`memory/MEMORY.md`), files, and `artifacts/` folder.',
    '- Keep the user out of routine coordination; escalate destructive approvals or product decisions with `ah forward <uid>` or `ah decide`.',
    '',
    'Key commands (run via your shell — `AH_SESSION_UID` identifies you automatically):',
    `- Inspect this Space's sessions: \`ah list --space "${o.spaceName}"\`, \`ah show <uid>\`, \`ah read <uid> --last\``,
    `- Spawn a worker in this Space: \`ah new <agent>${o.spacePath ? ` --cwd "${o.spacePath}"` : ''} --role worker --managed-by self --mute-alerts --name "<title>" --prompt "<task>"\``,
    '- Adopt an existing session: `ah supervise <uid> --role worker --managed-by self --mute`',
    '- Drive & unblock workers: `ah send <uid> "<msg>"`, `ah answer <uid> yes|no`, `ah forward <uid> --note "<why>"`, `ah interrupt <uid>`, `ah verify <uid> "<cmd>" --task <id>`',
    `- Space notes & tasks: \`ah notes --space "${o.spaceName}"\`, \`ah note new --space "${o.spaceName}" --title "<title>" "<body…>"\`, \`ah tasks --space "${o.spaceName}"\`, \`ah task add --space "${o.spaceName}" "<title>" --assign <uid>\``,
    '- Mailbox & wakes: `ah mail inbox`, `ah mail send <uid> "<msg>" --kind directive`, `ah heartbeat self --every 5m`, `ah wake self --when-waiting "*" --repeat`',
    '',
    'Safety & hierarchy:',
    '- Control is strictly unidirectional (Chief > worker): workers cannot control you or siblings; they report up via `ah mail send` or broadcast to siblings via `ah mail broadcast`.',
    '- Destructive commands (force push, hard reset, root rm, DROP DATABASE, sign-in gates) are blocked from delegated approval — always forward those to the user with `ah forward <uid>`.',
  ];
  if (o.sessions?.length) {
    lines.push('', `Live sessions currently in "${o.spaceName}":`);
    for (const s of o.sessions) {
      lines.push(`- ${s.uid}  "${s.title}" (${s.agent ?? 'shell'}, ${s.status})`);
    }
  }
  if (o.customInstructions?.trim()) {
    lines.push('', 'Additional instructions from the user:', o.customInstructions.trim());
  }
  lines.push('', 'Start by checking `ah whoami`, listing sessions and tasks in this Space, and summarizing what is currently active or waiting.');
  return lines.join('\n');
}
