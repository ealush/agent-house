// Screens an agent draws in front of its own prompt: its folder-trust question, a
// sign-in (a picker of ways in, a link to open, a one-time code to enter elsewhere,
// a box for a pasted code or key), first-run setup. A message typed there is lost:
// the TUI drops the paste and takes its Enter as the highlighted row. So while one
// is up the session waits for you, a message waits in the queue, and every client
// shows the screen itself: its words, its links and code, its rows as buttons, and a
// box when it wants something typed. Pure functions; sessions.ts reads the screen.
import { parsePicker, type ScreenOption } from './choices.ts';

export type GateKind = 'trust' | 'signin' | 'setup';

/**
 * One of a preset's own screens: `pattern` (multiline regex) tells it is up, near the
 * bottom of the screen. `from` is where its words start when that's above the line
 * `pattern` finds (a link under a heading, then the box it wants the code in). `link`
 * is the page its code goes to when the screen only says "click here"
 * ("https://accounts.x.ai/oauth2/device?user_code={code}").
 */
export type GateRule = { kind: GateKind; pattern: string; from?: string; link?: string };

/** What the screen in front of the prompt wants, for clients (`ask.gate`). */
export type Gate = {
  kind: GateKind;
  /** Links on the screen, whole again where the TUI broke them across lines. */
  links?: string[];
  /** A one-time code to enter on another page ("JUC6-GKWC4"). */
  code?: string;
  /** It takes typed text (a code pasted back, an API key): the line that asks for it. */
  input?: string;
  /** Its sign-in link returns to 127.0.0.1 or localhost: only a browser on this host finishes it. */
  local?: boolean;
  /**
   * Where that link hands back to ("http://127.0.0.1:1455/auth/callback"). A browser on
   * another device stops there on a page that won't load; the address it shows can be
   * handed to ah, which opens it here, where the agent listens (`POST …/gate` callback).
   */
  callback?: string;
  /** The screen says Esc goes back (or cancels), so Back is safe to offer. */
  back?: boolean;
};

export type GateRead = { gate: Gate; text: string; options?: ScreenOption[]; accept?: string };

export type CompiledGates = { rules: Array<{ kind: GateKind; shown: RegExp; from?: RegExp; link?: string }>; accept?: RegExp; ready?: RegExp };

/** A preset's trust prompt and its other screens, ready to test. */
export function compileGates(p: { trust?: { pattern: string; accept: string }; gates?: GateRule[]; ready?: string }): CompiledGates {
  const rules = (p.gates ?? []).map((g) => ({ kind: g.kind, shown: new RegExp(g.pattern, 'm'), ...(g.from ? { from: new RegExp(g.from, 'm') } : {}), ...(g.link ? { link: g.link } : {}) }));
  if (p.trust) rules.unshift({ kind: 'trust', shown: new RegExp(p.trust.pattern, 'm') });
  return { rules, ...(p.trust ? { accept: new RegExp(p.trust.accept) } : {}), ...(p.ready ? { ready: new RegExp(p.ready) } : {}) };
}

// Any agent's sign-in, preset or not: words that only a sign-in screen puts at the
// bottom, next to a way in (a picker row, a link, a code, a box to paste into).
const SIGNIN = /\b(?:sign(?:ing)?|log(?:ging)?)[ -]?in\b|\blogin\b|\bauthenticat|\bauthoriz|\bAPI key\b|\bdevice code\b|\bone-time code\b/i;
/** A row that is a way in ("Sign in with Device Code", "Login with Google"); a permission row starts Yes/No. */
const SIGNIN_ROW = /^(?:sign|log)[ -]?in\b|^login\b/i;
/**
 * A modal's own footer: the keys it takes ("Press esc to cancel", "enter submit • esc
 * exit", "↑/↓ to navigate": the arrows as a pair, never one alone, as in Claude Code's "↓ 827k
 * tokens"), or that it's waiting on you elsewhere ("Waiting for approval…"). An agent at its
 * prompt draws its input box there instead.
 */
