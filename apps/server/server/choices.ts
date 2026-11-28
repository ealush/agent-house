// Answering an agent's picker from outside its terminal: numbered option lists
// read off the screen (permission prompts), and Claude Code's multi-question
// AskUserQuestion dialog. Pure functions; core.ts types the steps.

export type ScreenOption = {
  /** What gets typed: the option's digit, or its own hotkey ("(y)") when it shows one. */
  key: string;
  label: string;
  /** The line under the row, at its text's indent ("Sign in from another device with a one-time code"). */
  description?: string;
};

export type Question = {
  question: string;
  header?: string;
  multiSelect: boolean;
  /** `preview`: what the option looks like (a mockup, a snippet), shown beside the options. */
  options: Array<{ label: string; description?: string; preview?: string }>;
};

/**
 * One answer per question: picked option indexes (0-based) and/or free text ("Type something").
 * A question whose options carry previews has no free-text row; it takes `notes` on the pick
 * instead (the dialog's "n to add notes").
 */
export type Answer = { picked: number[]; text?: string; notes?: string };

/** Previews make Claude Code draw a different dialog: ↑/↓ and Enter, notes, no free-text row. */
export function hasPreviews(q: Pick<Question, 'options'>): boolean {
  return q.options.some((o) => !!o.preview);
}

/** A step: tmux key names, or literal text. */
export type Step = { keys: string[] } | { text: string };

// "1. Yes", "❯ 2) No", or a digit set off by two spaces ("⟩ 1  Trust and continue", Muse).
const OPTION = /^\s*(?:[❯›>▶●⟩]\s*)?(\d{1,2})(?:[.)]\s+|\s{2,})(\S.*?)\s*$/;
const CURSOR = /^\s*[❯›>▶⟩]/;
/** A row inside a drawn box ("│ ● 1. Trust folder │", Gemini): its text, and that it was boxed. */
const BOXED = /^\s*│\s?(.*?)\s*│?\s*$/;

/**
 * The numbered options at the bottom of a waiting agent's screen ("❯ 1. Yes",
 * "  2. Yes, and don't ask again", "  3. No"). Only a run that counts up from 1
 * with a cursor on one of its rows counts; anything else (a numbered list in the
 * agent's prose) returns nothing.
 */
export function parseScreenOptions(lines: string[]): ScreenOption[] {
  return parsePicker(lines)?.options ?? [];
}

/**
 * The picker and what it is about: up to `max` lines above its first row (the
 * command to approve, a dialog's summary), stopping at a rule or the screen top.
 */
export function parsePicker(lines: string[], max = 8): { options: ScreenOption[]; context: string; cursor?: number; end: number } | null {
  return parseNumbered(lines, max) ?? parseCursorList(lines, max) ?? parseHotkeyList(lines, max) ?? parseRadioList(lines, max) ?? parsePlanReview(lines);
}

/**
 * Grok's plan, shown for approval: a box over a "c:comment │ … │ a:approve │ q:quit plan"
 * footer, its keys in a bar at the box's foot ("a approve  |  s request changes  |  c comment
 * |  q quit plan"). Offered: the keys that act at once; "request changes" and "comment" open
 * a text box.
 */
function parsePlanReview(lines: string[]): { options: ScreenOption[]; context: string; end: number } | null {
  const footer = lines.findLastIndex((l) => /\ba:approve\b.*\bq:quit plan\b/.test(l));
  if (footer < 1) return null;
  for (let i = footer - 1; i >= 0 && i >= footer - 12; i--) {
    const inner = (lines[i].match(BOXED)?.[1] ?? lines[i]).trim();
    const keys = inner.split(/\s+\|\s+/).map((k) => k.match(/^([a-z]) ([a-z].*)$/));
    if (keys.length < 2 || keys.some((k) => !k)) continue;
    const options = keys.filter((k) => /^(approve|quit plan)$/.test(k![2])).map((k) => ({ key: k![1], label: k![2][0].toUpperCase() + k![2].slice(1) }));
    return options.length ? { options, context: 'Approve the plan?', end: i } : null;
  }
  return null;
}

