import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { shellQuote, type HostApi, type SendResult } from './api.ts';
import { clipboardFiles } from './clipboard.ts';

// The message bar under a session. It goes through the server, which types the text
// in now (idle agent, or any shell), queues it while an agent works, or resumes a dead
// session first. A native text box keeps dictation, autocorrect and selection working.
type Props = {
  client: HostApi;
  /** Registry id of the session. */
  target: string;
  agent: string | null;
  onSent: (r: SendResult) => void;
  /** Bumped to pull focus here (e.g. "Reply" on an ask). */
  focusKey?: number;
};

const drafts = new Map<string, string>();

export function ComposerBar({ client, target, agent, onSent, focusKey }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(target) ?? '');
  const [busy, setBusy] = useState(false);
  const recent = useRef<string[]>([]);
  const cursor = useRef(-1);
  const isShell = !agent;

  useEffect(() => {
    setText(drafts.get(target) ?? '');
    cursor.current = -1;
  }, [target]);
  useEffect(() => {
    drafts.set(target, text);
  }, [target, text]);
  useEffect(() => {
    if (focusKey) area.current?.focus();
  }, [focusKey]);
  useEffect(() => {
    client
      .prompts()
      .then((p) => (recent.current = p.map((x) => x.text)))
      .catch(() => {});
  }, [client]);

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const result = await client.send(target, text, true);
      recent.current = [text, ...recent.current.filter((r) => r !== text)];
      cursor.current = -1;
      setText('');
      onSent(result);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function recall(step: 1 | -1) {
    const list = recent.current;
    if (!list.length) return;
    cursor.current = Math.max(-1, Math.min(list.length - 1, cursor.current + step));
    setText(cursor.current < 0 ? '' : list[cursor.current]);
  }

  async function attach(files: FileList | File[] | null) {
    const list = !files ? [] : Array.isArray(files) ? files : [...files];
    if (!list.length) return;
    setBusy(true);
    try {
      const paths = await Promise.all(list.map((f) => client.upload(f)));
      setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${paths.map(shellQuote).join(' ')} `);
      area.current?.focus();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={`composer-bar ${isShell ? 'cmd' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {isShell && <span className="prompt-sign">➜</span>}
      <textarea
        ref={area}
        rows={1}
        value={text}
        enterKeyHint="send"
        autoCapitalize={isShell ? 'off' : 'sentences'}
        autoCorrect={isShell ? 'off' : 'on'}
        spellCheck={!isShell}
        placeholder={isShell ? 'Type or paste a command' : 'Send a follow-up to this session'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === 'ArrowUp' && (!text || cursor.current >= 0)) {
            e.preventDefault();
            recall(1);
          } else if (e.key === 'ArrowDown' && cursor.current >= 0) {
            e.preventDefault();
            recall(-1);
          }
        }}
        onPaste={(e) => {
          // Screenshots often arrive via items with an empty files list.
          const pasted = clipboardFiles(e.clipboardData);
          if (pasted.length) {
            e.preventDefault();
            attach(pasted);
          }
        }}
      />
      <button type="button" className="icon-btn" title="Previous messages" onClick={() => recall(1)}>
        <Icon name="recall" />
      </button>
      <label className="icon-btn" title="Attach a file (uploaded to the host, path inserted)">
        <Icon name="attach" />
        <input type="file" multiple hidden onChange={(e) => attach(e.target.files)} />
      </label>
      <button type="submit" className="send-btn" disabled={!text.trim() || busy} aria-label={isShell ? 'Run' : 'Send'}>
        {isShell ? 'Run' : <Icon name="up" />}
      </button>
    </form>
  );
}
