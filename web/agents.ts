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

const VENDOR = new Set(['claude', 'codex', 'openai', 'gpt', 'gemini', 'google', 'grok', 'xai', 'muse', 'meta', 'hermes', 'opencode', 'anthropic']);

/** A model id as people say it ("claude-haiku-4-5-20251001" → "Haiku 4.5", "gpt-6.1-sol" → "6.1 Sol"). */
export function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const raw = model.trim().replace(/\[1m\]$/i, '');
  if (!raw || raw.toLowerCase() === 'default') return null;
  // Release dates and aliases ("20251001", "latest") say nothing a person picks a model by.
  const tokens = raw.split(/[-_/: +]+/).filter((t) => t && !/^\d{6,}$/.test(t) && !/^latest$/i.test(t));
  if (!tokens.length) return null;
  const kept = tokens.filter((t) => !VENDOR.has(t.toLowerCase()));
  const parts = kept.length ? kept : tokens;
  // Family name first ("opus"), then dotted version tail ("5.5"), then one qualifier ("Sol").
  const title = (t: string) => (/^\d/.test(t) ? t : t[0].toUpperCase() + t.slice(1).toLowerCase());
  const [family, ...rest] = parts;
  const nums = rest.filter((t) => /^\d/.test(t));
  const word = rest.find((t) => !/^\d/.test(t) && t.toLowerCase() !== family.toLowerCase());
  const out = [title(family)];
  if (nums.length) out.push(nums.join('.'));
  if (word) out.push(title(word));
  // Numeric-only family ("6.1" from "gpt-6.1-sol") already reads well: "6.1 Sol".
  const label = out.join(' ');
  return label.length > 20 ? label.slice(0, 19) + '…' : label;
}
