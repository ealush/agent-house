import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { askConfirm, showError, showNotice } from './ask.tsx';
import { Icon } from './icons.tsx';
import { shellQuote, type HostApi, type SendResult, type Win } from './api.ts';
import { clipboardFiles } from './clipboard.ts';
import { ModelPicker, EffortPicker, Popover, effectiveModel, effortsFor, usePreset } from './ModelPicker.tsx';
import { shortModel } from './logos.tsx';
import { SuggestList, triggerAt, useSuggestions } from './Suggest.tsx';
import { useLaunch, useLaunchPalette } from './useLaunch.ts';

// The message bar under a GUI session. It goes through the server, which types the text
// in now (idle agent, or any shell), queues it while an agent works, or resumes a dead
// session first. A native text box keeps dictation, autocorrect and selection working.
// The terminal view has no composer: its input comes from the shell itself.
//
// The toolbar under the text: the session's model and effort (switchable live where the
// agent supports it), its mode, recall, attach, voice, and send — or stop while it works.
type Props = {
  client: HostApi;
  /** Registry id of the session. */
  target: string;
  agent: string | null;
  /** The session, for its model/effort/mode and working state. */
  w?: Win;
  onSent: (r: SendResult) => void;
  onNotice?: (msg: string) => void;
  onSettingsOpen?: () => void;
  /** Hot swap finished: open the replacement window id on this host. */
  onRelaunched?: (id: string) => void;
  /** Bumped to pull focus here (e.g. "Reply" on an ask). */
  focusKey?: number;
  /** The focused pane's composer takes the model/effort commands. */
  active?: boolean;
};

const drafts = new Map<string, string>();

type Recognition = { start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; continuous: boolean; interimResults: boolean; lang: string };
const SpeechRecognition: (new () => Recognition) | undefined = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

const toast = (msg: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: msg }));

