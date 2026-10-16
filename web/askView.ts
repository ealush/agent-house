// What a waiting agent asks, in parts, so every place that shows it (the Inbox
// card, the GUI's ask panel, the bar under the terminal) draws the same thing:
// what it wants, the concrete thing (a command, or its question), and the
// screen text only on request. Never the raw screen as the message.
import type { Win } from './api.ts';
import { cleanScreen, questionLine } from './screenText.ts';

export type Ask = NonNullable<Win['ask']>;

export type AskParts = {
  /** What it wants, in words: "Wants to run a command", "Asked you". */
  kind: string;
  /** The command it wants to run, when that is the ask. */
  command?: string;
  /** The agent's own one-line description of the command ("Run the auth test suite"). */
  description?: string;
  /** Its question, when it asked one ("Do you want to make this edit to app.tsx?"). */
  question?: string;
  /** The rest of what the screen shows, for "Show terminal text". */
  context?: string;
};

export const KIND_LABEL: Record<Ask['kind'], string> = {
  command: 'Wants to run a command',
  tool: 'Wants to use a tool',
  question: 'Asked a question',
  screen: 'Waiting for you',
  choice: 'Asked you',
};

/** A TUI's heading over a permission prompt ("Bash command"): a frame, not content. */
const HEADING = /^(bash|shell|run) command$/i;
/** The generic confirm under a command: the kind line already says it. */
const GENERIC = /^do you want to proceed\?$/i;

export function readAsk(ask: Ask, detail?: string | null): AskParts {
  const kind = KIND_LABEL[ask.kind];
  const text = ask.text ?? '';
  const question = questionLine(text) ?? undefined;
  if (ask.kind === 'command') {
    const lines = cleanScreen(text)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !HEADING.test(l) && l !== question);
    // A hook's detail ("$ pnpm test --filter auth") is the command exactly; the screen's
    // first line is the same command when there is no hook, hard-wrapped at 80 columns.
    const hooked = detail?.startsWith('$ ') ? detail.slice(2).trim() : null;
    const command = hooked ?? lines[0];
    const rest = hooked ? lines.filter((l) => !hooked.includes(l)) : lines.slice(1);
    const description = rest.length === 1 ? rest[0] : undefined;
    return {
      kind,
      command,
      description,
      question: question && !GENERIC.test(question) ? question : undefined,
      context: text.includes('\n') ? cleanScreen(text) : undefined,
    };
  }
  if (ask.kind === 'choice') return { kind, question: ask.dialog?.question ?? ask.questions?.[0]?.question ?? (text || undefined) };
  const context = cleanScreen(text, question);
  return { kind, question, context: context || undefined };
}
