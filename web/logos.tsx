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
/** White single-color marks (their dark-ground artwork): drawn in ink on a light theme. */
const WHITE = new Set(['codex', 'grok']);

export function AgentLogo({ id, size = 15 }: { id: string | null; size?: number }) {
  const key = (id ?? 'shell').toLowerCase();
  const file = FILE[key];
  if (file) {
    return <img src={file} width={size} height={size} alt="" draggable={false} className={TILE.has(key) ? 'tile' : WHITE.has(key) ? 'ink' : undefined} />;
  }
  // An agent without a brand mark (one added on this host): its initial, in its tint.
  if (key !== 'shell') {
    return (
      <span className="letter-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.68) }} aria-hidden>
        {key.replace(/^custom-/, '').replace(/[^a-z0-9]/g, '').slice(0, 1).toUpperCase() || '?'}
      </span>
    );
  }
  // Shell: the terminal glyph.
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

export { shortModel } from './agents.ts';