export function ComposerBar({ client, target, agent, w, onSent, onNotice = toast, onSettingsOpen, onRelaunched, focusKey, active = false }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(target) ?? '');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const recent = useRef<string[]>([]);
  const cursor = useRef(-1);
  const isShell = !agent;
  const preset = usePreset(w?.host ?? '', agent);
  const working = !!w && w.status === 'busy';

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
      const d = (e as CustomEvent<{ uid: string; text: string }>).detail;
      if (d.uid !== target) return;
      setText(d.text);
      requestAnimationFrame(() => area.current?.focus());
    };
    window.addEventListener('ah:compose', onCompose);
    return () => window.removeEventListener('ah:compose', onCompose);
  }, [target]);

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
  useEffect(() => () => recognition.current?.stop(), []);

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
      // The GUI shows it at once ("sending…") until the transcript records it.
      window.dispatchEvent(new CustomEvent('ah:sent', { detail: { uid: target, text, outcome: result.outcome } }));
      recent.current = [text, ...recent.current.filter((r) => r !== text)];
      cursor.current = -1;
      setText('');
      onSent(result);
    } catch (e) {
      showError(e, "Couldn't send");
    } finally {
      setBusy(false);
    }
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
      showError(e, "Couldn't attach that file");
    } finally {
      setBusy(false);
    }
  }

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
  const { models, model, modelLabel, effort, mode, levels, openSettings, pickLive, relaunchWith } = launch;
  useLaunchPalette(launch, active && !!w);

  const canSend = !!text.trim() && !busy;
  const showStop = !isShell && working && !text.trim();

  return (
    <form
      className={`composer ${isShell ? 'cmd' : ''} ${listening ? 'listening' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {suggesting && trigger && <SuggestList items={suggestions} index={pick} kind={trigger.kind} onPick={accept} />}
      <div className="composer-input">
        {isShell && <span className="prompt-sign">➜</span>}
        <textarea
          ref={area}
          rows={1}
          value={text}
          enterKeyHint="send"
          autoCapitalize={isShell ? 'off' : 'sentences'}
          autoCorrect={isShell ? 'off' : 'on'}
          spellCheck={!isShell}
          placeholder={isShell ? 'Type or paste a command' : working ? 'Add to this… (queued until it’s free · Esc stops)' : 'Send a follow-up · / commands · @ files'}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={(e) => {
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
            if (e.key === 'Escape' && !text && working && !isShell) {
              // Like the agent's own Esc: an empty composer stops the turn.
              e.preventDefault();
              stop();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
      </div>

      <div className="composer-tools">
        <div className="composer-settings">
          {preset && (models.length > 0 || preset.modelArgs || preset.settingsCommands?.model) && (
            <Popover className="tool-chip" title="Model version" label={modelLabel ?? 'Model: Default'} command="pick-model" active={active}>
              {(close) => (
                <ModelPicker preset={preset} value={{ model: model?.id, effort }}
                  disabled={!preset.switchModel && !preset.modelArgs}
                  onPick={(p) => {
                    const id = p.model ?? preset.defaultModel;
                    if (id) (preset.switchModel ? pickLive({ model: id }, close) : relaunchWith({ model: id }, close));
                    else openSettings('model', close);
                  }}
                  footer={preset.settingsCommands?.model
                    ? <button type="button" className="picker-native" onClick={() => openSettings('model', close)}>Choose model in terminal…</button>
                    : <span>{preset.switchModel ? 'Changes this session' : 'Set when starting a session'}</span>} />
              )}
            </Popover>
          )}
          {preset && (levels.length > 0 || preset.settingsCommands?.effort) && (
            <Popover className="tool-chip" title="Reasoning effort" label={`Effort: ${effort ?? 'Default'}`} command="pick-effort" active={active}>
              {(close) => (
                <EffortPicker levels={levels} value={effort} disabled={!preset.switchEffort && !preset.effort}
                  onPick={(level) => {
                    const next = level ?? preset.defaultEffort;
                    if (next) (preset.switchEffort ? pickLive({ effort: next }, close) : relaunchWith({ effort: next }, close));
                    else openSettings('effort', close);
                  }}
                  footer={preset.settingsCommands?.effort
                    ? <button type="button" className="picker-native" onClick={() => openSettings('effort', close)}>Choose effort in terminal…</button>
                    : <span>Set when starting a session</span>} />
              )}
            </Popover>
          )}
          {preset && (preset.modes?.length ?? 0) > 1 && (
            <Popover className={`tool-chip ${mode?.dangerous ? 'danger' : ''}`} title="Permission level" label={`Permissions${mode?.dangerous ? ': ⚠' : ''}`}>
              {(close) => (
                <div className="picker">
                  <div className="picker-title">Permissions</div>
                  {preset.modes!.map((m) => {
                    const current = m.id === (w?.launchMode ?? 'default');
                    return (
                      <div key={m.id} className={`picker-row static ${current ? 'on' : ''}`}>
                        <span className="picker-name" title={m.description}>
                          <span>
                            {m.dangerous ? '⚠ ' : ''}{m.name}
                            {m.description ? <span className="hint"> — {m.description}</span> : null}
                          </span>
                          {current && <span className="check">✓</span>}
                        </span>
                      </div>
                    );
                  })}
                {preset.settingsCommands?.mode
                    ? <button type="button" className="picker-name" onClick={() => openSettings('mode', close)}>Change permissions in terminal…</button>
                    : <div className="picker-foot">Set when starting a session</div>}
                </div>
              )}
            </Popover>
          )}
          {w && w.queued > 0 && <span className="tool-chip static">⇥ {w.queued} queued</span>}

        </div>

        <div className="composer-actions">
          <button type="button" className="icon-btn" title="Previous messages (↑)" onClick={() => recall(1)}>
            <Icon name="recall" />
          </button>
          <label className="icon-btn" title="Attach a file (uploaded to the host, path inserted)">
            <Icon name="attach" />
            <input type="file" multiple hidden onChange={(e) => attach(e.target.files)} />
          </label>
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
            <button type="submit" className="send-btn" disabled={!canSend} aria-label={isShell ? 'Run' : 'Send'}>
              {isShell ? 'Run' : <Icon name="up" />}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