const FOOTER = /\besc(?:ape)?\b.{0,12}\b(?:to )?(?:cancel|go back|back|exit|quit)\b|\bpress (?:enter|esc|any key|[a-z])\b|\benter(?: to)? (?:continue|confirm|select|submit|save|choose|validate)\b|[↑↓]\s*\/?\s*[↑↓]|\bwaiting for (?:sign|log|auth|approval|the browser|you)|\bverifying\b/i;
const BACK = /\besc(?:ape)?\b.{0,12}\b(?:to )?(?:cancel|go back|back)\b|\bpress esc\b|\besc (?:cancels|goes back)\b/i;
/** A line that asks for typed text: "Paste code here if prompted >", "Enter your Anthropic Key.", "Paste or type your API key below." */
const INPUT = /\b(?:paste|type|enter)\b.{0,40}\b(?:code|key|token)\b/i;
/** …or for an address ("Paste the URL you were redirected to"), when nothing asks for a code. */
const INPUT_URL = /\b(?:paste|enter)\s+(?:the|your)\b.{0,30}\burl\b/i;
/** A line-reading prompt at the very bottom: "Choice [1/2/3]:", "Set up a provider now? [Y/n]:", "…(or Enter to cancel):", "… if prompted >". */
const PROMPT = /[\])?]\s*:\s*$|\s>\s*$/;
const CODE_LINE = /^\s*([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,3})\s*$/;
const CODE_INLINE = /\bcode\b[^A-Za-z0-9\n]{1,20}([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,3})(?![A-Za-z0-9-])/;
const LINK = /https?:\/\/[^\s<>"'`│]+/g;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;
/** A redirect back to this machine: `redirect_uri=http://127.0.0.1:1455/…`, encoded or not. */
const LOCAL_REDIRECT = /[?&](?:redirect_uri|redirect_url|callback)=https?(?::|%3A)(?:\/\/|%2F%2F)(?:localhost|127\.0\.0\.1)\b/i;
/** Box borders, rules and empty box rows: a frame, not what the screen says. */
const FRAME = /^[\s│┃╭╮╰╯─━═╌╍┄┅]*$/;

/**
 * The screen in front of the agent's prompt, if one is up: one of the preset's own
 * (trust first), else any sign-in. Its picker counts only at the bottom of the
 * screen, and a sign-in without one only with a modal's footer under it, so an
 * agent's reply that talks about signing in, links and all, is never one.
 *
 * `above` is the scrollback over a short window (a phone with its keyboard up, or this
 * card under it): a sign-in's link and words may have scrolled up there, leaving its
 * footer alone on the screen. It's read only then, as if still on it: once the screen
 * reads by itself, what scrolled up is an earlier screen of the same sign-in.
 */
export function readGate(tail: string[], gates: CompiledGates, above: string[] = [], o: { hooked?: boolean } = {}): GateRead | null {
  const read = readScreen(tail, gates, [], !o.hooked);
  if (read || !above.length || !mayHaveScrolled(tail)) return read;
  return readScreen(tail, gates, above, !o.hooked);
}

/** A screen shorter than a sign-in reads that still talks about signing in: its scrollback may hold the rest. */
export function mayHaveScrolled(tail: string[]): boolean {
  const lines = tail.filter((l) => l.trim());
  return lines.length < 30 && SIGNIN.test(lines.join('\n'));
}

/**
 * `generic`: also any sign-in by its words (a link, a code or a box, under a modal's footer). Not
 * for an agent whose hooks have spoken: it's signed in (they don't run before), and its own
 * replies and commands ("authorization: Bearer …" beside a link) read as one. Its own screens
 * still count (`/login`'s picker when a sign-in has expired).
 */
function readScreen(tail: string[], gates: CompiledGates, above: string[], generic = true): GateRead | null {
  const lines = tail.filter((l) => l.trim());
  if (!lines.length) return null;
  // What the screen says, without its frame or its art (a logo, a QR code): "the
  // bottom" is its last words, whatever box or picture.
  const words = lines.filter((l) => !FRAME.test(l) && !isArt(l));
  const picker = parsePicker(lines);
  const pickerUp = !!picker && lines.slice(picker.end + 1).filter((l) => !FRAME.test(l)).length <= 6;
  const bottom = [...above.filter((l) => l.trim()), ...lines].filter((l) => !isArt(l)).slice(-30);
  const bottomText = bottom.join('\n');
  // A preset's screen counts near the bottom only: one an agent drew line by line stays
  // above its prompt once it has moved on (hermes, pi), and must not hold messages then.
  const near = words.slice(-16).join('\n');
  // An agent at its prompt keeps at least its input box and footer below its reply.
  const foot = words.slice(-2).map(unbox).join('\n');
  const code = readCode(bottom);
  // What it wants typed: a line that asks for a code or a key (not one that hands you a
  // code to enter elsewhere), else a line-reading prompt at the very bottom.
  const last = unbox(words.at(-1) ?? '');
  const asks = (re: RegExp) => bottom.map(unbox).find((l) => re.test(l) && !CODE_LINE.test(l) && l.length < 120 && !/^https?:/.test(l));
  const asked = code ? undefined : (asks(INPUT) ?? asks(INPUT_URL));
  const prompt = !pickerUp && PROMPT.test(last) && !/^https?:/.test(last) && last.length < 120 ? last : undefined;
  // A field drawn as a lone ">" (pi): what it asks is the line above, past an example.
  const tail6 = words.slice(-6).map(unbox);
  const field = tail6.findIndex((l) => l === '>');
  const fielded = field > 0 ? tail6.slice(0, field).reverse().find((l) => !/^e\.g\./i.test(l)) : undefined;
  const input = asked ?? prompt ?? fielded;

  // The screen it's on now is the lowest one matched: a first-run question can still
  // show above the sign-in it led to.
  const nearLines = near.split('\n');
  const lowest = (r: CompiledGates['rules'][number]) => nearLines.findLastIndex((l) => r.shown.test(l));
  let own: CompiledGates['rules'][number] | undefined = gates.rules.filter((r) => r.shown.test(near)).sort((a, b) => lowest(b) - lowest(a))[0];
  // An agent that draws line by line leaves a finished sign-in above its prompt: what
  // says it's ready, lower down, means that one is over.
  if (own && gates.ready && nearLines.findLastIndex((l) => gates.ready!.test(l)) > lowest(own)) own = undefined;
  // Its links are the ones from its own heading on, not an update notice's above it, and
  // a picker's (terms of service) stay in its words: the rows are the way in.
  const heading = own?.from ? bottom.findIndex((l) => own!.from!.test(l)) : -1;
  const anchor = heading >= 0 ? heading : Math.max(0, bottom.findIndex((l) => (own ? own.shown : SIGNIN).test(l)));
  const links = pickerUp ? [] : rank(readLinks(bottom.slice(anchor)), code);
  let kind: GateKind | null = null;
  let accept: string | undefined;
  if (own) {
    kind = own.kind;
    // A trust prompt is accepted from the row that trusts, once its picker shows it.
    const row = own.kind === 'trust' && pickerUp && gates.accept ? picker!.options.find((o) => gates.accept!.test(o.label)) : undefined;
    if (row) accept = row.key;
  } else if (generic && SIGNIN.test(bottomText)) {
    // A picker is a sign-in only by its rows: a permission prompt to run `gh auth
    // login` (a link in its command, "Esc to cancel" under it) is not one.
    const footed = FOOTER.test(foot) || (!!input && foot.includes(input));
    if (pickerUp ? picker!.options.some((o) => SIGNIN_ROW.test(o.label)) : (links.length || code || input) && footed) kind = 'signin';
  }
  if (!kind) return null;

  // A screen that only says "click here" gets its page from the preset.
  if (own?.link && code && !links.length) links.push(own.link.replace('{code}', encodeURIComponent(code)));
  const gate: Gate = {
    kind,
    ...(links.length ? { links } : {}),
    ...(code ? { code } : {}),
    ...(input && !pickerUp ? { input } : {}),
    ...(links.some((l) => LOCAL_REDIRECT.test(l)) ? { local: true } : {}),
    ...callbackOf(links),
    ...(BACK.test(words.slice(-6).map(unbox).join('\n')) ? { back: true } : {}),
  };
  const text = pickerUp ? readable(picker!.context.split('\n')) : readable(joinLinks(bottom.slice(anchor)).slice(-16));
  return { gate, text, ...(pickerUp ? { options: picker!.options } : {}), ...(accept ? { accept } : {}) };
}

/** Where the first link that hands back to this host does: its redirect's origin and path. */
function callbackOf(links: string[]): { callback?: string } {
  for (const l of links) {
    if (!LOCAL_REDIRECT.test(l)) continue;
    try {
      const u = new URL(l);
      const back = new URL(u.searchParams.get('redirect_uri') ?? u.searchParams.get('redirect_url') ?? u.searchParams.get('callback') ?? '');
      return { callback: back.origin + back.pathname };
    } catch {}
  }
  return {};
}

/**
 * Whether `pasted` is the address a browser ended on after the sign-in `gate` sent it
 * to: this host's loopback, the redirect's port and path, and the sign-in's own `state`
 * when its link carries one. Only then is it opened here (a GET, as the browser would).
 */
export function callbackFor(gate: Gate, pasted: string): URL | null {
  if (!gate.callback) return null;
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return null;
  }
  const want = new URL(gate.callback);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  if (url.port !== want.port || url.pathname !== want.pathname) return null;
  const state = gate.links?.map((l) => new URL(l).searchParams.get('state')).find(Boolean);
  if (state && url.searchParams.get('state') !== state) return null;
  return new URL(want.origin + url.pathname + url.search);
}