// Grok's dialogs, drawn on a bar ("┃") over a footer: a command to approve ("2 (●) Yes,
// proceed" / "3 (○) No, reject" over "2/4:select │ Tab:next option") and its questions
// ("1 (○) Write the plan" with a line or two under it, over "Tab:next answer"). A row's key
// picks it and submits. Not offered: a row without a key (reached only by Tab: "always-approve
// mode") and the one that opens a text box ("z (○) Type your answer here").
const RADIO = /^\s*┃?\s*(\d{1,2}|[a-z])?\s+\(([●○])\)\s+(\S.*?)\s*$/;
const BAR = /^\s*┃\s?(.*)$/;

function parseRadioList(lines: string[], max: number): { options: ScreenOption[]; context: string; cursor: number; end: number } | null {
  const footer = lines.findLastIndex((l) => /^\s*\d+\/\d+:select\b|^\s*Tab:next answer\b/.test(l));
  if (footer < 1) return null;
  // The bar above the footer (its empty lines too).
  let top = footer;
  while (top > 0 && (BAR.test(lines[top - 1]) || !lines[top - 1].trim())) top--;
  // Down it: what it asks about, then the rows, each with the lines set under it.
  type Row = { key?: string; label: string; cursor: boolean; description?: string };
  const about: string[] = [];
  const rows: Row[] = [];
  let end = -1;
  for (let i = top; i < footer; i++) {
    const r = lines[i].match(RADIO);
    if (r) {
      // A question's option with its description set beside it ("Red   Prefer the color red").
      const [label, beside] = r[3].split(/\s{2,}(.*)/);
      rows.push({ key: r[1], label, cursor: r[2] === '●', ...(beside ? { description: beside } : {}) });
      end = i;
      continue;
    }
    const text = (lines[i].match(BAR)?.[1] ?? '').trim();
    // Empty, or the dialog's own hints ("↑/↓ navigate · y copy   Enter:submit").
    if (!text || /navigate\b.*Enter:submit|^Enter:submit/.test(text)) continue;
    const row = rows.at(-1);
    if (row) row.description = row.description ? `${row.description} ${text}` : text;
    // A title ("›  Run tests") and the command in a gutter ("│ pnpm test", "┆ " where it goes
    // on, "·" at a line's end), or a question.
    else about.push(text.replace(/^(?:›|[│┆])\s*/, '').replace(/\s*·$/, ''));
  }
  const offered = rows.filter((r) => r.key && !/^Type your answer/i.test(r.label));
  if (!offered.length || rows.length < 2) return null;
  const options = offered.map((r) => ({ key: r.key!, label: r.label, ...(r.description ? { description: r.description } : {}) }));
  return { options, context: about.slice(-max).join('\n'), cursor: Math.max(0, offered.findIndex((r) => r.cursor)), end };
}

const HOTKEY_ROW = /^(\s*)(\S.*?\S)\s{4,}([a-z])$/;

/**
 * Rows that each end in their own one-letter hotkey, set well apart from the label
 * and drawn without a cursor glyph ("Yes, proceed        y" / "No, quit        n",
 * Grok's trust prompt). The last such run of two or more rows at one indent counts.
 */
function parseHotkeyList(lines: string[], max: number): { options: ScreenOption[]; context: string; end: number } | null {
  for (let end = lines.length - 1; end > 0; end--) {
    const last = lines[end].match(HOTKEY_ROW);
    if (!last) continue;
    let start = end;
    while (start > 0) {
      const m = lines[start - 1].match(HOTKEY_ROW);
      if (!m || m[1].length !== last[1].length) break;
      start--;
    }
    const rows = lines.slice(start, end + 1).map((l) => l.match(HOTKEY_ROW)!);
    if (rows.length < 2 || new Set(rows.map((r) => r[3])).size !== rows.length) {
      end = start;
      continue;
    }
    return { options: rows.map((r) => ({ key: r[3], label: r[2] })), context: contextAbove(lines, start, max), end };
  }
  return null;
}

/** Lines above row `start`: what the picker is about, up to a rule or `max` lines. */
function contextAbove(lines: string[], start: number, max: number): string {
  const above: string[] = [];
  for (let i = start - 1; i >= 0 && above.length < max; i--) {
    if (/^\s*[─━╭╰│]{3,}/.test(lines[i]) || /^\s*[╭╰]/.test(lines[i])) break;
    // A boxed row loses its borders and the box's padding; an empty one is dropped.
    const text = lines[i].replace(/^\s*│\s?|\s*│\s*$/g, '');
    if (text.trim()) above.unshift(text);
  }
  return dedent(above).join('\n');
}

