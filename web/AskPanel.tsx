import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { HostApi, Question, QuestionAnswer, Win } from './api.ts';
import { showError } from './ask.tsx';
import { shortcutTitle } from './shortcuts.tsx';

// Answering a waiting agent without its terminal: the agent's own question dialog
// (Claude's AskUserQuestion) as a form, a numbered permission picker as buttons,
// or Approve / Deny. Keyboard first: digits pick, arrows move, Space toggles,
// Enter submits. The server re-checks the screen before typing anything.

export type AskHandle = { focus: () => boolean };

type Props = {
  w: Win;
  client: HostApi;
  onAnswer: (w: Win, answer: 'approve' | 'deny') => void;
  onReply?: () => void;
  onUseTerminal?: () => void;
  /** Inbox cards: no headings, tighter rows. */
  compact?: boolean;
  /** The call it asks about is drawn natively right above (GUI): lead with the question, fold the screen text. */
  drawn?: boolean;
};

/** The prompt's own question ("Do you want to make this edit to calc.py?"), when the screen text ends with one. */
export function questionLine(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.findLast((l) => l.endsWith('?')) ?? null;
}

/** Screen text without the TUI's rules (──, ╌╌, ....), which only frame things in a terminal. */
export function cleanScreen(text: string, drop?: string | null): string {
  return text
    .split('\n')
    .filter((l) => !/^[\s─━╌╍┄┅┈┉╴╶\-–—_=·•.…⎯]+$/.test(l) && (!drop || l.trim() !== drop))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

const KIND_LABEL = { command: 'Wants to run a command', tool: 'Wants to use a tool', question: 'Asked a question', screen: 'Waiting for you', choice: 'Asked you' };

export const AskPanel = forwardRef<AskHandle, Props>(function AskPanel({ w, client, onAnswer, onReply, onUseTerminal, compact, drawn }, ref) {
  const ask = w.ask;
  const root = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = root.current?.querySelector<HTMLElement>('[data-ask-first], button:not([disabled])');
      el?.focus();
      return !!el;
    },
  }));
  if (!ask) return null;
  const options = ask.options ?? [];
  const dialog = ask.kind === 'choice' && !ask.questions?.length ? ask.dialog : undefined;

  return (
    <div className={`ask-panel ${compact ? 'compact' : ''}`} ref={root}>
      {!compact && <span className="card-kind">{KIND_LABEL[ask.kind]}</span>}
      {ask.kind === 'choice' && ask.questions?.length ? (
        <QuestionForm key={ask.questions.map((q) => q.question).join('\n')} questions={ask.questions} onSubmit={(answers) => client.answerQuestions(w.uid, answers)} onUseTerminal={onUseTerminal} compact={compact} />
      ) : dialog ? (
        <QuestionForm
          key={dialog.question}
          questions={[{ question: dialog.question, multiSelect: dialog.multiSelect, options: dialog.options }]}
          initial={[dialog.options.flatMap((o, i) => (o.checked ? [i] : []))]}
          progress={dialog.total > 1 ? `Question ${Math.min(dialog.answered + 1, dialog.total)} of ${dialog.total}` : undefined}
          onSubmit={([answer]) => client.answerQuestion(w.uid, dialog.question, answer)}
          onUseTerminal={onUseTerminal}
          compact={compact}
        />
      ) : (
        <>
          {!compact && ask.text && (ask.kind !== 'screen' || options.length > 0) &&
            (drawn ? (
              <>
                {questionLine(ask.text) && <p className="ask-question">{questionLine(ask.text)}</p>}
                <details className="ask-raw">
                  <summary>Terminal text</summary>
                  <pre className="code-block ask-context">{cleanScreen(ask.text)}</pre>
                </details>
              </>
            ) : (
              <pre className="code-block ask-context">{cleanScreen(ask.text)}</pre>
            ))}
          {options.length > 0 ? (
            // Keyed by the prompt: the next prompt is a fresh set of buttons, never the last one's "sent" state.
            <ScreenChoices key={`${ask.text}\n${options.map((o) => o.label).join('\n')}`} w={w} client={client} options={options} />
          ) : (
            <div className="actions">
              {w.answerable ? (
                <>
                  <button className="btn primary" data-ask-first title={shortcutTitle('Approve', 'approve')} onClick={() => onAnswer(w, 'approve')}>
                    Approve
                  </button>
                  <button className="btn" title={shortcutTitle('Deny', 'deny')} onClick={() => onAnswer(w, 'deny')}>
                    Deny
                  </button>
                </>
              ) : (
                onReply && (
                  <button className="btn primary" data-ask-first title={shortcutTitle('Reply', 'reply')} onClick={onReply}>
                    Reply
                  </button>
                )
              )}
            </div>
          )}
          {onUseTerminal && (
            <button className="btn ghost small ask-terminal" onClick={onUseTerminal}>
              Answer in terminal
            </button>
          )}
        </>
      )}
    </div>
  );
});

