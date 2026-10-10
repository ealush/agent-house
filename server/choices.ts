// Answering an agent's picker from outside its terminal: numbered option lists
// read off the screen (permission prompts), and Claude Code's multi-question
// AskUserQuestion dialog. Pure functions; core.ts types the steps.

export type ScreenOption = {
  /** What gets typed: the option's digit, or its own hotkey ("(y)") when it shows one. */
  key: string;
  label: string;
};

export type Question = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
};

/** One answer per question: picked option indexes (0-based) and/or free text ("Type something"). */
export type Answer = { picked: number[]; text?: string };

/** A step: tmux key names, or literal text. */
export type Step = { keys: string[] } | { text: string };

const OPTION = /^\s*(?:[❯›>▶●]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const CURSOR = /^\s*[❯›>▶]/;

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
export function parsePicker(lines: string[], max = 8): { options: ScreenOption[]; context: string; cursor?: number } | null {
  return parseNumbered(lines, max) ?? parseCursorList(lines, max);
}

/** Lines above row `start`: what the picker is about, up to a rule or `max` lines. */
function contextAbove(lines: string[], start: number, max: number): string {
  const above: string[] = [];
  for (let i = start - 1; i >= 0 && above.length < max; i--) {
    if (/^\s*[─━╭╰│]{3,}/.test(lines[i]) || /^\s*[╭╰]/.test(lines[i])) break;
    if (lines[i].trim()) above.unshift(lines[i].replace(/^\s*│\s?|\s?│\s*$/g, ''));
  }
  return dedent(above).join('\n');
}

/**
 * A picker without numbers ("❯ No, exit / Yes, I trust this folder") right above an
 * "Enter to confirm" footer: rows aligned with the cursor row's text. Its keys are
 * `nav:<index>`; the server turns one into arrow moves from the cursor, then Enter.
 */
function parseCursorList(lines: string[], max: number): { options: ScreenOption[]; context: string; cursor: number } | null {
  const footer = lines.findLastIndex((l) => /Enter to (confirm|select|continue)/.test(l));
  if (footer < 1) return null;
  let end = footer - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  const cursorAt = (() => {
    for (let i = end; i >= 0 && i > end - 20; i--) if (/^\s*❯\s+\S/.test(lines[i])) return i;
    return -1;
  })();
  if (cursorAt < 0) return null;
  const indent = lines[cursorAt].indexOf('❯') + 2;
  const row = (l: string) => {
    const m = l.match(/^(\s*)❯\s+(\S.*)$/);
    if (m && m[1].length + 2 === indent) return { label: m[2].trim(), cursor: true };
    return l.length > indent && l.slice(0, indent).trim() === '' && /\S/.test(l[indent]) ? { label: l.trim(), cursor: false } : null;
  };
  let start = cursorAt;
  while (start > 0 && row(lines[start - 1])) start--;
  const rows = lines.slice(start, end + 1).map(row);
  if (rows.length < 2 || rows.some((r) => !r)) return null;
  const options = rows.map((r, j) => ({ key: `nav:${j}`, label: r!.label }));
  return { options, context: contextAbove(lines, start, max), cursor: rows.findIndex((r) => r!.cursor) };
}

/** Keys that pick row `target` of a cursor list whose cursor is on `cursor`. */
export function cursorKeys(cursor: number, target: number): string[] {
  const n = target - cursor;
  return [...Array(Math.abs(n)).fill(n > 0 ? 'Down' : 'Up'), 'Enter'];
}

function parseNumbered(lines: string[], max: number): { options: ScreenOption[]; context: string } | null {
  let best: Array<{ n: number; label: string; cursor: boolean; col: number }> = [];
  let bestStart = -1;
  let run: typeof best = [];
  let start = -1;
  let wrapping = false;
  for (const [i, line] of lines.entries()) {
    const m = line.match(OPTION);
    if (m) {
      const n = Number(m[1]);
      const row = { n, label: m[2], cursor: CURSOR.test(line), col: line.indexOf(m[2]) };
      if (n === run.length + 1) run.push(row);
      else if (n === 1) run = [row];
      else run = [];
      if (n === 1) start = i;
      if (run.length >= 2 && run.some((o) => o.cursor)) {
        best = [...run];
        bestStart = start;
      }
      wrapping = true;
      continue;
    }
    // A label the agent wrapped continues on the next line, aligned with its text
    // ("2. Yes, and switch to accept edits (… common file" / "   commands) …").
    const last = run.at(-1);
    if (wrapping && last && line.trim() && line.length - line.trimStart().length === last.col) {
      last.label += ` ${line.trim()}`;
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
    return { key: hot ? hot[1].toLowerCase() : String(o.n), label };
  });
  return { options, context: contextAbove(lines, bestStart, max) };
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
        .map((o: { label: string; description?: unknown }) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined })),
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
  checkAnswers(questions, answers);
  const steps: Step[] = [];
  questions.forEach((q, i) => {
    const a = answers[i];
    const text = a.text?.trim() ?? '';
    const n = q.options.length;
    if (!q.multiSelect) {
      if (text) steps.push({ keys: [String(n + 1)] }, { text }, { keys: ['Enter'] });
      else steps.push({ keys: [String(a.picked[0] + 1)] });
      return;
    }
    for (const p of [...a.picked].sort((x, y) => x - y)) steps.push({ keys: [String(p + 1)] });
    if (text) steps.push({ keys: Array(n).fill('Down') }, { text }, { keys: ['Tab'] }, { keys: ['Enter'] });
    else steps.push({ keys: ['Right'] });
  });
  if (questions.length > 1 || questions.some((q) => q.multiSelect)) steps.push({ keys: ['1'] });
  return steps;
}