/** The page to open first: the one carrying the code, then a sign-in page, then the rest. */
function rank(links: string[], code: string | undefined): string[] {
  const score = (l: string) => (code && l.includes(code) ? 2 : 0) + (/device|activate|authori[sz]e|oauth|login|signin/i.test(l) ? 1 : 0);
  return [...links].sort((a, b) => score(b) - score(a));
}

/** A boxed line's words, without its borders. */
function unbox(l: string): string {
  return l.replace(/^[\s│┃]+|[\s│┃]+$/g, '').trim();
}

/** What a picker's own footer says: "Press enter to continue", "↑/↓ to navigate", "Esc to cancel". */
const PICKER_FOOT = /\b(?:enter|esc)\b[^\n]*\b(?:to|then)\b|\bto (?:navigate|select|confirm|continue|cancel)\b|[↑↓]|\bup\/down\b/i;

/**
 * A picker is the screen's active part: its last row near the bottom, its footer
 * under it. An agent at its prompt draws its input box there instead, so a numbered
 * list in its reply never counts.
 */
export function pickerAtBottom(tail: string[]): boolean {
  const lines = tail.filter((l) => l.trim());
  const p = parsePicker(lines);
  const foot = lines.slice(-2).join('\n');
  return !!p && lines.length - 1 - p.end <= 6 && PICKER_FOOT.test(foot) && !/\binterrupt\b/i.test(foot);
}

