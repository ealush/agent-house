// ah's bridge into pi (experimental: Settings → Agents → pi → Bridge, docs/pi-bridge.md).
// pi loads it (`pi -e <this file>`) inside its own TUI, in the session's tmux pane, so it
// lives and dies with pi and never with ah: a restart of ah leaves it, and anything it holds
// (an approval nobody answered yet), where it was.
//
// Out, the way ah's hooks report (bin/ah-hook.js): the session's state, id, model, what it's
// doing and what it asks, as tmux window options ah reads on every pass.
// In, over a Unix socket at $AH_PI_SOCKET, one JSON object a line, each answered by id:
//   {type:'prompt', id, key, text}   a message, taken once per key (a retry never sends it twice)
//   {type:'stop', id}                Stop: abort the turn, deny every approval it's waiting on
//   {type:'answer', id, allow, approval?, expect?}  approve or deny the approval it asks now
//   {type:'state', id}               what it is doing now
// `/model provider/id` and `/thinking level` sent as a prompt switch directly: typed into
// pi's TUI they open its picker instead.
//
// Approvals: pi has none of its own. In ah's default mode (--ah-approval ask) a command or a
// change to a file waits for your answer, from the terminal (a Yes/No dialog) or from ah,
// whichever comes first; reads and searches don't. `--ah-approval never` asks nothing.
//
// Self-contained on purpose: pi loads it with its own module loader, so it imports only
// node's built-ins and treats pi's API as untyped (pi ships no declarations to compile against).
import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

type Msg = { type?: string; id?: string; key?: string; text?: string; allow?: boolean; approval?: string; expect?: string };
type Verdict = { allow: boolean; reason?: string; by: string };
type Approval = { id: string; kind: 'command' | 'tool'; text: string; settled: boolean; resolve: (r: Verdict) => void };

const ENTRY = 'ah-bridge';
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls']);
const MAX_IDS = 500;

/** A folder only this user can enter: real (not a link), theirs, nobody else's to touch. */
function privateDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && (!process.getuid || st.uid === process.getuid()) && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n') : '';