/** A permission picker's rows as buttons. Digits (or the row's own hotkey) pick while focus is here. */
function ScreenChoices({ w, client, options }: { w: Win; client: HostApi; options: Array<{ key: string; label: string }> }) {
  const [sent, setSent] = useState<string | null>(null);
  // If the same prompt is still up a while later, the key didn't take: allow another try.
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), 4000);
    return () => clearTimeout(t);
  }, [sent]);
  const pick = async (key: string) => {
    if (sent) return;
    setSent(key);
    try {
      await client.choose(w.uid, key);
    } catch (e) {
      setSent(null);
      showError(e, "Couldn't answer");
    }
  };
  return (
    <div
      className="ask-options"
      role="group"
      aria-label="Choices"
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const hit = options.find((o) => o.key === e.key.toLowerCase()) ?? options[Number(e.key) - 1];
        if (hit) {
          e.preventDefault();
          void pick(hit.key);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      {options.map((o, i) => (
        <button key={o.key} className={`ask-option ${i === 0 ? 'first' : ''} ${sent === o.key ? 'on' : ''}`} data-ask-first={i === 0 || undefined} disabled={!!sent} onClick={() => void pick(o.key)}>
          <kbd>{o.key.startsWith('nav:') ? i + 1 : o.key.toUpperCase()}</kbd>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function moveFocus(container: HTMLElement, step: 1 | -1) {
  const items = [...container.querySelectorAll<HTMLElement>('[data-row]:not([disabled]), .ask-option:not([disabled])')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = items[Math.max(0, Math.min(items.length - 1, at + step))];
  next?.focus();
}

type Draft = { picked: number[]; text: string; other: boolean };

/** The agent's questions as one form. One single-choice question answers on the pick, like the dialog itself. */
export function QuestionForm({ questions, initial, progress, onSubmit, onUseTerminal, compact }: {
  questions: Question[];
  /** Options already ticked (a multi choice half answered in the terminal). */
  initial?: number[][];
  /** "Question 2 of 3", when the dialog is answered one question at a time. */
  progress?: string;
  onSubmit: (a: QuestionAnswer[]) => Promise<unknown>;
  onUseTerminal?: () => void;
  compact?: boolean;
}) {
  const fresh = () => questions.map((_, i) => ({ picked: initial?.[i] ?? [], text: '', other: false }));
  const [drafts, setDraftsState] = useState<Draft[]>(fresh);
  // Keys arrive faster than renders ("1" then "3"): every update reads the latest drafts.
  const latest = useRef(drafts);
  const setDrafts = (next: Draft[]) => {
    latest.current = next;
    setDraftsState(next);
  };
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const form = useRef<HTMLFormElement>(null);
  const instant = questions.length === 1 && !questions[0].multiSelect;
  const answered = (d: Draft, q: Question) => (q.multiSelect ? d.picked.length > 0 || (d.other && !!d.text.trim()) : d.picked.length === 1 || (d.other && !!d.text.trim()));
  const complete = questions.every((q, i) => answered(drafts[i], q));

  const sending = useRef(false);
  const submit = async (next = latest.current) => {
    if (sending.current) return;
    if (!questions.every((q, i) => answered(next[i], q))) return;
    sending.current = true;
    setState('sending');
    try {
      // A typed answer to a single choice replaces the pick; multi choice keeps both.
      await onSubmit(next.map((d, i) => ({ picked: d.other && !questions[i].multiSelect ? [] : d.picked, ...(d.other && d.text.trim() ? { text: d.text.trim() } : {}) })));
      setState('sent');
    } catch (e) {
      sending.current = false;
      setState('idle');
      showError(e, "Couldn't answer");
    }
  };

  const update = (qi: number, fn: (d: Draft) => Draft) => {
    const next = latest.current.map((d, i) => (i === qi ? fn(d) : d));
    setDrafts(next);
    return next;
  };

  /** Single choice: the pick replaces any typed answer, then focus moves to the next question. */
  const choose = (qi: number, oi: number) => {
    const q = questions[qi];
    if (q.multiSelect) {
      update(qi, (d) => ({ ...d, picked: d.picked.includes(oi) ? d.picked.filter((p) => p !== oi) : [...d.picked, oi] }));
      return;
    }
    const next = update(qi, (d) => ({ ...d, picked: [oi], other: false }));
    if (instant) void submit(next);
    else focusQuestion(qi + 1);
  };

  const focusQuestion = (qi: number) => {
    requestAnimationFrame(() => {
      const el = form.current?.querySelector<HTMLElement>(`[data-q="${qi}"] [data-row]`) ?? form.current?.querySelector<HTMLElement>('.ask-submit');
      el?.focus();
    });
  };

  // Parents key the form by its questions, so a new question set remounts it.

  if (state === 'sent') return <p className="muted small ask-sent">Answer sent.</p>;

  return (
    <form
      ref={form}
      className="ask-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        const typing = target.tagName === 'INPUT';
        if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (typing && e.key === 'Enter')) {
          e.preventDefault();
          const open = latest.current.findIndex((d, i) => !answered(d, questions[i]));
          if (open < 0) void submit();
          else focusQuestion(open);
          return;
        }
        if (typing) {
          if (e.key === 'Escape') (target.closest('[data-q]')?.querySelector('[data-row]') as HTMLElement | null)?.focus();
          return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const qEl = target.closest<HTMLElement>('[data-q]');
        const qi = qEl ? Number(qEl.dataset.q) : latest.current.findIndex((d, i) => !answered(d, questions[i]));
        const q = questions[qi];
        if (q && /^[1-9]$/.test(e.key)) {
          const n = Number(e.key) - 1;
          e.preventDefault();
          if (n < q.options.length) choose(qi, n);
          else if (n === q.options.length) (form.current?.querySelector(`[data-q="${qi}"] .ask-other-row`) as HTMLElement | null)?.click();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      {progress && <span className="ask-progress muted small">{progress}</span>}
      {questions.map((q, qi) => {
        const d = drafts[qi];
        return (
          <fieldset key={qi} className="ask-question" data-q={qi}>
            <legend>
              {q.header && <span className="ask-header">{q.header}</span>}
              <span className="ask-text">{q.question}</span>
              {q.multiSelect && <span className="muted small"> Pick any.</span>}
            </legend>
            <div role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question} className="ask-rows">
              {q.options.map((o, oi) => {
                const on = d.picked.includes(oi);
                return (
                  <button
                    type="button"
                    key={oi}
                    data-row
                    data-ask-first={(qi === 0 && oi === 0) || undefined}
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    className={`ask-row ${on ? 'on' : ''}`}
                    disabled={state !== 'idle'}
                    onClick={() => choose(qi, oi)}
                  >
                    <kbd>{oi + 1}</kbd>
                    <span className="ask-row-text">
                      <span className="ask-label">{o.label}</span>
                      {!compact && o.description && <span className="ask-desc">{o.description}</span>}
                    </span>
                    <span className={`ask-mark ${q.multiSelect ? 'box' : 'dot'}`} aria-hidden />
                  </button>
                );
              })}
              <div className={`ask-row ask-other ${d.other ? 'on' : ''}`}>
                <button
                  type="button"
                  data-row
                  className="ask-other-row"
                  aria-expanded={d.other}
                  disabled={state !== 'idle'}
                  onClick={() => {
                    update(qi, (x) => ({ ...x, other: true, picked: q.multiSelect ? x.picked : [] }));
                    requestAnimationFrame(() => (form.current?.querySelector(`[data-q="${qi}"] input`) as HTMLInputElement | null)?.focus());
                  }}
                >
                  <kbd>{q.options.length + 1}</kbd>
                  {!d.other && <span className="ask-label muted">Something else…</span>}
                </button>
                {d.other && (
                  <input
                    className="ask-input"
                    value={d.text}
                    placeholder="Type your answer"
                    aria-label={`Your answer to: ${q.question}`}
                    disabled={state !== 'idle'}
                    onChange={(e) => update(qi, (x) => ({ ...x, text: e.target.value.replace(/[\r\n]+/g, ' ') }))}
                  />
                )}
              </div>
            </div>
          </fieldset>
        );
      })}
      <div className="actions">
        {!instant && (
          <button type="submit" className="btn primary ask-submit" disabled={!complete || state !== 'idle'} title="Submit (Ctrl+Enter)">
            {state === 'sending' ? 'Sending…' : questions.length > 1 ? 'Submit answers' : 'Submit'}
          </button>
        )}
        {instant && state === 'sending' && <span className="muted small">Sending…</span>}
        {onUseTerminal && (
          <button type="button" className="btn ghost small" onClick={onUseTerminal}>
            Answer in terminal
          </button>
        )}
      </div>
    </form>
  );
}