/** Links on the screen, whole. */
export function readLinks(lines: string[]): string[] {
  return [...new Set(linkSpans(lines).map((s) => s.url))];
}

/**
 * Each link and the lines it covers. A TUI breaks a long one at the window's edge
 * with no space, so a link that runs to the edge goes on into the next line. The edge
 * is the widest line from the link down: what's above may be from before the window
 * was narrowed (scrollback a phone pushed up).
 */
function linkSpans(lines: string[]): Array<{ url: string; from: number; to: number; at: number }> {
  const below = lines.map((l) => l.trimEnd().length);
  for (let i = below.length - 2; i >= 0; i--) below[i] = Math.max(below[i], below[i + 1]);
  const out: Array<{ url: string; from: number; to: number; at: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const width = below[i];
    const line = lines[i].trimEnd();
    for (const m of line.matchAll(LINK)) {
      let url = m[0];
      let j = i;
      // Only the last link on a line can carry on, and only from a line at the edge.
      while (m.index + m[0].length === line.length && lines[j].trimEnd().length >= Math.max(40, width - 1) && j + 1 < lines.length) {
        // What carries on starts the next line at its edge too (a TUI's wrap restarts at
        // the margin), is URL-shaped, and isn't a list's next item ("2. If prompted…").
        // A block indented as a whole (Gemini's) wraps to its own margin: there only a
        // line that is all link carries on, so the words under it never join.
        const indent = lines[j + 1].match(/^\s*/)![0].length;
        const hanging = indent >= 2 && indent === line.match(/^\s*/)![0].length;
        if (indent >= 2 && !hanging) break;
        const next = lines[j + 1].trim().match(URL_CHARS)?.[0];
        if (hanging && next !== lines[j + 1].trim()) break;
        if (!next || /^https?:/.test(next) || /^\d+[.)]$/.test(next)) break;
        url += next;
        j++;
        if (next.length < lines[j].trim().length) break;
      }
      out.push({ url: url.replace(/[.,;:]+$/, ''), from: i, to: j, at: m.index });
    }
  }
  return out;
}

