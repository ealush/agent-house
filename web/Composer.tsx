import { useEffect, useRef, useState } from 'react';
import { shellQuote, type HostApi, type SendResult } from './api.ts';

// A native text box for writing prompts: dictation, autocorrect and selection all
// work here, unlike inside the terminal canvas. Sends go through the server, which
// types them in now if the agent is idle or queues them for its next idle moment.
type Props = {
  client: HostApi;
  /** Registry id of the session. */
  target: string;
  name: string;
  onSent: (r: SendResult) => void;
  onClose: () => void;
};

const drafts = new Map<string, string>();

export function Composer({ client, target, name, onSent, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(target) ?? '');
  const [enter, setEnter] = useState(true);
  const [busy, setBusy] = useState<'upload' | 'send' | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    area.current?.focus();
    client.prompts().then((p) => setRecent(p.map((x) => x.text))).catch(() => {});
  }, []);
  useEffect(() => {
    drafts.set(target, text);
  }, [target, text]);

  async function submit() {
    if (!text || busy) return;
    setBusy('send');
    setError(null);
    try {
      const result = await client.send(target, text, enter);
      drafts.delete(target);
      onSent(result);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setBusy('upload');
    try {
      const paths = await Promise.all([...files].map((f) => client.upload(f)));
      setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${paths.map(shellQuote).join(' ')} `);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <dialog ref={ref} className="dialog composer" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="composer-head">
          <h2>Message {name}</h2>
          {recent.length > 0 && (
            <select
              className="recent"
              value=""
              onChange={(e) => {
                if (e.target.value) setText(e.target.value);
                area.current?.focus();
              }}
              aria-label="Recent prompts"
            >
              <option value="">Recent…</option>
              {recent.map((r) => (
                <option key={r} value={r}>
                  {r.length > 70 ? r.slice(0, 69) + '…' : r}
                </option>
              ))}
            </select>
          )}
        </div>
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              attach(e.clipboardData.files);
            }
          }}
          rows={6}
          placeholder="Write a prompt or command… If the agent is busy it's queued and sent when it's free."
        />
        {error && <p className="form-error">{error}</p>}
        <div className="composer-bar">
          <label className="btn ghost small">
            {busy === 'upload' ? 'Uploading…' : 'Attach file'}
            <input type="file" multiple hidden onChange={(e) => attach(e.target.files)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={enter} onChange={(e) => setEnter(e.target.checked)} />
            <span>Press Enter</span>
          </label>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!text || !!busy}>
            {busy === 'send' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
