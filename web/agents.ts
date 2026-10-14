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
  cursor: { color: 'var(--c-cursor)', glyph: 'C', name: 'Cursor Agent' },
  copilot: { color: 'var(--c-copilot)', glyph: 'C', name: 'Copilot' },
  crush: { color: 'var(--c-crush)', glyph: 'C', name: 'Crush' },
  pi: { color: 'var(--c-pi)', glyph: 'P', name: 'pi' },
};

export function look(agent: string | null) {
  return LOOK[agent ?? 'shell'] ?? { color: 'var(--c-other)', glyph: (agent ?? '?').slice(0, 1).toUpperCase(), name: agent ?? 'Shell' };
}

/** "4m", "2h", "yesterday", "11:20". */
// One formatter for every row: building one per call made a long list slow to draw.
let monthDay: Intl.DateTimeFormat | null = null;

export function age(ts: number, now = Date.now()): string {
  if (!ts) return '';
  const s = now / 1000 - ts;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 6 * 3600) return `${Math.round(s / 3600)}h`;
  const d = new Date(ts * 1000);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toTimeString().slice(0, 5);
  // The calendar day before today, not "within 48 hours".
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday';
  return (monthDay ??= new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })).format(d);
}

const VENDOR = new Set(['claude', 'codex', 'openai', 'gpt', 'gemini', 'google', 'grok', 'xai', 'muse', 'meta', 'hermes', 'opencode', 'anthropic']);

/**
 * The preset's choice for the model a session is running ("claude-haiku-4-5-20251001"
 * is the "haiku" alias), so the composer shows what the agent really uses, even when
 * it was started outside ah or switched in its own terminal.
 */
export function runningModel<M extends { id: string }>(models: M[], running: string | null | undefined): M | undefined {
  if (!running) return undefined;
  const id = running.toLowerCase();
  return models.find((m) => m.id.toLowerCase() === id) ?? models.find((m) => m.id.length >= 4 && m.id !== 'default' && id.includes(m.id.toLowerCase()));
}

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