/** The lines with each broken link back on its first line, whole. */
function joinLinks(lines: string[]): string[] {
  const out = [...lines];
  for (const s of linkSpans(lines).reverse()) {
    if (s.to === s.from) continue;
    out.splice(s.from, s.to - s.from + 1, lines[s.from].slice(0, s.at) + s.url);
  }
  return out;
}

function readCode(lines: string[]): string | undefined {
  for (const l of lines) {
    // On a line of its own, letters alone are a code too ("JVSW-GRZKI"); inside a
    // sentence only one with a digit is, so "READ-ONLY" never reads as one.
    const own = l.match(CODE_LINE)?.[1];
    if (own && /[A-Z]/.test(own) && (/\d/.test(own) || own.split('-').every((g) => g.length >= 4))) return own;
    // After "code:" it's the code even in letters alone ("Enter code: BVLH-TCLG"), if
    // each part is as long as a code's.
    const inline = l.match(CODE_INLINE)?.[1];
    if (inline && /[A-Z]/.test(inline) && (/\d/.test(inline) || inline.split('-').every((g) => g.length >= 4))) return inline;
  }
  return undefined;
}

/** A line drawn in braille or block characters: a logo, a QR code. */
function isArt(l: string): boolean {
  const ink = l.replace(/\s/g, '');
  return !!ink && (ink.match(/[⠀-⣿▀-▟░▒▓╱╲]/g) ?? []).length / ink.length >= 0.3;
}

/**
 * Braille logos and box rules frame a TUI's screen, a one-line box is its input
 * field (the card has its own), and a cursor glyph marks where it is: what's left
 * reads as text.
 */
function readable(lines: string[]): string {
  const field = new Set<number>();
  lines.forEach((l, i) => {
    if (/^\s*╭/.test(l) && /^\s*╰/.test(lines[i + 2] ?? '')) [i, i + 1, i + 2].forEach((j) => field.add(j));
  });
  const kept = lines
    .filter((l, i) => !field.has(i))
    .map((l) => l.replace(/^(\s*)[>›❯▶→](\s+)/, '$1 $2'))
    .filter((l) => l.trim() && !isArt(l) && !/^[\s─━╌╍┄┅┈┉═╭╮╰╯┌┐└┘│.]+$/.test(l))
    .map((l) => l.replace(/^\s*[│┃]\s?|\s*[│┃]\s*$/g, '').replace(/^\s*╭[─━]*|[─━]*╮\s*$/g, ''));
  const pad = Math.min(...kept.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return kept.map((l) => l.slice(Number.isFinite(pad) ? pad : 0).trimEnd()).join('\n');
}
