import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useHardwareKeyboard } from './hardwareKeyboard.ts';
import { showError, showNotice } from './ask.tsx';
import { Icon } from './icons.tsx';
import { shellQuote, type HostApi, type SendResult, type Win } from './api.ts';
import { clipboardFiles } from './clipboard.ts';
import { Popover } from './ModelPicker.tsx';
import { ComposerOptions } from './ComposerOptions.tsx';
import { SuggestList, triggerAt, useSuggestions } from './Suggest.tsx';
import { useLaunch, useLaunchPalette } from './useLaunch.ts';
import { addOutgoing, removeOutgoing, updateOutgoing, useOutbox } from './outbox.ts';
import { QueueTray, type QueueTrayHandle } from './QueueTray.tsx';
import { putBack } from './requeue.ts';
import { useDraftSync } from './useDraftSync.ts';
import { splitUploads } from './uploads.ts';

/** Touch only (a phone, an iPad without a pointer): no keys to name in hints, as keycaps drop there. */
const TOUCH_SCREEN = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

// The message bar under a GUI session. It goes through the server, which types the text
// in now (idle agent, or any shell), queues it while an agent works, or resumes a dead
// session first. A native text box keeps dictation, autocorrect and selection working.
// The terminal view has no composer: its input comes from the shell itself.
//
// Sending is optimistic: the message shows in the feed (or the queue tray above the
// box, while the agent works) the moment you press send, and comes back into the box
// if the server refuses it.
//
// The toolbar under the text: the session's model and effort (switchable live where the
// agent supports it), its mode, recall, attach, voice, and send — or stop while it works.
//
// Pasted, picked or dropped files upload to the host at once and wait above the text as
// tiles (a thumbnail for an image), not as paths in it; sending puts their paths in front
// of the message. A shell composer still types the path in, where a command can use it.
type Props = {
  client: HostApi;
  /** Registry id of the session. */
  target: string;
  agent: string | null;
  /** The session, for its model/effort/mode and working state. */
  w?: Win;
  /** `quiet`: the GUI already shows the message, so no toast for it. */
  onSent: (r: SendResult, opts?: { quiet?: boolean }) => void;
  /** Reload the session list (the queue count) after a queue change here. */
  onChange?: () => void;
  onNotice?: (msg: string) => void;
  onSettingsOpen?: () => void;
  /** Hot swap finished: open the replacement window id on this host. */
  onRelaunched?: (uid: string) => void;
  /** Bumped to pull focus here (e.g. "Reply" on an ask). */
  focusKey?: number;
  /** The focused pane's composer takes the model/effort commands. */
  active?: boolean;
  /** A phone or touch-first tablet gets the mobile writing surface. */
  compact?: boolean;
};

export type ComposerHandle = { attach: (files: File[]) => void; focus: () => void };

/** A file on its way into the message. `path` is set once it is on the host. */
type Attachment = { id: number; name: string; image: boolean; src?: string; path?: string };

/** A small data: URL of an image, for its tile. The CSP allows data: images but not blob:. */
async function thumbnail(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 192 / Math.min(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

const drafts = new Map<string, string>();
// Per session, like the text, so switching away and back keeps them.
const attachments = new Map<string, Attachment[]>();
let attachmentId = 0;
// A queued message taken out to edit: the one it goes back in front of when it's
// queued again. Let go once the box is emptied, so a later message isn't moved for it.
const requeueBefore = new Map<string, string>();

type Recognition = { start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; continuous: boolean; interimResults: boolean; lang: string };
const SpeechRecognition: (new () => Recognition) | undefined = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

const toast = (msg: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: msg }));

