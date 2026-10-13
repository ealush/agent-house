import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { errorText } from './errors.ts';

// In-app stand-in for alert, confirm, and prompt. One dialog at a time,
// drawn with the same chrome as the other dialogs.

type Kind = 'alert' | 'confirm' | 'prompt';

type Task = {
  id: number;
  kind: Kind;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  label?: string;
  placeholder?: string;
  initial?: string;
  resolve: (value: string | boolean | null) => void;
};

let nextId = 1;
let listen: ((task: Task) => void) | null = null;
const waiting: Task[] = [];

function push(task: Omit<Task, 'id'>) {
  const full = { ...task, id: nextId++ };
  if (listen) listen(full);
  else waiting.push(full);
}

/** A message with a single OK. Escape and the backdrop dismiss it too. */
export function showNotice(title: string, body?: string) {
  return new Promise<void>((resolve) => {
    push({
      kind: 'alert',
      title,
      body,
      confirmLabel: 'OK',
      cancelLabel: 'OK',
      danger: false,
      resolve: () => resolve(),
    });
  });
}

/** An error from a failed request. The title says what failed; the body is the reason. */
export function showError(error: unknown, title = "Couldn't do that") {
  return showNotice(title, errorText(error));
}

export function askConfirm(opts: { title: string; body?: string; confirm?: string; cancel?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => {
    push({
      kind: 'confirm',
      title: opts.title,
      body: opts.body,
      confirmLabel: opts.confirm ?? 'OK',
      cancelLabel: opts.cancel ?? 'Cancel',
      danger: !!opts.danger,
      resolve: (value) => resolve(value === true),
    });
  });
}

/** Returns the trimmed text, or null if cancelled. Empty input cannot be submitted. */
export function askText(opts: { title: string; body?: string; label?: string; placeholder?: string; value?: string; confirm?: string }) {
  return new Promise<string | null>((resolve) => {
    push({
      kind: 'prompt',
      title: opts.title,
      body: opts.body,
      label: opts.label,
      placeholder: opts.placeholder,
      initial: opts.value ?? '',
      confirmLabel: opts.confirm ?? 'OK',
      cancelLabel: 'Cancel',
      danger: false,
      resolve: (value) => resolve(typeof value === 'string' ? value : null),
    });
  });
}

export function AskHost() {
  const [queue, setQueue] = useState<Task[]>([]);
  useEffect(() => {
    listen = (task) => setQueue((q) => [...q, task]);
    if (waiting.length) setQueue((q) => [...waiting.splice(0, waiting.length), ...q]);
    return () => {
      listen = null;
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  return <AskDialog key={current.id} task={current} onDone={() => setQueue((q) => q.slice(1))} />;
}

function AskDialog({ task, onDone }: { task: Task; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const settled = useRef(false);
  const titleId = useId();
  const bodyId = useId();
  const [value, setValue] = useState(task.initial ?? '');
  const dismissValue = task.kind === 'confirm' ? false : null;

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  function finish(result: string | boolean | null) {
    if (settled.current) return;
    settled.current = true;
    task.resolve(result);
    if (ref.current?.open) ref.current.close();
    onDone();
  }

  function accept() {
    if (task.kind === 'prompt') {
      const name = value.trim();
      if (!name) return;
      finish(name);
      return;
    }
    finish(task.kind === 'confirm' ? true : null);
  }

  return (
    <dialog
      ref={ref}
      className="dialog ask"
      aria-labelledby={titleId}
      aria-describedby={task.body ? bodyId : undefined}
      onClose={() => finish(dismissValue)}
      onClick={(e) => {
        if (e.target === ref.current) finish(dismissValue);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          accept();
        }}
      >
        <h2 id={titleId}>{task.title}</h2>
        {task.body && (
          <p id={bodyId} className="ask-body">
            {task.body}
          </p>
        )}
        {task.kind === 'prompt' && (
          <label className="field">
            {task.label && <span>{task.label}</span>}
            <input
              autoFocus
              value={value}
              placeholder={task.placeholder}
              aria-label={task.label ?? task.title}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        <div className="actions">
          {task.kind !== 'alert' && (
            <button type="button" className="btn ghost" onClick={() => finish(dismissValue)}>
              {task.cancelLabel}
            </button>
          )}
          <ConfirmButton
            type="submit"
            className={`btn ${task.danger ? 'danger-solid' : 'primary'}`}
            autoFocus={task.kind !== 'prompt'}
            disabled={task.kind === 'prompt' && !value.trim()}
          >
            {task.confirmLabel}
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}