export default function ahBridge(pi: any) {
  const path = process.env.AH_PI_SOCKET;
  const pane = process.env.TMUX_PANE;
  // Started by hand, outside ah: nothing to report to, nothing to listen for.
  if (!path) return;

  pi.registerFlag?.('ah-approval', { description: "ah: 'ask' (default) before commands and edits, or 'never'", type: 'string' });

  let ctx: any = null;
  let server: Server | null = null;
  const clients = new Set<Socket>();
  /** Keys of messages pi has recorded: never sent again. */
  const taken: string[] = [];
  const takenSet = new Set<string>();
  /** Messages handed to pi and not recorded yet (it may hold them for after the turn): key → text, when. */
  const pending = new Map<string, { text: string; at: number }>();
  /** Every approval not settled yet: the one shown, and those waiting their turn behind it. */
  const open = new Set<Approval>();
  const waiting: Approval[] = [];
  let approvals: Promise<unknown> = Promise.resolve();
  let busy = false;
  /** pi is shutting down: what's still settling says nothing over its "ended". */
  let ended = false;

  // ---------- out: tmux window options, in the order they happen

  let writes: Promise<unknown> = Promise.resolve();
  const tmux = (...pairs: [string, string | null][]) => {
    if (!pane) return;
    const args: string[] = [];
    for (const [k, v] of pairs) {
      if (args.length) args.push(';');
      args.push('set-option', '-w', '-q', ...(v === null ? ['-u'] : []), '-t', pane, k, ...(v === null ? [] : [v]));
    }
    writes = writes.then(() => new Promise((r) => execFile('tmux', args, () => r(null))));
  };
  const now = () => String(Math.floor(Date.now() / 1000));
  const state = (s: string, ...more: [string, string | null][]) => tmux(['@ah-harness', 'pi'], ['@ah-state', s], ['@ah-state-at', now()], ...more);
  const emit = (o: object) => {
    const line = JSON.stringify(o) + '\n';
    for (const c of clients) c.write(line);
  };
  const modelOf = (c: any) => (c?.model ? `${c.model.provider}/${c.model.id}` : '');

  // ---------- approvals: one at a time, the terminal's dialog and ah's answer racing

  const policy = () => (pi.getFlag?.('ah-approval') === 'never' ? 'never' : 'ask');
  const needsApproval = (name: string) => {
    if (READ_ONLY.has(name)) return false;
    const hints = pi.getAllTools?.().find((t: any) => t.name === name)?.annotations;
    if (hints?.readOnlyHint === true && hints?.destructiveHint !== true) return false;
    return true;
  };
  const describe = (name: string, input: any): { kind: 'command' | 'tool'; text: string } => {
    if (name === 'bash') return { kind: 'command', text: String(input?.command ?? '') };
    const file = typeof input?.path === 'string' ? ` ${input.path}` : '';
    return { kind: 'tool', text: `${name === 'edit' ? 'Edit' : name === 'write' ? 'Write' : name}${file}` };
  };
  /** Denies every approval not answered yet, shown or still waiting its turn. */
  const denyAll = (reason: string, by: string) => {
    for (const a of [...open]) a.resolve({ allow: false, reason, by });
  };

  async function approve(id: string, name: string, input: any, c: any): Promise<Verdict> {
    const { kind, text } = describe(name, input);
    let settle!: (r: Verdict) => void;
    const answered = new Promise<Verdict>((r) => (settle = r));
    const a: Approval = {
      id,
      kind,
      text,
      settled: false,
      resolve: (r) => {
        if (a.settled) return;
        a.settled = true;
        open.delete(a);
        // Out of the list at once: an answer that comes now is to the next one, or to none.
        const at = waiting.indexOf(a);
        if (at >= 0) waiting.splice(at, 1);
        settle(r);
      },
    };
    open.add(a);
    // Parallel tool calls ask one after another, so ah only ever shows one question.
    const turn = approvals.then(async () => {
      // Stopped (or shut down) while it waited its turn: it's answered already, nothing to show.
      if (a.settled) return answered;
      waiting.push(a);
      // The approval's own id goes with it: an answer meant for an earlier one never settles this one.
      const ask = JSON.stringify({ kind, text, id });
      state('waiting', ['@ah-ask', ask], ['@ah-detail', JSON.stringify({ kind, text })]);
      emit({ type: 'approval', approval: id, kind, text });
      const dialog = new AbortController();
      if (c?.hasUI) {
        c.ui
          .select(`${kind === 'command' ? 'Run this command?' : 'Allow this change?'}\n\n  ${text}`, ['Yes', 'No'], { signal: dialog.signal })
          // Closed with Escape (no choice) is a no; closed because ah answered first is nothing.
          .then((v: string | undefined) => !dialog.signal.aborted && a.resolve({ allow: v === 'Yes', by: 'terminal' }))
          .catch(() => !dialog.signal.aborted && a.resolve({ allow: false, reason: 'The approval dialog failed.', by: 'terminal' }));
      }
      const r = await answered;
      dialog.abort();
      if (!ended) state(busy ? 'working' : 'done', ['@ah-ask', null], ['@ah-detail', null]);
      emit({ type: 'approval_done', approval: id, allow: r.allow, by: r.by });
      return r;
    });
    approvals = turn.catch(() => {});
    return turn;
  }

  pi.on('tool_call', async (event: any, c: any) => {
    ctx = c;
    if (policy() === 'never' || !needsApproval(event.toolName)) return undefined;
    const r = await approve(event.toolCallId, event.toolName, event.input, c);
    if (!r.allow) return { block: true, reason: r.reason ?? 'The user did not approve this.' };
    return undefined;
  });

  // ---------- messages: taken once, and only counted as taken once pi has recorded them

  /** pi recorded a message you sent: its key is spent, kept in the session for a restart of pi. */
  function recorded(text: string) {
    for (const [key, p] of pending) {
      if (p.text.trim() !== text.trim()) continue;
      pending.delete(key);
      remember(key);
      return;
    }
  }

  function remember(key: string | undefined) {
    if (!key || takenSet.has(key)) return;
    taken.push(key);
    takenSet.add(key);
    if (taken.length > MAX_IDS) takenSet.delete(taken.shift()!);
    try {
      pi.appendEntry(ENTRY, { taken: key });
    } catch {}
  }

  /**
   * What pi was handed and dropped (a submit that failed leaves nothing recorded and nothing
   * held) may come again. `minAge`: younger than this, pi may not have started on it yet.
   */
  function forgetDropped(minAge: number) {
    const quiet = (() => {
      try {
        // A pi that can't say whether it holds messages holds them, as far as this goes.
        if (typeof ctx?.hasPendingMessages !== 'function') return false;
        return !!ctx.isIdle?.() && !ctx.hasPendingMessages();
      } catch {
        return false;
      }
    })();
    for (const [key, p] of pending) {
      const age = Date.now() - p.at;
      // Only on evidence it's gone (pi quiet, holding nothing): a long turn is no such evidence.
      if (quiet && age >= minAge) pending.delete(key);
    }
  }

  // ---------- in: one connection a client, one JSON object a line

  function handle(m: Msg, reply: (o: object) => void) {
    const ok = (more: object = {}) => reply({ id: m.id, ok: true, ...more });
    const fail = (code: string, error: string) => reply({ id: m.id, ok: false, code, error });
    if (!ctx) return fail('starting', 'pi is still starting');
    try {
      switch (m.type) {
        case 'state':
          return ok({ status: waiting.length ? 'waiting' : busy ? 'working' : 'idle', session: ctx.sessionManager?.getSessionId?.() ?? null, model: modelOf(ctx), waiting: waiting.map((a) => ({ approval: a.id, kind: a.kind, text: a.text })) });
        case 'prompt': {
          const text = typeof m.text === 'string' ? m.text : '';
          if (!text.trim()) return fail('empty', 'empty message');
          // Recorded already, or handed over and still with pi (held for after its turn): not again.
          forgetDropped(15_000);
          if (m.key && (takenSet.has(m.key) || pending.has(m.key))) return ok({ again: true });
          const model = text.match(/^\/model\s+(\S+)\s*$/);
          const thinking = text.match(/^\/thinking\s+(\S+)\s*$/);
          if (model) return void switchModel(model[1]).then((r) => (r ? (remember(m.key), ok()) : fail('unknown_model', `no model ${model[1]} with a key or a sign-in`)));
          if (thinking) {
            pi.setThinkingLevel(thinking[1]);
            remember(m.key);
            return ok();
          }
          // Another slash command is pi's TUI's to run: ah types it there instead.
          if (text.startsWith('/')) return fail('command', 'a slash command is typed into the terminal');
          // A message while it waits on an approval is the answer: no, and do this instead.
          const head = waiting[0];
          if (head) {
            head.resolve({ allow: false, reason: `The user declined and said: ${text}`, by: 'ah' });
            remember(m.key);
            return ok({ answered: head.id });
          }
          if (m.key) pending.set(m.key, { text, at: Date.now() });
          try {
            if (ctx.isIdle()) pi.sendUserMessage(text);
            else pi.sendUserMessage(text, { deliverAs: 'followUp' });
          } catch (err) {
            // Refused on the spot (a compaction under way, no model): never handed over, so
            // a retry of the same key must be sent, not told it's with pi.
            if (m.key) pending.delete(m.key);
            throw err;
          }
          // Handed over; ah confirms it from the session file, and a retry of the same key
          // isn't sent again while pi still has it.
          return ok();
        }
        case 'answer': {
          const head = waiting[0];
          if (!head) return fail('not_waiting', 'it is no longer waiting');
          if ((m.approval && m.approval !== head.id) || (m.expect && m.expect !== head.text)) return fail('prompt_changed', 'it is asking something else now');
          head.resolve({ allow: m.allow === true, by: 'ah' });
          return ok({ approval: head.id });
        }
        case 'stop': {
          denyAll('Stopped by the user.', 'stop');
          ctx.abort();
          return ok();
        }
      }
      return fail('unknown', `unknown request ${m.type}`);
    } catch (err) {
      return fail('error', String((err as Error)?.message ?? err));
    }
  }

  async function switchModel(ref: string): Promise<boolean> {
    const at = ref.indexOf('/');
    const model = at > 0 ? ctx.modelRegistry.find(ref.slice(0, at), ref.slice(at + 1)) : null;
    return !!model && (await pi.setModel(model)) !== false;
  }

  function listen() {
    const dir = dirname(path!);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {}
    // Only in a folder nobody else can enter (under /tmp another user could have made it, or
    // the one above it): else no bridge, and ah types into the terminal as before.
    if (!privateDir(dir) || !privateDir(dirname(dir))) return;
    try {
      rmSync(path!, { force: true });
    } catch {}
    server = createServer((sock) => {
      clients.add(sock);
      let buf = '';
      const reply = (o: object) => sock.writable && sock.write(JSON.stringify(o) + '\n');
      sock.setEncoding('utf8');
      sock.on('data', (d: string) => {
        buf += d;
        if (buf.length > 1 << 20) return sock.destroy();
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m: Msg;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          handle(m, reply);
        }
      });
      sock.on('close', () => clients.delete(sock));
      sock.on('error', () => clients.delete(sock));
    });
    server.on('error', () => {});
    server.listen(path!, () => {
      try {
        chmodSync(path!, 0o600);
      } catch {}
    });
  }

  // ---------- lifecycle

  pi.on('session_start', (_e: any, c: any) => {
    ctx = c;
    busy = false;
    ended = false;
    taken.length = 0;
    takenSet.clear();
    pending.clear();
    for (const e of c.sessionManager?.getEntries?.() ?? []) {
      if (e?.type === 'custom' && e.customType === ENTRY && typeof e.data?.taken === 'string' && !takenSet.has(e.data.taken)) {
        taken.push(e.data.taken);
        takenSet.add(e.data.taken);
      }
    }
    const id = c.sessionManager?.getSessionId?.() ?? '';
    state('idle', ['@ah-harness-id', id || null], ['@ah-model', modelOf(c) || null], ['@ah-ask', null], ['@ah-detail', null]);
    if (!server) listen();
  });
  pi.on('model_select', (e: any, c: any) => {
    ctx = c;
    tmux(['@ah-model', modelOf(e?.model ? { model: e.model } : c) || null]);
  });
  // A message of yours in pi's conversation: the one ah handed over is taken, for good.
  pi.on('message_end', (e: any, c: any) => {
    ctx = c;
    if (e?.message?.role === 'user') recorded(textOf(e.message.content));
  });
  pi.on('agent_start', (_e: any, c: any) => {
    ctx = c;
    busy = true;
    state('working', ['@ah-detail', null]);
  });
  pi.on('tool_execution_start', (e: any, c: any) => {
    ctx = c;
    if (waiting.length) return;
    const d = describe(e.toolName, e.args ?? e.input);
    tmux(['@ah-detail', JSON.stringify({ kind: d.kind, text: d.kind === 'command' ? `$ ${d.text}` : d.text })]);
  });
  // Nothing more will run on its own (no retry, no queued follow-up): the turn is over.
  pi.on('agent_settled', (_e: any, c: any) => {
    ctx = c;
    busy = false;
    // Not one handed over a moment ago, that pi hasn't started on yet.
    forgetDropped(15_000);
    state('done', ['@ah-ask', null], ['@ah-detail', null]);
  });
  pi.on('session_shutdown', () => {
    ended = true;
    denyAll('pi is shutting down.', 'shutdown');
    state('ended', ['@ah-ask', null], ['@ah-detail', null]);
    for (const c of clients) c.destroy();
    clients.clear();
    server?.close();
    server = null;
    try {
      rmSync(path!, { force: true });
    } catch {}
  });
}