export const ComposerBar = forwardRef<ComposerHandle, Props>(function ComposerBar({ client, target, agent, w, onSent, onChange, onNotice = toast, onSettingsOpen, onRelaunched, focusKey, active = false, compact = false }, ref) {
  // A hardware keyboard on a touch screen has keys to name.
  const hardwareKeyboard = useHardwareKeyboard();
  const touchOnly = TOUCH_SCREEN && !hardwareKeyboard;
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tray = useRef<QueueTrayHandle>(null);
  const [text, setText] = useState(() => drafts.get(target) ?? '');
  // The unsent text also lives on the host, so it follows you to your next device.
  const draftSync = useDraftSync(client, target, text, setText);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  // Just sent: Stop waits a moment before taking Send's place, so a second click or
  // tap meant for Send never lands on Stop and interrupts the turn it just started.
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const t = setTimeout(() => setJustSent(false), 700);
    return () => clearTimeout(t);
  }, [justSent]);
  const recognition = useRef<Recognition | null>(null);
  const recent = useRef<string[]>([]);
  // Sends go out one after another, so fast follow-ups keep their order.
  const sending = useRef<Promise<void>>(Promise.resolve());
  const cursor = useRef(-1);
  const beforeRecall = useRef('');
  const isShell = !agent;
  const working = !!w && w.status === 'busy';
  const outbox = useOutbox(target);

  // An upload can finish after you've moved to another session: it lands in that
  // session's list, which this box shows only while it's the one open.
  const [files, setFiles] = useState(() => attachments.get(target) ?? []);
  const current = useRef(target);
  current.current = target;
  function editFiles(uid: string, edit: (list: Attachment[]) => Attachment[]) {
    const next = edit(attachments.get(uid) ?? []);
    attachments.set(uid, next);
    if (uid === current.current) setFiles(next);
  }
  function removeFile(id: number) {
    editFiles(target, (list) => list.filter((f) => f.id !== id));
    area.current?.focus();
  }
  const uploading = files.some((f) => !f.path);
  /** A message coming back to the box (Edit on a queued one): its uploads as tiles again. */
  function compose(message: string, before?: string) {
    const { uploads, rest } = splitUploads(message);
    if (before) requeueBefore.set(target, before);
    else requeueBefore.delete(target);
    setText(rest);
    if (uploads.length) editFiles(target, (l) => [...l, ...uploads.map((u) => ({ id: ++attachmentId, name: u.name, image: u.image, path: u.path, src: u.image ? client.fs.url(u.path) : undefined }))]);
    requestAnimationFrame(() => area.current?.focus());
  }

  // Autocomplete: "/" commands and "@" files, for agents (a shell has its own completion).
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const rawTrigger = isShell ? null : triggerAt(text, caret);
  const triggerKey = rawTrigger ? `${rawTrigger.kind}:${rawTrigger.start}` : null;
  const trigger = rawTrigger && triggerKey !== dismissed ? rawTrigger : null;
  const suggestions = useSuggestions(client, target, trigger);
  const suggesting = !!trigger && suggestions.length > 0;
  useEffect(() => setPick(0), [trigger?.kind, trigger?.query]);
  const syncCaret = () => setCaret(area.current?.selectionStart ?? 0);

  function accept(i: number) {
    const item = suggestions[i];
    if (!item || !trigger) return;
    const next = text.slice(0, trigger.start) + item.value + text.slice(trigger.end);
    const at = trigger.start + item.value.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  }

  // "Edit" on a queued message puts its text back here.
  useEffect(() => {
    const onCompose = (e: Event) => {
      const d = (e as CustomEvent<{ uid: string; text: string; before?: string }>).detail;
      if (d.uid !== target) return;
      compose(d.text, d.before);
    };
    window.addEventListener('ah:compose', onCompose);
    return () => window.removeEventListener('ah:compose', onCompose);
  }, [target]);

  useEffect(() => {
    setText(drafts.get(target) ?? '');
    setFiles(attachments.get(target) ?? []);
    cursor.current = -1;
  }, [target]);
  useEffect(() => {
    drafts.set(target, text);
  }, [target, text]);
  useEffect(() => {
    if (!text.trim() && !files.length) requeueBefore.delete(target);
  }, [target, text, files]);
  useEffect(() => {
    if (focusKey) area.current?.focus();
  }, [focusKey]);
  useEffect(() => {
    client
      .prompts()
      .then((p) => (recent.current = p.map((x) => x.text)))
      .catch(() => {});
  }, [client]);
  useEffect(() => () => recognition.current?.stop(), []);

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const resize = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    resize();
    // Rotation and a split-view resize can both rewrap a draft.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  function submit() {
    const typed = text;
    const sentFiles = files;
    if ((!typed.trim() && !sentFiles.length) || busy || uploading) return;
    const draft = [...sentFiles.map((f) => shellQuote(f.path!)), typed.trim() ? typed : ''].filter(Boolean).join(' ');
    const before = requeueBefore.get(target);
    requeueBefore.delete(target);
    // A working agent queues it; anything else types it in now. The server decides,
    // this only picks where it shows until the server says. Right after a send the
    // session list may not say "working" yet, so a message still landing counts too.
    const landing = outbox.some((o) => o.state === 'queued' || (Date.now() - o.at < 5000 && (o.state === 'sending' || o.state === 'sent')));
    const id = addOutgoing(target, draft, (working || landing) && !isShell ? 'queued' : 'sending');
    recent.current = [draft, ...recent.current.filter((r) => r !== draft)];
    cursor.current = -1;
    setText('');
    setJustSent(true);
    editFiles(target, () => []);
    draftSync.saveNow('');
    sending.current = sending.current.then(async () => {
      try {
        const result = await client.send(target, draft, true);
        // Back where it was before the tray shows the server's list, so it never shows at the end.
        if (before && result.outcome === 'queued' && result.queueId) await putBack(client, target, result.queueId, before);
        updateOutgoing(id, { state: result.outcome === 'queued' ? 'queued' : 'sent', confirmedAt: Date.now() });
        onSent(result, { quiet: true });
      } catch (e) {
        removeOutgoing([id]);
        // Back into the box, unless something new was typed or attached there meanwhile.
        if (target === current.current) setText((t) => t || typed);
        editFiles(target, (list) => (list.length ? list : sentFiles));
        if (before && !requeueBefore.has(target)) requeueBefore.set(target, before);
        showError(e, "Couldn't send");
      }
    });
  }

  async function stop() {
    try {
      await client.interrupt(target);
      onNotice('Interrupted');
    } catch (e) {
      showError(e, "Couldn't interrupt");
    }
  }

  function recall(step: 1 | -1) {
    const list = recent.current;
    if (!list.length) return;
    if (cursor.current < 0) beforeRecall.current = text;
    cursor.current = Math.max(-1, Math.min(list.length - 1, cursor.current + step));
    setText(cursor.current < 0 ? beforeRecall.current : list[cursor.current]);
    area.current?.focus({ preventScroll: true });
  }

  async function attach(picked: FileList | File[] | null) {
    const list = !picked ? [] : Array.isArray(picked) ? picked : [...picked];
    if (!list.length) return;
    if (isShell) {
      setBusy(true);
      try {
        const paths = await Promise.all(list.map((f) => client.upload(f)));
        setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${paths.map(shellQuote).join(' ')} `);
        area.current?.focus();
      } catch (e) {
        showError(e, "Couldn't attach that file");
      } finally {
        setBusy(false);
      }
      return;
    }
    // The tile shows at once, from the local file; the upload runs behind it.
    const uid = target;
    const added = list.map((f) => ({ id: ++attachmentId, name: f.name || 'paste', image: f.type.startsWith('image/') }));
    editFiles(uid, (l) => [...l, ...added]);
    area.current?.focus();
    const set = (id: number, patch: Partial<Attachment>) => editFiles(uid, (l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    await Promise.all(
      list.map(async (f, i) => {
        const { id, image } = added[i];
        if (image) thumbnail(f).then((src) => set(id, { src }), () => {});
        try {
          set(id, { path: await client.upload(f) });
        } catch (e) {
          editFiles(uid, (l) => l.filter((x) => x.id !== id));
          showError(e, `Couldn't attach ${added[i].name}`);
        }
      }),
    );
  }

  useImperativeHandle(ref, () => ({ attach: (f) => void attach(f), focus: () => area.current?.focus() }));

  /** Voice input via the browser's speech recognition; text lands in the box for review. */
  function toggleMic() {
    if (!SpeechRecognition) return;
    if (listening) return recognition.current?.stop();
    const r = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e: any) => {
      let said = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript;
      if (said.trim()) setText((t) => `${t}${t && !/\s$/.test(t) ? ' ' : ''}${said.trim()}`);
    };
    r.onend = () => setListening(false);
    r.onerror = (e: any) => {
      setListening(false);
      if (e?.error === 'not-allowed') showNotice('Microphone blocked', 'Allow microphone access for this site, then try again.');
    };
    recognition.current = r;
    r.start();
    setListening(true);
  }

  // ---------- model / effort / mode chip

  const launch = useLaunch({ client, w, agent, onNotice, onSent, onSettingsOpen, onRelaunched });
  useLaunchPalette(launch, active && !!w);

  const empty = !text.trim() && !files.length;
  const canSend = !empty && !busy && !uploading;
  const showStop = !isShell && working && empty && !justSent;
  const landing = outbox.some((o) => o.state === 'queued' || (Date.now() - o.at < 5000 && (o.state === 'sending' || o.state === 'sent')));
  const queues = !isShell && (working || landing);
  const actionLabel = isShell ? 'Run' : queues ? 'Queue' : 'Send';

  return (
    <>
    {w && (
      <QueueTray
        ref={tray}
        client={client}
        uid={target}
        queued={w.queued}
        onChange={() => onChange?.()}
        onEdit={compose}
      />
    )}
    <form
      className={`composer ${compact ? 'mobile' : ''} ${isShell ? 'cmd' : ''} ${listening ? 'listening' : ''}`}
      aria-label={isShell ? 'Command composer' : 'Message composer'}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {suggesting && trigger && <SuggestList items={suggestions} index={pick} kind={trigger.kind} onPick={accept} />}
      {draftSync.from && (
        <div className="composer-from" role="status">
          <Icon name="send" size={11} /> Continued from {draftSync.from}
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f) => (
            <div key={f.id} className={`composer-file ${f.image ? 'image' : ''} ${f.path ? '' : 'uploading'}`} title={f.path ?? `Uploading ${f.name}…`}>
              {f.image ? (
                f.src && <img src={f.src} alt={f.name} />
              ) : (
                <>
                  {/* A file, not the Files tab's folder. */}
                  <Icon name="file" size={16} />
                  <span className="composer-file-name">{f.name}</span>
                </>
              )}
              <button type="button" className="composer-file-remove" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => removeFile(f.id)}>
                <Icon name="close" size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-input">
        {isShell && <span className="prompt-sign">➜</span>}
        <textarea
          ref={area}
          rows={1}
          value={text}
          enterKeyHint={touchOnly ? 'enter' : 'send'}
          aria-label={isShell ? 'Command' : 'Message'}
          autoCapitalize={isShell ? 'off' : 'sentences'}
          autoCorrect={isShell ? 'off' : 'on'}
          spellCheck={!isShell}
          placeholder={isShell ? 'Type a command…' : compact ? queues ? 'Add a follow-up…' : 'Message…' : working && (w?.queued ?? 0) > 0 ? 'Add to the queue · Enter steers the next one' : working ? 'Add to this… (queued until it’s free)' : 'Send a follow-up · / commands · @ files'}
          onChange={(e) => {
            setText(e.target.value);
            cursor.current = -1;
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={(e) => {
            // Safari can report the final IME Enter as keyCode 229 after isComposing clears.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            // The phone's Return is for paragraphs. Hardware keyboards retain Enter-to-send.
            if (touchOnly && e.key === 'Enter' && !e.metaKey && !e.ctrlKey) return;
            if (suggesting && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                accept(pick);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(triggerKey);
                return;
              }
            }
            if (e.key === 'Escape' && !text && !files.length && working && !isShell) {
              // Like the agent's own Esc: an empty composer stops the turn.
              e.preventDefault();
              stop();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              // An empty box steers the next queued message, like its Steer button.
              if (empty) tray.current?.steerFirst();
              else submit();
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
      </div>

      <div className="composer-tools">
        {compact && (
          <Popover className="icon-btn composer-add" title="Add to message" label={<Icon name="plus" size={22} />} keepFocus>
            {(close) => <div className="picker composer-add-menu">
              <button type="button" onClick={() => { close(); fileInput.current?.click(); }}><Icon name="attach" size={20} /><span>Attach files</span></button>
              <button type="button" onClick={() => { close(); recall(1); area.current?.focus({ preventScroll: true }); }}><Icon name="recall" size={20} /><span>Previous message</span></button>
              {cursor.current >= 0 && <button type="button" onClick={() => { close(); cursor.current = -1; setText(beforeRecall.current); area.current?.focus({ preventScroll: true }); }}><Icon name="edit" size={20} /><span>Restore draft</span></button>}
            </div>}
          </Popover>
        )}
        <ComposerOptions launch={launch} compact={compact} active={active} />

        <div className="composer-actions">
          {!compact && <button type="button" className="icon-btn" title="Previous messages (↑)" aria-label="Previous message" onClick={() => recall(1)}>
            <Icon name="recall" />
          </button>}
          {/* A button, so Tab reaches it (a label around a hidden input isn't focusable); the
              input stays for it and for the phone's + menu. */}
          <button type="button" className={`icon-btn composer-attach ${compact ? 'hidden' : ''}`} title={isShell ? 'Attach a file (uploaded to the host, path inserted)' : 'Attach a file (uploaded to the host, sent with the message)'} aria-label="Attach a file" onClick={() => fileInput.current?.click()}>
            <Icon name="attach" />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
            attach(e.target.files);
            // Picking the same file again should attach it again.
            e.target.value = '';
          }} />
          {SpeechRecognition && !isShell && (
            <button type="button" className={`icon-btn ${listening ? 'live' : ''}`} title={listening ? 'Stop dictation' : 'Dictate'} aria-pressed={listening} onClick={toggleMic}>
              <Icon name="mic" />
            </button>
          )}
          {showStop ? (
            <button type="button" className="send-btn stop" title="Interrupt the agent" aria-label="Stop" onClick={stop}>
              <span className="stop-square" />
            </button>
          ) : (
            // Pressing it leaves focus (and a phone's keyboard) in the box, as a messaging app does.
            <button type="submit" className="send-btn" disabled={!canSend} aria-label={actionLabel} title={queues ? 'Queue after the current response' : actionLabel}
              onMouseDown={(e) => e.preventDefault()}>
              {/* "Queue" only with something to queue: an empty box (just sent, the agent not yet working)
                  keeps the round button, so the mic beside it doesn't move under the thumb. */}
              {compact && queues && !empty ? <><Icon name="queue" size={18} /><span>Queue</span></> : isShell ? 'Run' : <Icon name="up" size={compact ? 22 : 18} />}
            </button>
          )}
        </div>
      </div>
    </form>
    </>
  );
});
