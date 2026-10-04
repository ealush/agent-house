// Visual identity per agent: a letter chip in the agent's tint, plus its display name.
const LOOK: Record<string, { color: string; glyph: string; name: string }> = {
  shell: { color: 'var(--c-shell)', glyph: '$', name: 'Shell' },
  claude: { color: 'var(--c-claude)', glyph: 'C', name: 'Claude Code' },
  codex: { color: 'var(--c-codex)', glyph: 'X', name: 'Codex' },
  gemini: { color: 'var(--c-gemini)', glyph: 'G', name: 'Gemini' },
  grok: { color: 'var(--c-grok)', glyph: 'K', name: 'Grok' },
  muse: { color: 'var(--c-muse)', glyph: 'M', name: 'Muse' },
  hermes: { color: 'var(--c-hermes)', glyph: 'H', name: 'Hermes' },
  opencode: { color: 'var(--c-opencode)', glyph: 'O', name: 'opencode' },
};

export function look(agent: string | null) {
  return LOOK[agent ?? 'shell'] ?? { color: 'var(--c-other)', glyph: (agent ?? '?').slice(0, 1).toUpperCase(), name: agent ?? 'Shell' };
}

/** "4m", "2h", "yesterday", "11:20". */
export function age(ts: number): string {
  if (!ts) return '';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 6 * 3600) return `${Math.round(s / 3600)}h`;
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toTimeString().slice(0, 5);
  if (Date.now() - d.getTime() < 2 * 86400_000) return 'yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
