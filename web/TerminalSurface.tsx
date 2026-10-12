import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { showError, showNotice } from './ask.tsx';
import { clipboardFiles, readClipboard } from './clipboard.ts';
import { shellQuote } from './api.ts';
import { Terminal, type TerminalHandle } from './Terminal.tsx';
import { KeyBar } from './KeyBar.tsx';
import { applyModifiers } from './keyboard.ts';
import type { SurfaceHandle, SurfaceProps } from './surface.ts';
import { shortcutTitle } from './shortcuts.tsx';
import { AskPanel, type AskHandle } from './AskPanel.tsx';
import { useFileDrop } from './useFileDrop.ts';

const KIND_LABEL = { command: 'Wants to run a command', tool: 'Wants to use a tool', question: 'Asked a question', screen: 'Waiting for you', choice: 'Asked you' };
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** The session as its own TUI: xterm.js attached to the tmux window, plus the
 *  touch key bar, file paste/drop, and the screen-scraped permission banner. */
export const TerminalSurface = forwardRef<SurfaceHandle, SurfaceProps>(function TerminalSurface({ w, client, hidden, showKeys, onAnswer, onReply, refresh }, ref) {
  const term = useRef<TerminalHandle>(null);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [shift, setShift] = useState(false);
  const [pasting, setPasting] = useState(false);
  const askRef = useRef<AskHandle>(null);

  useImperativeHandle(ref, () => ({
    insert: (text) => {
      term.current?.send(text);
      term.current?.focus();
    },
    focus: () => term.current?.focus(),
    focusAsk: () => askRef.current?.focus() ?? false,
  }));

  const transform = useCallback(
    (d: string) => {
      if (!ctrl && !alt && !shift) return d;
      setCtrl(false);
      setAlt(false);
      setShift(false);
      return applyModifiers(d, ctrl, alt, shift);
    },
    [ctrl, alt, shift],
  );

  // Pasted or dropped files are uploaded to the host and their paths typed in.
  async function sendFiles(files: FileList | File[]) {
    const list = Array.isArray(files) ? files : [...files];
    if (!list.length) return;
    try {
      const paths = await Promise.all(list.map((f) => client.upload(f)));
      term.current?.send(paths.map(shellQuote).join(' ') + ' ');
      term.current?.focus();
    } catch (e) {
      showError(e, "Couldn't upload");
    }
  }

  const drop = useFileDrop(sendFiles);

  async function pasteClipboard() {
    if (pasting) return;
    setPasting(true);
    try {
      // Start the read directly from the click to retain browser user activation.
      const { text, files } = await readClipboard(navigator.clipboard);
      if (files.length) await sendFiles(files);
      else if (text) term.current?.paste(text);
    } catch {
      showNotice('Clipboard unavailable', 'Clipboard access was denied or unavailable. Use the keyboard’s Paste action, or allow clipboard access and try again.');
    } finally {
      setPasting(false);
    }
  }

  return (
    <div
      className={`surface ${hidden ? 'hidden' : ''}`}
      onPasteCapture={(e) => {
        const pasted = clipboardFiles(e.clipboardData);
        if (pasted.length) {
          e.preventDefault();
          e.stopPropagation();
          sendFiles(pasted);
        }
      }}
      {...drop.handlers}
    >
      <Terminal ref={term} key={w.key} hidden={hidden} windowId={w.id} wsUrl={client.wsUrl} transformInput={transform} onGone={refresh} />
      {drop.over && <div className="drop-hint">Drop to upload to {w.host} and insert the path</div>}

      {w.status === 'waiting' && w.ask && (
        <div className="ask-banner">
          <span className="card-kind">{KIND_LABEL[w.ask.kind]}</span>
          {w.ask.options?.length || ((w.ask.questions?.length || w.ask.dialog) && coarse()) ? (
            // A phone can't comfortably drive a picker through the key bar: answer it here.
            <AskPanel ref={askRef} w={w} client={client} onAnswer={onAnswer} compact />
          ) : w.ask.kind === 'choice' ? (
            <p className="muted small ask-hint">Pick in the terminal below: number keys choose, Enter confirms.</p>
          ) : (
            <>
              {w.ask.text && <pre className={`ask-box ${w.ask.kind === 'command' || w.ask.kind === 'screen' ? 'code' : ''}`}>{w.ask.text}</pre>}
              <div className="actions">
                {w.answerable ? (
                  <>
                    <button className="btn primary" title={shortcutTitle('Approve', 'approve')} onClick={() => onAnswer(w, 'approve')}>
                      Approve
                    </button>
                    <button className="btn" title={shortcutTitle('Deny', 'deny')} onClick={() => onAnswer(w, 'deny')}>
                      Deny
                    </button>
                  </>
                ) : (
                  <button className="btn primary" title={shortcutTitle('Reply', 'reply')} onClick={onReply}>
                    Reply
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {showKeys && (
        <KeyBar
          ctrl={ctrl} alt={alt} shift={shift} pasting={pasting}
          setCtrl={setCtrl} setAlt={setAlt} setShift={setShift}
          send={(d) => term.current?.send(d)} onPaste={pasteClipboard}
          onKeyboard={() => term.current?.focus()}
        />
      )}
    </div>
  );
});