/**
 * A picker without numbers ("❯ No, exit / Yes, I trust this folder", or agy's "> Yes, I
 * trust this folder / No, exit") right above an "Enter to confirm" footer: rows aligned with the cursor row's text. Its keys are
 * `nav:<index>`; the server turns one into arrow moves from the cursor, then Enter.
 */
function parseCursorList(lines: string[], max: number): { options: ScreenOption[]; context: string; cursor: number; end: number } | null {
  // "Enter to confirm · Esc to cancel" (Claude Code), "↑↓ navigate  enter select" (pi),
  // "↑/↓ Navigate · enter Confirm" (agy; not its slash-command list, "· tab Complete").
  const footer = lines.findLastIndex((l) => /Enter to (confirm|select|continue)|[↑↓]{2}\s+navigate\s+enter select|[↑↓]\/[↑↓] Navigate · enter (confirm|select)\b(?!.*\btab Complete)/i.test(l));
  if (footer < 1) return null;
  let end = footer - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  const cursorAt = (() => {
    for (let i = end; i >= 0 && i > end - 20; i--) if (/^\s*[❯→>]\s+\S/.test(lines[i])) return i;
    return -1;
  })();
  if (cursorAt < 0) return null;
  const glyph = lines[cursorAt].trimStart()[0];
  const indent = lines[cursorAt].indexOf(glyph) + 2;
  const row = (l: string) => {
    const m = l.match(glyph === '❯' ? /^(\s*)❯\s+(\S.*)$/ : glyph === '>' ? /^(\s*)>\s+(\S.*)$/ : /^(\s*)→\s+(\S.*)$/);
    if (m && m[1].length + 2 === indent) return { label: m[2].trim(), cursor: true };
    return l.length > indent && l.slice(0, indent).trim() === '' && /\S/.test(l[indent]) ? { label: l.trim(), cursor: false } : null;
  };
  let start = cursorAt;
  while (start > 0 && row(lines[start - 1])) start--;
  const rows = lines.slice(start, end + 1).map(row);
  if (rows.length < 2 || rows.some((r) => !r)) return null;
  const options = rows.map((r, j) => ({ key: `nav:${j}`, label: r!.label }));
  return { options, context: contextAbove(lines, start, max), cursor: rows.findIndex((r) => r!.cursor), end };
}

/** Keys that pick row `target` of a cursor list whose cursor is on `cursor`. */
export function cursorKeys(cursor: number, target: number): string[] {
  const n = target - cursor;
  return [...Array(Math.abs(n)).fill(n > 0 ? 'Down' : 'Up'), 'Enter'];
}

