// Visual identity per agent preset. Unknown presets fall back to a neutral chip.
const LOOK: Record<string, { color: string; glyph: string }> = {
  shell: { color: 'var(--c-shell)', glyph: '$' },
  claude: { color: 'var(--c-claude)', glyph: '✳' },
  codex: { color: 'var(--c-codex)', glyph: '◎' },
  gemini: { color: 'var(--c-gemini)', glyph: '✦' },
  grok: { color: 'var(--c-grok)', glyph: '⨯' },
  muse: { color: 'var(--c-muse)', glyph: '◈' },
  hermes: { color: 'var(--c-hermes)', glyph: '⚡' },
  opencode: { color: 'var(--c-opencode)', glyph: '⌘' },
};

export function look(agent: string | null) {
  return LOOK[agent ?? 'shell'] ?? { color: 'var(--c-other)', glyph: (agent ?? '?').slice(0, 1).toUpperCase() };
}
