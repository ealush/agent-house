import { useEffect, useRef, useState } from 'react';
import { upload, shellQuote } from './api.ts';

// A native text box for writing prompts on touch devices: dictation, autocorrect
// and selection all work here, unlike inside the terminal canvas.
type Props = {
  target: string;
  send: (data: string) => void;
  onClose: () => void;
};

const drafts = new Map<string, string>();

export function Composer({ target, send, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(target) ?? '');
  const [enter, setEnter] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    area.current?.focus();
  }, []);
  useEffect(() => {
    drafts.set(target, text);
  }, [target, text]);

  function submit() {
    if (!text) return;
    // Bracketed paste keeps multi-line prompts as one message instead of N submits.
    send(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
    if (enter) setTimeout(() => send('\r'), 60);
    drafts.delete(target);
    setText('');
    onClose();
  }

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      const paths = await Promise.all([...files].map(upload));
      setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${paths.map(shellQuote).join(' ')} `);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUploading(false);
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
        <h2>Compose</h2>
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
          placeholder="Write a prompt or command…"
        />
        <div className="composer-bar">
          <label className="btn ghost small">
            {uploading ? 'Uploading…' : 'Attach file'}
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
          <button type="submit" className="btn primary" disabled={!text || uploading}>
            Send
          </button>
        </div>
      </form>
    </dialog>
  );
}