function parseNumbered(lines: string[], max: number): { options: ScreenOption[]; context: string; end: number } | null {
  let best: Array<{ n: number; label: string; cursor: boolean; col: number; description?: string }> = [];
  let bestStart = -1;
  let bestEnd = -1;
  // How wide the window lets text run, inside a box when there is one: a line that
  // reaches it may go on in the next, wherever the TUI starts that one.
  const inner = lines.map((l) => (l.match(BOXED)?.[1] ?? l).trimEnd());
  const width = Math.max(0, ...inner.map((l) => l.length));
  let run: typeof best = [];
  let start = -1;
  let wrapping = false;
  for (const [i, drawn] of lines.entries()) {
    // Inside a box, "●" marks the selected row (Gemini's radio list); outside one it
    // starts the agent's reply, which may well open with a numbered list.
    const boxed = drawn.match(BOXED);
    const line = boxed ? boxed[1] : drawn;
    const m = line.match(OPTION);
    if (m) {
      const n = Number(m[1]);
      const row = { n, label: m[2], cursor: CURSOR.test(line) || (!!boxed && /^\s*●/.test(line)), col: line.indexOf(m[2]) };
      if (n === run.length + 1) run.push(row);
      else if (n === 1) run = [row];
      else run = [];
      if (n === 1) start = i;
      if (run.length >= 2 && run.some((o) => o.cursor)) {
        best = [...run];
        bestStart = start;
        bestEnd = i;
      }
      wrapping = true;
      continue;
    }
    // A label the agent wrapped continues on the next line, aligned with its text
    // ("2. Yes, and switch to accept edits (… common file" / "   commands) …"). Under
    // a row that stopped short of the edge, that line is the row's description instead
    // ("1. Sign in with ChatGPT" / "   Usage included with Plus, Pro…").
    // A narrow window (a phone attached) wraps either one back to the first column.
    // The line above stopped at the edge when it reached it, or when this line's first
    // word wouldn't have fit after it: a long path wraps whole, or at its "-" (agy).
    const last = run.at(-1);
    const indent = line.length - line.trimStart().length;
    const word = line.trimStart().match(/^\S+/)?.[0].length ?? 0;
    // agy wraps its rows a few columns short of the window, so that can't tell: a line
    // under a row, with only such lines between it and the next row, is that row's too.
    const atEdge = i > 0 && (inner[i - 1].length >= width - 12 || inner[i - 1].length + 1 + word > width || (!!last && indent < last.col && beforeNext(lines, i, last.n)));
    if (wrapping && last && line.trim() && (indent === last.col || (atEdge && indent < last.col))) {
      if (last.description === undefined && atEdge) {
        // A break inside a token longer than the line (a path) was the window's, not a space,
        // and so was one after a "-" ("--" / "delete"); one that closes its quote or bracket
        // had ended ("…/Sources/...'" / "(Persist…").
        const token = last.label.slice(last.label.lastIndexOf(' ') + 1);
        last.label += `${(token.length > 24 && !/['")\]]$/.test(token)) || /\S-$/.test(token) ? '' : ' '}${line.trim()}`;
      } else last.description = last.description ? `${last.description} ${line.trim()}` : line.trim();
      continue;
    }
    wrapping = false;
    // Indented description lines and blank separators stay inside a run;
    // a flush-left line of prose ends it.
    if (line.trim() && !/^\s{2,}/.test(line) && !/^[─━-]{3,}/.test(line.trim())) run = [];
  }
  if (!best.length) return null;
  const options = best.map((o) => {
    const hot = o.label.match(/\s\(([a-z])\)$/i);
    const label = o.label.replace(/\s\([a-z]\)$/i, '').replace(/^\[[ x✔]\]\s*/i, '').trim();
    return { key: hot ? hot[1].toLowerCase() : String(o.n), label, ...(o.description ? { description: o.description } : {}) };
  });
  return { options, context: contextAbove(lines, bestStart, max), end: bestEnd };
}

/** Whether the lines after `i` go on, without a blank line, to row `n + 1`. */
function beforeNext(lines: string[], i: number, n: number): boolean {
  for (const drawn of lines.slice(i + 1)) {
    const line = drawn.match(BOXED)?.[1] ?? drawn;
    if (!line.trim()) return false;
    const m = line.match(OPTION);
    if (m) return Number(m[1]) === n + 1;
  }
  return false;
}

function dedent(lines: string[]): string[] {
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return Number.isFinite(pad) ? lines.map((l) => l.slice(pad)) : lines;
}

/** Normalizes AskUserQuestion's tool input; null when it isn't one. */
export function readQuestions(input: unknown): Question[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  const out: Question[] = [];
  for (const q of qs) {
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return null;
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: q.options
        .filter((o: unknown) => o && typeof (o as { label?: unknown }).label === 'string')
        .map((o: { label: string; description?: unknown; preview?: unknown }) => ({
          label: o.label,
          description: typeof o.description === 'string' ? o.description : undefined,
          ...(typeof o.preview === 'string' && o.preview.trim() ? { preview: o.preview.slice(0, 4000) } : {}),
        })),
    });
  }
  return out;
}

