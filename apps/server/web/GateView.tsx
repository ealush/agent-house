import { useState, type FormEvent } from 'react';
import type { Gate, HostApi, Win } from './api.ts';
import { showError } from './ask.tsx';
import { cleanScreen } from './screenText.ts';
import { copyText } from './selection.ts';

// A screen an agent draws in front of its own prompt (its folder-trust question, a
// sign-in, setup), shown off the terminal: its words with their links and its code
// in place, a button to open its link, a box for what it asks to have typed, and
// Back where Esc goes back. A message sent meanwhile waits in the queue.

export const GATE_LABEL: Record<Gate['kind'], string> = {
  trust: 'Asks to trust this folder',
  signin: 'Needs you to sign in',
  setup: 'Needs setting up',
};

/**
 * A terminal's own key hints ("Press esc to cancel", "↑↓ navigate  enter select",
 * "(escape/ctrl+c to cancel)", "c copy code • u copy url"): the card has buttons for those.
 * "Enter the authorization code:" asks for something, so it stays.
 */
const HINT = /^\(?(?:press (?:enter|esc|[a-z])\b|enter (?:to )?(?:continue|confirm|select|save|submit|choose|validate|copy)\b|esc(?:ape)?\b|ctrl\+|[↑↓]|[a-z] copy\b|use up\/down\b)/i;
const LINK = /https?:\/\/[^\s<>"'`]+/g;

/** A link as words: its host and the start of its path, never its whole query. */
export function shortLink(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const shown = u.host + path;
    return shown.length > 40 || u.search ? `${shown.slice(0, 40)}…` : shown;
  } catch {
    return url.length > 40 ? `${url.slice(0, 40)}…` : url;
  }
}

/** The screen's words, its links as links and its code where it stands. */
export function GateText({ text, gate }: { text: string; gate: Gate }) {
  const lines = cleanScreen(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !(HINT.test(l) && l.length < 90));
  return (
    <div className="gate-text">
      {lines.map((l, i) =>
        gate.code && l === gate.code ? (
          <CodeChip key={i} code={gate.code} />
        ) : (
          <p key={i}>{linked(l)}</p>
        ),
      )}
    </div>
  );
}

function linked(line: string) {
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const m of line.matchAll(LINK)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    out.push(line.slice(at, m.index), (
      <a key={m.index} href={url} target="_blank" rel="noopener noreferrer">
        {shortLink(url)}
      </a>
    ));
    at = m.index + url.length;
  }
  out.push(line.slice(at));
  return out;
}

function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="gate-code">
      <code aria-label="One-time code">{code}</code>
      <button
        type="button"
        className="btn ghost small"
        onClick={async () => {
          setCopied(await copyText(code));
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** This page is open on the agent's own machine, where a link back to 127.0.0.1 lands. */
const onHost = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);

/** The link to open, and the box for what the screen asks to have typed. */
export function GateActions({ w, client, gate }: { w: Win; client: HostApi; gate: Gate }) {
  const first = gate.links?.[0];
  // A page that hands back to the host's own browser (127.0.0.1) stops short here. With
  // its address pasted back, the host finishes it; without one, it's not the way to go.
  const away = !!gate.local && !onHost();
  const stuck = away && !gate.callback;
  return (
    <>
      {first && (
        <div className="actions">
          <a className={`btn ${stuck ? '' : 'primary'}`} data-ask-first href={first} target="_blank" rel="noopener noreferrer">
            {gate.kind === 'signin' ? 'Open the sign-in page' : `Open ${shortLink(first)}`}
          </a>
        </div>
      )}
      {away && gate.callback && <CallbackPaste key={gate.callback} w={w} client={client} callback={gate.callback} />}
      {stuck && (
        <p className="muted small gate-note">
          That page hands back to a browser on {w.host}, so it can only finish there.{gate.back ? ' Go back for another way in, like a code to enter here.' : ''}
        </p>
      )}
      {gate.input && <GateInput key={gate.input} w={w} client={client} prompt={gate.input} />}
    </>
  );
}

/**
 * The address a browser here stopped on after signing in (127.0.0.1 on this device,
 * where nothing listens), handed to the host, which opens it where the agent does.
 */
function CallbackPaste({ w, client, callback }: { w: Win; client: HostApi; callback: string }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const where = callback.replace(/^https?:\/\//, '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || state === 'sending') return;
    setState('sending');
    try {
      await client.answerGate(w.uid, { callback: text.trim() });
      setText('');
      setState('sent');
    } catch (err) {
      setState('idle');
      showError(err, "Couldn't finish the sign-in");
    }
  };
  return (
    <>
      <p className="muted small gate-note">
        After you sign in, your browser stops on a page that won&rsquo;t load ({where}…). Copy that page&rsquo;s address and paste it here: {w.host} finishes the sign-in.
      </p>
      <form className="gate-input" onSubmit={submit}>
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="The address your browser stopped on"
          placeholder={`http://${where}?code=…`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (state === 'sent') setState('idle');
          }}
        />
        <button type="submit" className="btn primary" disabled={!text.trim() || state === 'sending'}>
          {state === 'sending' ? 'Finishing…' : 'Finish signing in'}
        </button>
        {state === 'sent' && <span className="muted small">Sent: {w.host} is finishing it.</span>}
      </form>
    </>
  );
}

function GateInput({ w, client, prompt }: { w: Win; client: HostApi; prompt: string }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  // A key or a token is a secret: it shows as dots and stays out of autofill.
  // "OPENROUTER_API_KEY (or Enter to cancel):" too.
  const secret = /key|token|secret|password/i.test(prompt);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || state === 'sending') return;
    setState('sending');
    try {
      await client.answerGate(w.uid, { text: text.trim() });
      setText('');
      setState('sent');
    } catch (err) {
      setState('idle');
      showError(err, "Couldn't send that");
    }
  };
  return (
    <form className="gate-input" onSubmit={submit}>
      <input
        data-ask-first
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={prompt}
        placeholder={secret ? 'Paste it here' : 'Type or paste it here'}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (state === 'sent') setState('idle');
        }}
      />
      <button type="submit" className="btn primary" disabled={!text.trim() || state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Send'}
      </button>
      {state === 'sent' && <span className="muted small">Sent.</span>}
    </form>
  );
}

/** Esc, where the screen says it goes back. */
export function GateBack({ w, client }: { w: Win; client: HostApi }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await client.answerGate(w.uid, { back: true });
        } catch (err) {
          showError(err, "Couldn't go back");
        } finally {
          setBusy(false);
        }
      }}
    >
      Back
    </button>
  );
}
