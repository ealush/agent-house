// What an agent's own words say went wrong (docs/spec/13-conductor.md, CND-5). Pure:
// the text a harness wrote (an API error line in its transcript, a notice on its
// screen) in, a reason and any retry hint out. Unknown text is `unknown`, never
// guessed into something recoverable.

export type Reason = 'rate_limit' | 'provider_unavailable' | 'credentials' | 'network' | 'process_exit' | 'unknown';

export type Finding = {
  reason: Reason;
  /** Epoch seconds the provider said capacity comes back, when it said. */
  resetsAt?: number;
  /** Seconds the provider said to wait, when it said. */
  retryAfter?: number;
  /** Whether trying again can help on its own. Credentials never do. */
  retryable: boolean;
  text: string;
};

const CREDENTIALS = /invalid (api|x-api)[- ]key|please run \/login|oauth token (has )?expired|not (logged|signed) in|authentication[_ ](error|failed)|unauthori[sz]ed|\b401\b|\b403\b|permission_error|credit balance is too low|billing/i;
const RATE = /usage limit|rate[ _-]?limit|too many requests|\b429\b|quota|hit your (\w+ )?limit/i;
const PROVIDER = /overloaded|\b529\b|\b5(00|02|03|04)\b|internal server error|service unavailable|bad gateway|api_error|server_error/i;
const NETWORK = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network (error|is unreachable)|fetch failed|connection (reset|refused|error)|stream (error|disconnected)|timed? ?out/i;

/** Seconds from "retry after 30s", "try again in 2 minutes", "resets_in_seconds: 900". */
function retryAfterOf(text: string): number | undefined {
  const m = text.match(/(?:retry[- ]after|try again in|resets?_in_seconds"?\s*[:=]?|wait)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const sec = unit.startsWith('ms') || unit.startsWith('milli') ? n / 1000 : unit.startsWith('h') ? n * 3600 : unit.startsWith('m') ? n * 60 : n;
  return Number.isFinite(sec) && sec > 0 && sec < 7 * 86_400 ? Math.ceil(sec) : undefined;
}

/** "Claude AI usage limit reached|1763112000": Claude Code's own line, with the reset as epoch seconds. */
function epochOf(text: string): number | undefined {
  const m = text.match(/\|(\d{10})\b/) ?? text.match(/resets?[_ ]at"?\s*[:=]\s*"?(\d{10})\b/i);
  return m ? Number(m[1]) : undefined;
}

export function classify(text: string): Finding {
  const t = text.slice(0, 4000);
  if (CREDENTIALS.test(t) && !RATE.test(t)) return { reason: 'credentials', retryable: false, text: t };
  if (RATE.test(t)) {
    const resetsAt = epochOf(t);
    const retryAfter = retryAfterOf(t);
    return { reason: 'rate_limit', retryable: true, text: t, ...(resetsAt ? { resetsAt } : {}), ...(retryAfter ? { retryAfter } : {}) };
  }
  if (PROVIDER.test(t)) {
    const retryAfter = retryAfterOf(t);
    return { reason: 'provider_unavailable', retryable: true, text: t, ...(retryAfter ? { retryAfter } : {}) };
  }
  if (NETWORK.test(t)) return { reason: 'network', retryable: true, text: t };
  return { reason: 'unknown', retryable: false, text: t };
}

/** Error lines a harness wrote into its own transcript, from raw JSONL lines. */
export function transcriptErrors(adapter: string, lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (adapter === 'claude' && d?.isApiErrorMessage) {
      const c = d.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join(' ') : '';
      if (text) out.push(text);
    } else if (adapter === 'codex' && d?.type === 'event_msg' && (d.payload?.type === 'error' || d.payload?.type === 'stream_error') && typeof d.payload?.message === 'string') {
      out.push(d.payload.message);
    }
  }
  return out;
}

/** A transcript line that shows the agent working again (a new user turn, or assistant output), after an error. */
export function progressed(adapter: string, lines: string[]): boolean {
  for (const line of lines) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (adapter === 'claude' && (d?.type === 'assistant' || d?.type === 'user') && !d.isApiErrorMessage && !d.isMeta) return true;
    if (adapter === 'codex' && d?.type === 'response_item') return true;
  }
  return false;
}