/** Throws a message for the caller when the answers don't fit the questions. */
export function checkAnswers(questions: Question[], answers: Answer[]): void {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('answer every question');
  answers.forEach((a, i) => {
    const q = questions[i];
    if (!a || !Array.isArray(a.picked)) throw new Error(`question ${i + 1}: no answer`);
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (a.picked.some((p) => !Number.isInteger(p) || p < 0 || p >= q.options.length)) throw new Error(`question ${i + 1}: unknown option`);
    if (new Set(a.picked).size !== a.picked.length) throw new Error(`question ${i + 1}: an option is picked twice`);
    if (/[\r\n]/.test(text)) throw new Error(`question ${i + 1}: the typed answer must be one line`);
    const notes = typeof a.notes === 'string' ? a.notes.trim() : '';
    if (/[\r\n]/.test(notes)) throw new Error(`question ${i + 1}: notes must be one line`);
    if (hasPreviews(q)) {
      if (text) throw new Error(`question ${i + 1}: this question takes a pick (and notes), not a typed answer`);
      if (a.picked.length !== 1) throw new Error(`question ${i + 1}: pick one option`);
    } else if (notes) throw new Error(`question ${i + 1}: notes go with an option's preview`);
    if (!q.multiSelect && a.picked.length + (text ? 1 : 0) !== 1) throw new Error(`question ${i + 1}: pick one option or type an answer`);
    if (q.multiSelect && a.picked.length === 0 && !text) throw new Error(`question ${i + 1}: pick at least one option`);
    // Option rows hold at most 9 digits, and the free-text row sits after them.
    if (q.options.length > 8) throw new Error(`question ${i + 1}: too many options to answer by key`);
  });
}

/**
 * Keys for Claude Code's AskUserQuestion dialog (verified against v2.1.288):
 *  - single choice: the option's digit picks it and moves on; the row after the
 *    options is "Type something", where typed text lands, then Enter.
 *  - multi choice: digits toggle without moving the cursor; text needs the cursor
 *    on the free-text row (↓ from the first row) and ticks it as you type. → (or
 *    Tab, Enter from the text row) moves on.
 *  - more than one question, or any multi choice, ends on a review tab: "1" submits.
 * The dialog opens on the first question with the cursor on its first option.
 */
export function claudeQuestionSteps(questions: Question[], answers: Answer[]): Step[] {
  return claudeQuestionGroups(questions, answers).flat();
}

/**
 * The same steps in groups: one per question, then the review's submit. ah
 * re-reads the screen before each group (dialogAt), so input from anywhere
 * else (a terminal typing into the same pane) can't make the rest of the
 * answers land on a different question: it stops instead.
 */
export function claudeQuestionGroups(questions: Question[], answers: Answer[]): Step[][] {
  checkAnswers(questions, answers);
  const groups: Step[][] = questions.map((q, i) => {
    const a = answers[i];
    const text = a.text?.trim() ?? '';
    const n = q.options.length;
    if (hasPreviews(q)) return previewSteps(1, a);
    if (!q.multiSelect) return text ? [{ keys: [String(n + 1)] }, { text }, { keys: ['Enter'] }] : [{ keys: [String(a.picked[0] + 1)] }];
    const steps: Step[] = [...a.picked].sort((x, y) => x - y).map((p) => ({ keys: [String(p + 1)] }));
    if (text) steps.push({ keys: Array(n).fill('Down') }, { text }, { keys: ['Tab'] }, { keys: ['Enter'] });
    else steps.push({ keys: ['Right'] });
    return steps;
  });
  if (questions.length > 1 || questions.some((q) => q.multiSelect)) groups.push([{ keys: ['1'] }]);
  return groups;
}

/**
 * A preview question (verified against v2.1.300): digits only move the cursor; ↑/↓ to the
 * option, then Enter picks it and moves on. "n" opens its notes; typed text lands there, and
 * Enter keeps the notes and picks the option in one go.
 */
function previewSteps(cursor: number, a: Answer): Step[] {
  const move = a.picked[0] + 1 - cursor;
  const steps: Step[] = move ? [{ keys: Array(Math.abs(move)).fill(move > 0 ? 'Down' : 'Up') }] : [];
  const notes = a.notes?.trim() ?? '';
  if (notes) steps.push({ keys: ['n'] }, { text: notes });
  steps.push({ keys: ['Enter'] });
  return steps;
}

/**
 * "Chat about this": the dialog's last row, under its rule. Choosing it declines the questions
 * and hands the conversation back, so you can talk it over with the agent instead. From the
 * question's first row it's past the options, the free-text row and (multi choice) Submit;
 * a preview question has only its options above it (verified against v2.1.300).
 */
