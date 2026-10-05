// True brand artwork for each agent preset, vendored under web/public/logos so
// the page stays self-contained (no external image fetches at runtime).
//
// Provenance — shapes are the official artwork; single-color marks are rendered
// in their brands' official dark-background colors (white, or the brand color):
// - Claude sunburst: claude.ai/favicon.svg (Anthropic; coral #D97757 from file)
// - OpenAI blossom: Wikimedia Commons "OpenAI logo 2025 (symbol).svg"
// - Grok X emblem: Wikimedia Commons "Grok-feb-2025-logo.svg" (emblem paths only)
// - Gemini sparkle: Google's official full-color gradient mark (gstatic)
// - Meta loop: Simple Icons `meta` (CC0; Meta blue #0082FB)
// - opencode mark: sst/opencode brand assets (opencode-logo-light-square.svg)
// - Hermes portrait: Nous Research Hermes Desktop app icon (hermes-desktop.png)
// All trademarks belong to their owners; each mark is used only to identify
// the tool it stands for.
const FILE: Record<string, string> = {
  claude: '/logos/claude.svg',
  codex: '/logos/openai.svg',
  gemini: '/logos/gemini.svg',
  grok: '/logos/grok.svg',
  muse: '/logos/meta.svg',
  hermes: '/logos/hermes-logo.png',
  opencode: '/logos/opencode.svg',
};

/** Logos that are full app icons (their own background): drawn edge to edge, no mat. */
const TILE = new Set(['hermes']);

export function AgentLogo({ id, size = 15 }: { id: string | null; size?: number }) {
  const key = (id ?? 'shell').toLowerCase();
  const file = FILE[key];
  if (file) {
    return <img src={file} width={size} height={size} alt="" draggable={false} className={TILE.has(key) ? 'tile' : undefined} />;
  }
  // Shell (and any unknown agent) has no brand mark: generic terminal glyph.
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4.5 5.5 8l-3 3.5" />
      <path d="M7.5 11.5h6" />
    </svg>
  );
}

/** Which logo to show for a launch model choice. Defaults to its parent preset. */
export function logoForModel(presetId: string, modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.includes('opus') || m.includes('sonnet') || m.includes('claude')) return 'claude';
  if (m.includes('spark') || m.includes('muse')) return 'muse';
  if (m.includes('gpt') || m.includes('codex')) return 'codex';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('grok')) return 'grok';
  if (m.includes('hermes')) return 'hermes';
  return presetId;
}

const VENDOR = new Set(['claude', 'codex', 'openai', 'gpt', 'gemini', 'google', 'grok', 'xai', 'muse', 'meta', 'hermes', 'opencode', 'anthropic']);

/** Shorten a detected model id ("claude-opus-5-5" → "Opus 5.5") for tight UI spots. */
export function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const raw = model.trim();
  if (!raw || raw.toLowerCase() === 'default') return null;
  const tokens = raw.split(/[-_/: +]+/).filter(Boolean);
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
