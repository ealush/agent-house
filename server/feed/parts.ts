// Helpers shared by the harness adapters: transport limits and the generative-UI
// widget fence. Everything here is harness-agnostic.
import type { Part, ToolResult, Widget } from './schema.ts';

export const LIMITS = {
  /** Tool output kept for display; the model saw all of it, the GUI shows head + tail. */
  result: 16 * 1024,
  /** Long string arguments (a whole file passed to Write). */
  arg: 32 * 1024,
  /** Harness structure attached to a result (patches, exit codes). */
  data: 64 * 1024,
  /** Inline images travel as data: URLs; bigger ones become a placeholder. */
  image: 3 * 1024 * 1024,
  text: 256 * 1024,
};

/** Keeps the head and the tail, which is where commands put what matters. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const tail = Math.floor(max / 4);
  return { text: `${text.slice(0, max - tail)}\n… ${text.length - max} characters not shown …\n${text.slice(-tail)}`, truncated: true };
}

export function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' ? clip(v, LIMITS.arg).text : v;
  return out;
}

/** Harness structure is passed through only while it stays small. */
export function smallData(data: unknown, drop: string[] = []): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const out = { ...(data as Record<string, unknown>) };
  for (const k of drop) delete out[k];
  const size = JSON.stringify(out).length;
  return size <= LIMITS.data && Object.keys(out).length ? out : undefined;
}

export function imageSrc(mime: unknown, base64: unknown): string | null {
  if (typeof base64 !== 'string' || typeof mime !== 'string' || !/^image\/[\w.+-]+$/.test(mime)) return null;
  if (base64.length > LIMITS.image || !/^[A-Za-z0-9+/=\s]*$/.test(base64)) return null;
  return `data:${mime};base64,${base64}`;
}

export function toolResult(callId: string, raw: string, isError: boolean, extra: Partial<ToolResult> = {}): Part {
  const { text, truncated } = clip(raw, LIMITS.result);
  return { type: 'tool_result', result: { callId, text, isError, ...extra, ...(truncated ? { truncated } : {}) } };
}

export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return clipArgs(raw as Record<string, unknown>);
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return clipArgs(v);
  } catch {}
  return { input: clip(raw, LIMITS.arg).text };
}

export function ms(timestamp: unknown, fallback = 0): number {
  const t = typeof timestamp === 'string' ? Date.parse(timestamp) : typeof timestamp === 'number' ? timestamp : NaN;
  return Number.isFinite(t) ? t : fallback;
}

// ---------- generative UI

const FENCE = /^(`{3,}|~{3,})[ \t]*ah-widget[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;

/**
 * Splits assistant markdown into text and widget parts. A widget is a fenced
 * ```ah-widget block holding one JSON object with a string `type`; anything that
 * doesn't parse stays in the text, where it renders as an ordinary code block.
 */
export function textParts(markdown: string): Part[] {
  const text = clip(markdown, LIMITS.text).text;
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const widget = parseWidget(m[2]);
    if (!widget) continue;
    const before = text.slice(last, m.index).trim();
    if (before) parts.push({ type: 'text', text: before });
    parts.push({ type: 'widget', widget });
    last = m.index! + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) parts.push({ type: 'text', text: rest });
  return parts;
}

export function parseWidget(json: string): Widget | null {
  try {
    const v = JSON.parse(json);
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string' && v.type) return v as Widget;
  } catch {}
  return null;
}