export function chatSteps(q: Pick<Question, 'options' | 'multiSelect'> & { previews?: boolean }, cursor = 1): Step[] {
  const rows = (q.previews ?? hasPreviews(q)) ? q.options.length : q.options.length + (q.multiSelect ? 2 : 1);
  const move = rows + 1 - cursor;
  return [...(move > 0 ? [{ keys: Array(move).fill('Down') }] : []), { keys: ['Enter'] }];
}

/**
 * Before group `i` of claudeQuestionGroups: the dialog is on question i, with
 * the earlier ones answered and nothing picked yet on this one; past the last
 * question, the review is up.
 */
export function dialogAt(screen: string, questions: Question[], i: number): boolean {
  if (i === 0) return pickerAtStart(screen, questions);
  if (i >= questions.length) return /Ready to submit your answers\?/.test(screen) && /^\s*❯\s*1\.\s+Submit answers/m.test(screen);
  const d = parseQuestionDialog(screen.split('\n').map((l) => l.trimEnd()));
  if (d) return words(d.question).includes(words(questions[i].question).slice(0, 40)) && d.answered === i && d.cursor === 1 && !d.options.some((o) => o.checked);
  // A pane too short to show the question (a phone's terminal): its option rows say which it is.
  return untouchedAt(screen, questions) === i;
}

/** Text as words: Claude draws a question with a "│" gutter down its left, which isn't part of it. */
const words = (s: string) => s.replace(/│/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A pane shorter than the dialog (a phone's terminal, the keyboard up) shows only the option rows
 * around the cursor, under the questions and tabs scrolled out of view. Which question is on screen,
 * untouched (cursor on its first row, nothing ticked), when its visible rows match exactly one of
 * the questions' options by number and label; -1 when they match none, or several.
 */
export function untouchedAt(screen: string, questions: Question[]): number {
  if (!/^\s*(?:[↑↓]\s*)?❯\s*1\.\s/m.test(screen) || /\[✔\]/.test(screen)) return -1;
  const rows = screen.split('\n').map((l) => l.match(ROW)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ n: Number(m[2]), label: m[4] }))
    .filter((r) => !/^(Type something\.?|Chat about this|Submit answers|Cancel)$/.test(r.label));
  if (!rows.length) return -1;
  const fits = questions.map((q, i) => (rows.every((r) => q.options[r.n - 1]?.label === r.label) ? i : -1)).filter((i) => i >= 0);
  return fits.length === 1 ? fits[0] : -1;
}

/**
 * The steps above assume the dialog is fresh: on the first question, cursor on
 * its first row, nothing answered. Anything else (answered halfway in the
 * terminal, a different dialog) must not get keys typed into it.
 */
export function pickerAtStart(screen: string, questions: Question[]): boolean {
  if (!/Enter to select/.test(screen)) return false;
  if (!words(screen).includes(words(questions[0].question).slice(0, 40))) {
    // Another question on screen is another question, whatever its options. Only when none can
    // be read (scrolled out of a short pane) do the visible option rows say which it is.
    if (parseQuestionDialog(screen.split('\n').map((l) => l.trimEnd()))) return false;
    if (questions.length > 1 && /☒/.test(screen)) return false;
    return untouchedAt(screen, questions) === 0;
  }
  if (!/^\s*(?:[↑↓]\s*)?❯\s*1\.\s/m.test(screen)) return false;
  // Multi-question dialogs draw a tab bar; ☒ marks a question already answered.
  if (questions.length > 1 && /☒/.test(screen)) return false;
  return true;
}

/** The question Claude's dialog is showing right now, read off the screen. */
export type ScreenQuestion = {
  question: string;
  multiSelect: boolean;
  /** `preview`: only the option under the cursor shows its preview on screen. */
  options: Array<{ label: string; description?: string; checked?: boolean; preview?: string }>;
  /** Drawn with previews: the box beside the options, notes, no free-text row. */
  previews?: boolean;
  /** 1-based row the cursor is on: options, then "Type something", then (multi) Submit. */
  cursor: number;
  /** Tab bar: how many questions there are and how many are answered. */
  total: number;
  answered: number;
};

// A list scrolled to fit a short pane marks the rows at its cut with ↑ or ↓.
const ROW = /^\s*(?:[↑↓]\s*)?(❯\s*)?(\d{1,2})\.\s+(?:\[([ ✔])\]\s+)?(.*?)\s*$/;