/**
 * The steps above assume the dialog is fresh: on the first question, cursor on
 * its first row, nothing answered. Anything else (answered halfway in the
 * terminal, a different dialog) must not get keys typed into it.
 */
export function pickerAtStart(screen: string, questions: Question[]): boolean {
  if (!/Enter to select/.test(screen)) return false;
  const words = (s: string) => s.replace(/\s+/g, ' ').trim();
  const flat = words(screen);
  if (!flat.includes(words(questions[0].question).slice(0, 40))) return false;
  if (!/^\s*❯\s*1\.\s/m.test(screen)) return false;
  // Multi-question dialogs draw a tab bar; ☒ marks a question already answered.
  if (questions.length > 1 && /☒/.test(screen)) return false;
  return true;
}

/** The question Claude's dialog is showing right now, read off the screen. */
export type ScreenQuestion = {
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string; checked?: boolean }>;
  /** 1-based row the cursor is on: options, then "Type something", then (multi) Submit. */
  cursor: number;
  /** Tab bar: how many questions there are and how many are answered. */
  total: number;
  answered: number;
};

const ROW = /^\s*(❯\s*)?(\d{1,2})\.\s+(?:\[([ ✔])\]\s+)?(.*?)\s*$/;

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
  const question = body.slice(0, first).map((l) => l.trim()).filter(Boolean).join(' ');
  const options: ScreenQuestion['options'] = [];
  let multiSelect = false;
  let cursor = 0;
  let other = false;
  for (const line of body.slice(first)) {
    if (/^\s*[─━]{3,}/.test(line)) break; // "Chat about this" sits under the rule
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
  if (!question || !options.length || !other || !cursor) return null;
  return { question, multiSelect, options, cursor, total: tabs.length, answered: tabs.filter((t) => t === '☒').length };
}

/** Keys for the question on screen, from its current state (ticks and cursor). */
export function dialogSteps(q: ScreenQuestion, a: Answer): Step[] {
  checkAnswers([{ question: q.question, multiSelect: q.multiSelect, options: q.options }], [a]);
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