/**
 * Hookless sessions: the dialog's current question, its options and their state.
 * Claude writes the AskUserQuestion call to its transcript only once it's answered,
 * so the screen is the only source while it's open. Null when the screen isn't a
 * fresh-enough dialog to answer (text already typed into its free-text row).
 */
export function parseQuestionDialog(lines: string[]): ScreenQuestion | null {
  const footer = lines.findLastIndex((l) => /Enter to select/.test(l));
  if (footer < 0) return null;
  const bar = lines.findLastIndex((l, i) => i < footer && /[☐☒]/.test(l));
  if (bar < 0) return null;
  const tabs = lines[bar].match(/[☐☒]/g) ?? [];
  const body = lines.slice(bar + 1, footer);
  const first = body.findIndex((l) => ROW.test(l));
  if (first < 1) return null;
  const question = body.slice(0, first).map((l) => l.trim().replace(/^│\s?/, '')).filter(Boolean).join(' ');
  const options: ScreenQuestion['options'] = [];
  let multiSelect = false;
  let cursor = 0;
  let other = false;
  // A preview question draws the cursor option's preview in a box to the right of the options.
  const boxAt = body.slice(first).map((l) => l.search(/[┌│└]/)).filter((c) => c > 0);
  const previews = boxAt.length > 0;
  const column = previews ? Math.min(...boxAt) : Infinity;
  const preview: string[] = [];
  for (const raw of body.slice(first)) {
    if (/^\s*[─━]{3,}/.test(raw)) break; // "Chat about this" sits under the rule
    const box = previews ? raw.slice(column) : '';
    const line = previews ? raw.slice(0, column).trimEnd() : raw;
    const inner = box.match(/^│ ?(.*?) ?│\s*$/);
    if (inner) preview.push(inner[1].trimEnd());
    if (previews && !line.trim()) continue; // the box's own rows, and its notes line
    const m = line.match(ROW);
    if (m) {
      if (m[3] !== undefined) multiSelect = true;
      if (m[1]) cursor = Number(m[2]);
      if (/^Type something\.?$/.test(m[4])) {
        other = true;
        continue;
      }
      if (other) return null; // typed text replaced the row's label; leave it to the terminal
      options.push({ label: m[4], ...(m[3] !== undefined ? { checked: m[3] === '✔' } : {}) });
      continue;
    }
    if (/^\s*❯\s*Submit\s*$/.test(line)) cursor = options.length + 2;
    else if (!/^\s*Submit\s*$/.test(line) && line.trim() && options.length && !other) {
      const last = options[options.length - 1];
      last.description = [last.description, line.trim()].filter(Boolean).join(' ');
    }
  }
  if (!question || !options.length || !cursor || (!other && !previews)) return null;
  if (previews && options[cursor - 1] && preview.length) options[cursor - 1].preview = preview.join('\n');
  return { question, multiSelect, options, cursor, total: tabs.length, answered: tabs.filter((t) => t === '☒').length, ...(previews ? { previews } : {}) };
}

/** Keys for the question on screen, from its current state (ticks and cursor). */
export function dialogSteps(q: ScreenQuestion, a: Answer): Step[] {
  // Only the cursor's preview is on screen; the dialog's shape is what counts.
  const options = q.previews ? q.options.map((o) => ({ ...o, preview: o.preview ?? ' ' })) : q.options;
  checkAnswers([{ question: q.question, multiSelect: q.multiSelect, options }], [a]);
  if (q.previews) return previewSteps(q.cursor, a);
  const text = a.text?.trim() ?? '';
  const n = q.options.length;
  if (!q.multiSelect) return text ? [{ keys: [String(n + 1)] }, { text }, { keys: ['Enter'] }] : [{ keys: [String(a.picked[0] + 1)] }];
  const steps: Step[] = [];
  q.options.forEach((o, i) => {
    if (!!o.checked !== a.picked.includes(i)) steps.push({ keys: [String(i + 1)] });
  });
  if (text) {
    const move = n + 1 - q.cursor;
    if (move) steps.push({ keys: Array(Math.abs(move)).fill(move > 0 ? 'Down' : 'Up') });
    steps.push({ text }, { keys: ['Tab'] }, { keys: ['Enter'] });
  } else steps.push({ keys: ['Right'] });
  return steps;
}
