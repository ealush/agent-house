// Capability rounds: what each agent can do through ah's HTTP API, with real agents, the way the app does it.
// --rounds N, --minutes M, --agents claude,codex,…, --only s1,s2, --cross 1 (two sessions writing to each other).
// Prints PASS/FAIL lines.
// Run by conformance/run.mjs, which starts the host and passes it in: CONFORMANCE_BASE (its
// address), CONFORMANCE_WORK (a git repository the sessions work in), CONFORMANCE_TMUX (its tmux
// socket), CONFORMANCE_RESTART (a command that restarts the host), CONFORMANCE_LOG (a JSON line
// per step), CONFORMANCE_RESULTS (where the results go, as JSON).
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const BASE = process.env.CONFORMANCE_BASE;
if (!BASE) throw new Error('CONFORMANCE_BASE: run me with conformance/run.mjs');
const AUTH = {};
const CWD = process.env.CONFORMANCE_WORK;
const LOG = process.env.CONFORMANCE_LOG ?? '/dev/null';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const AGENTS = (args.agents ?? 'claude,codex,gemini,grok,pi').split(',');
const ONLY = args.only ? args.only.split(',') : null;
const MINUTES = Number(args.minutes ?? 0);
const ROUNDS = Number(args.rounds ?? 1);

// Cheap where there's a choice; the subscription's default otherwise.
// Each in the mode that asks before it runs a command, so approvals are exercised.
const LAUNCH = {
  claude: { model: 'haiku', mode: 'default' },
  codex: { mode: 'default' },
  gemini: { model: 'gemini-4-neon', mode: 'ask' },
  grok: { mode: 'default' },
  pi: { model: 'groq/openai/gpt-oss-20b', mode: 'default' },
  muse: { mode: 'default' },
};
const OTHER_MODEL = { claude: 'sonnet', gemini: 'gemini-4-argon', grok: 'grok-4.5', pi: 'groq/openai/gpt-oss-120b', codex: 'gpt-6-luna' };
const HANDOFF = { claude: 'codex', codex: 'claude', gemini: 'claude', grok: 'pi', pi: 'claude', muse: 'claude' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
const results = [];

async function api(method, path, body) {
  // ah restarting (the chaos loop below): try again for a while, as a phone reconnecting would.
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { ...AUTH, 'x-ah': '1', origin: BASE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      break;
    } catch (e) {
      if (i >= 30 || e.name === 'TimeoutError') throw e;
      await sleep(1500);
    }
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
const state = async () => (await api('GET', '/api/state')).json;
const view = async (uid) => (await state())?.windows?.find((w) => w.uid === uid);
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(1500);
  }
  throw new Error(`timed out (${Math.round(ms / 1000)}s): ${what}${last && typeof last === 'object' && !(last instanceof Error) ? '' : ''}`);
}
/** Closes a session's window (the conversation stays, for Resume). */
async function close(uid) {
  const w = await view(uid);
  if (!w) return { status: 200 };
  return api('DELETE', `/api/windows/${w.id}`);
}
/** A folder-trust screen in front of a new session: trusted, as you'd tap it (logged). Other gates are failures. */
async function pastGate(w) {
  if (w?.status !== 'waiting' || !w.ask?.gate) return false;
  if (w.ask.gate.kind === 'trust' && w.ask.trust?.accept) {
    const r = await api('POST', `/api/sessions/${w.uid}/choose`, { key: w.ask.trust.accept });
    log({ uid: w.uid, event: 'trust', status: r.status, body: r.text.slice(0, 200) });
    await sleep(3000);
    return true;
  }
  throw new Error(`gate: ${JSON.stringify(w.ask).slice(0, 300)}`);
}
const idle = (w) => w && w.agent && ['idle', 'attention'].includes(w.status);
async function feed(uid) {
  return (await api('GET', `/api/sessions/${uid}/feed`)).json?.entries ?? [];
}
const texts = (entries, role) => entries.filter((e) => !role || e.role === role).flatMap((e) => e.parts.filter((p) => p.type === 'text').map((p) => p.text));
const said = async (uid, needle) => texts(await feed(uid), 'assistant').some((t) => t.includes(needle));
const userSaid = async (uid, needle) => texts(await feed(uid), 'user').filter((t) => t.includes(needle)).length;

/** Approves (or denies) whatever it asks until `done`; returns how many asks it answered. */
async function answering(uid, done, ms, answer = 'approve') {
  const end = Date.now() + ms;
  let answered = 0;
  while (Date.now() < end) {
    const w = await view(uid);
    if (await done(w)) return answered;
    if (w?.status === 'waiting') {
      if (w.answerable) {
        const r = await api('POST', `/api/sessions/${uid}/answer`, { answer, prompt: w.askId });
        log({ uid, event: 'answer', answer, ask: w.ask, status: r.status, body: r.text.slice(0, 200) });
        if (r.status === 200) answered++;
      } else if (w.ask?.options?.length) {
        // A picker (Codex/agy approvals): its first row is the yes.
        const key = answer === 'approve' ? w.ask.options[0].key : w.ask.options.at(-1).key;
        const r = await api('POST', `/api/sessions/${uid}/choose`, { key });
        log({ uid, event: 'choose', key, ask: w.ask, status: r.status, body: r.text.slice(0, 200) });
        if (r.status === 200) answered++;
      } else if (w.ask?.gate) {
        throw new Error(`gate in the way: ${JSON.stringify(w.ask).slice(0, 300)}`);
      } else {
        log({ uid, event: 'waiting-unanswerable', ask: w.ask });
      }
      await sleep(2500);
    }
    await sleep(1500);
  }
  throw new Error('timed out answering');
}

async function start(agent, extra = {}) {
  const r = await api('POST', '/api/windows', { preset: agent, cwd: CWD, trust: true, name: `conf-${agent}`, ...LAUNCH[agent], ...extra });
  if (r.status !== 201) throw new Error(`create ${agent}: ${r.status} ${r.text}`);
  const { uid } = r.json;
  await until(async () => {
    const w = await view(uid);
    if (await pastGate(w)) return false;
    return idle(w) && w;
  }, 90_000, `${agent} ready`);
  return uid;
}

async function send(uid, text, id) {
  const r = await api('POST', `/api/sessions/${uid}/send`, { text, ...(id ? { id } : {}) });
  if (r.status !== 200) throw new Error(`send: ${r.status} ${r.text}`);
  return r.json;
}

const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();

// ---------- scenarios: each takes (agent, ctx) and throws on failure

const SCENARIOS = {
  async reply(agent, c) {
    const t = `PONG${tag()}`;
    await send(c.uid, `Reply with exactly the word ${t} and nothing else.`);
    await until(() => said(c.uid, t), 120_000, `reply ${t}`);
    await until(async () => idle(await view(c.uid)), 60_000, 'idle after reply');
    if ((await userSaid(c.uid, t)) !== 1) throw new Error(`message shows ${await userSaid(c.uid, t)} times`);
  },

  async queue(agent, c) {
    const a = `ALPHA${tag()}`, b = `BETA${tag()}`;
    await send(c.uid, `Reply with exactly the word ${a} and nothing else.`);
    const second = await send(c.uid, `Reply with exactly the word ${b} and nothing else.`);
    log({ uid: c.uid, event: 'queued-second', outcome: second.outcome });
    await until(() => said(c.uid, b), 180_000, `both replies (${b})`);
    if (!(await said(c.uid, a))) throw new Error(`first reply ${a} missing`);
    const order = texts(await feed(c.uid), 'assistant');
    if (order.findIndex((t) => t.includes(a)) > order.findIndex((t) => t.includes(b))) throw new Error('replies out of order');
    await until(async () => idle(await view(c.uid)) && !(await view(c.uid)).queued, 60_000, 'queue drained');
  },

  async approve(agent, c) {
    const t = `CONF${tag()}`;
    await send(c.uid, `Use your shell tool to run exactly this command: echo ${t}-$((6*7)) . Then reply with the command's output only.`);
    const n = await answering(c.uid, async (w) => idle(w) && (await said(c.uid, `${t}-42`)), 180_000);
    log({ uid: c.uid, event: 'approve-done', asked: n });
    c.asked = n;
  },

  async deny(agent, c) {
    const t = `NOPE${tag()}`;
    const before = (await feed(c.uid)).length;
    await send(c.uid, `Use your shell tool to run exactly: touch ${t}.txt . If you can't, reply with exactly DENIED-${t}.`);
    // The turn has started (the message is in) and ended (a reply after it, and idle).
    // agy ends the turn at a denied command, with no reply: its cancelled result ends it too.
    const n = await answering(c.uid, async (w) => idle(w) && (await userSaid(c.uid, t)) > 0 && (await feed(c.uid)).slice(before).some((e) => (e.role === 'assistant' && e.parts.some((p) => p.type === 'text')) || e.parts.some((p) => p.type === 'tool_result' && p.result.isError)), 180_000, 'deny');
    const made = await exec('ls', [CWD]).then((o) => o.stdout.includes(`${t}.txt`));
    log({ uid: c.uid, event: 'deny-done', asked: n, made });
    if (n > 0 && made) throw new Error('denied, and the file was made anyway');
  },

  async stop(agent, c) {
    await send(c.uid, 'Write the numbers from 1 to 600, one per line, with no other text. Do not use any tools.');
    await until(async () => (await view(c.uid))?.status === 'busy', 60_000, 'busy');
    await sleep(4000);
    const r = await api('POST', `/api/sessions/${c.uid}/interrupt`);
    if (r.status !== 200) throw new Error(`interrupt: ${r.status} ${r.text}`);
    await until(async () => idle(await view(c.uid)), 45_000, 'stopped');
    // Still usable after.
    await SCENARIOS.reply(agent, c);
  },

  async switchModel(agent, c) {
    const to = OTHER_MODEL[agent];
    // No other model to pick (Muse lists none): its effort, live.
    if (!to) {
      const r = await api('POST', `/api/sessions/${c.uid}/switch`, { effort: 'low' });
      log({ uid: c.uid, event: 'switch-effort', status: r.status, body: r.text.slice(0, 200) });
      if (r.status !== 200) throw new Error(`switch effort: ${r.status} ${r.text}`);
      await until(async () => {
        const w = await view(c.uid);
        return idle(w) && w.launchEffort === 'low';
      }, 90_000, 'launchEffort low');
      await SCENARIOS.reply(agent, c);
      return 'effort';
    }
    const r = await api('POST', `/api/sessions/${c.uid}/switch`, { model: to });
    log({ uid: c.uid, event: 'switch', to, status: r.status, body: r.text.slice(0, 200) });
    if (r.status === 400 && /can't switch models/.test(r.text)) return 'unsupported';
    if (r.status !== 200) throw new Error(`switch: ${r.status} ${r.text}`);
    await until(async () => {
      const w = await view(c.uid);
      return idle(w) && w.launchModel === to;
    }, 90_000, `launchModel ${to}`);
    await SCENARIOS.reply(agent, c);
  },

  async resume(agent, c) {
    const word = `ZEBRA${tag()}`;
    const before = (await feed(c.uid)).length;
    await send(c.uid, `Remember this code word: ${word}. Reply with exactly OK.`);
    // OK after this message, not an earlier one.
    await until(async () => idle(await view(c.uid)) && (await userSaid(c.uid, word)) > 0 && texts((await feed(c.uid)).slice(before), 'assistant').some((t) => t.includes('OK')), 120_000, 'ok');
    const harnessId = (await view(c.uid)).harnessId;
    if (!harnessId) throw new Error('no harnessId to resume by');
    const k = await close(c.uid);
    if (![200, 204].includes(k.status)) throw new Error(`close: ${k.status} ${k.text}`);
    await until(async () => !(await view(c.uid)), 30_000, 'closed');
    const hist = (await state())?.history ?? [];
    log({ uid: c.uid, event: 'history', found: JSON.stringify(hist).includes(harnessId) });
    const r = await api('POST', `/api/sessions/${c.uid}/resume`, {});
    if (r.status !== 200 && r.status !== 201) throw new Error(`resume: ${r.status} ${r.text}`);
    await until(async () => idle(await view(c.uid)), 90_000, 'resumed idle');
    const q = `What was the code word I gave you? Reply with just the word. (${tag()})`;
    await send(c.uid, q);
    // An agent that can't resume (Muse) starts a new conversation: ah follows it, once each.
    const resumable = (await state()).presets.find((p) => p.id === agent);
    if (!resumable.resume && !resumable.resumeId) {
      await until(async () => idle(await view(c.uid)) && (await userSaid(c.uid, q)) === 1 && texts(await feed(c.uid), 'assistant').length > 0, 120_000, 'the new conversation shows');
      return 'new conversation';
    }
    await until(async () => texts(await feed(c.uid), 'assistant').slice(-3).some((t) => t.includes(word)), 120_000, `remembers ${word}`);
  },

  async handoff(agent, c) {
    const to = HANDOFF[agent];
    const word = `KIWI${tag()}`;
    const before = (await feed(c.uid)).length;
    await send(c.uid, `Remember this code word: ${word}. Reply with exactly OK.`);
    // OK after this message, not an earlier one.
    await until(async () => idle(await view(c.uid)) && (await userSaid(c.uid, word)) > 0 && texts((await feed(c.uid)).slice(before), 'assistant').some((t) => t.includes('OK')), 120_000, 'ok');
    const r = await api('POST', `/api/portable/conversations/${c.uid}/continue`, { to, intent: 'continue' });
    log({ uid: c.uid, event: 'handoff', to, status: r.status, body: r.text.slice(0, 300) });
    if (r.status !== 201 && r.status !== 200) throw new Error(`continue: ${r.status} ${r.text.slice(0, 300)}`);
    const opId = r.json.operation.id;
    const op = await until(async () => {
      const o = (await api('GET', `/api/portable/operations/${opId}`)).json;
      if (o?.childUid) await pastGate(await view(o.childUid));
      if (o?.state === 'failed') throw new Error(`handoff failed: ${JSON.stringify(o).slice(0, 300)}`);
      return o?.childUid && o.state === 'linked' ? o : null;
    }, 180_000, 'handoff operation');
    const child = op.childUid;
    c.children.push(child);
    await answering(child, async (w) => {
      if (await pastGate(w)) return false;
      return idle(w);
    }, 180_000);
    await send(child, 'What code word did I give you earlier in this conversation? Reply with just the word.');
    await until(async () => texts(await feed(child), 'assistant').some((t) => t.includes(word)), 180_000, `${to} knows ${word}`);
  },
};

// Effort mid-conversation, live: every agent whose preset can switch it.
SCENARIOS.effort = async (agent, c) => {
  const p = (await state()).presets.find((x) => x.id === agent);
  if (!p.switchEffort) return 'no live effort switch';
  const w = await view(c.uid);
  const model = p.models?.find((m) => m.id === (w.launchModel ?? p.defaultModel));
  const levels = model?.efforts?.length ? model.efforts : (p.effort?.levels ?? []);
  const to = levels.find((l) => l !== w.launchEffort && /^(low|medium|high)$/.test(l)) ?? levels.find((l) => l !== w.launchEffort);
  if (!to) return 'no other level';
  const r = await api('POST', `/api/sessions/${c.uid}/switch`, { effort: to });
  log({ uid: c.uid, event: 'effort', to, status: r.status, body: r.text.slice(0, 200) });
  if (r.status !== 200) throw new Error(`switch effort ${to}: ${r.status} ${r.text}`);
  await until(async () => idle(await view(c.uid)) && (await view(c.uid)).launchEffort === to, 90_000, `launchEffort ${to}`);
  await SCENARIOS.reply(agent, c);
  return to;
};

// Fork: a copy of the conversation in its own worktree that knows what was said before it.
SCENARIOS.fork = async (agent, c) => {
  const info = (await api('GET', `/api/sessions/${c.uid}/fork-info`)).json;
  if (info && info.canFork === false) return `can't fork: ${info.reason}`;
  const word = `FIG${tag()}`;
  const before = (await feed(c.uid)).length;
  await send(c.uid, `Remember this code word: ${word}. Reply with exactly OK.`);
  await until(async () => idle(await view(c.uid)) && texts((await feed(c.uid)).slice(before), 'assistant').some((t) => t.includes('OK')), 120_000, 'ok');
  const r = await api('POST', `/api/sessions/${c.uid}/fork`, { name: `conf-fork-${agent}` });
  log({ uid: c.uid, event: 'fork', status: r.status, body: r.text.slice(0, 300) });
  if (r.status !== 200 && r.status !== 201) throw new Error(`fork: ${r.status} ${r.text.slice(0, 300)}`);
  const child = r.json.uid;
  c.children.push(child);
  await answering(child, async (w) => {
    if (await pastGate(w)) return false;
    return idle(w);
  }, 180_000);
  await send(child, 'What code word did I give you most recently? Reply with just the word.');
  await answering(child, async (w) => idle(w) && texts(await feed(child), 'assistant').some((t) => t.includes(word)), 180_000);
  return r.json.branch ?? 'forked';
};

const ORDER = ['reply', 'queue', 'approve', 'deny', 'stop', 'switchModel', 'effort', 'resume', 'fork', 'handoff'];

// ---------- across sessions: one agent drives another through ah (`ah send`, `ah read`, `ah mail`)
async function cross() {
  const step = async (name, fn) => {
    try {
      const out = await fn();
      results.push({ agent: 'cross', round: 0, name, ok: true });
      console.log(`PASS cross ${name}${out ? ` (${out})` : ''}`);
    } catch (e) {
      results.push({ agent: 'cross', round: 0, name, ok: false, error: e.message });
      console.log(`FAIL cross ${name}: ${e.message}`);
    }
  };
  let a, b;
  await step('start', async () => {
    // A runs commands without asking (Claude's auto mode), B is any other agent.
    a = await start('claude', { mode: 'auto', name: 'conf-cross-a' });
    b = await start('codex', { name: 'conf-cross-b' });
  });
  if (!a || !b) return;
  await step('ah send + ah read', async () => {
    const t = `XS${tag()}`;
    await send(a, `Use your shell to run exactly: ah send ${b} "Reply with exactly the word ${t} and nothing else." --wait --timeout 120 ; then run: ah read ${b} ; and reply with the last word the other session said.`);
    await until(() => said(b, t), 240_000, `B replied ${t}`);
    await answering(a, async (w) => idle(w) && texts(await feed(a), 'assistant').slice(-2).some((x) => x.includes(t)), 240_000);
    if ((await userSaid(b, t)) !== 1) throw new Error(`B got it ${await userSaid(b, t)} times`);
  });
  await step('ah mail send --wake', async () => {
    const t = `MAIL${tag()}`;
    const before = (await feed(a)).length;
    await send(a, `Use your shell to run exactly: ah mail send ${b} "Reply to this mail with exactly the word ${t}." --subject conformance --wake ; then reply with the command's output.`);
    // Its reply to this message, not the last one.
    await answering(a, async (w) => idle(w) && (await userSaid(a, t)) > 0 && texts((await feed(a)).slice(before), 'assistant').length > 0, 180_000);
    const out = texts(await feed(a), 'assistant').slice(-1)[0] ?? '';
    log({ event: 'mail', a, b, out: out.slice(0, 300) });
    const inbox = (await api('GET', `/api/fleet/mailbox?uid=${b}`)).json?.messages ?? [];
    const got = inbox.some((m) => (m.body ?? '').includes(t));
    if (!got && /refus|denied|not allowed|cannot|403/i.test(out)) return `refused by policy: ${out.slice(0, 120)}`;
    if (!got) throw new Error(`no mail for B: ${out.slice(0, 200)}`);
    // --wake puts a note in B's conversation; B reads its inbox and answers.
    await until(async () => texts(await feed(b), 'user').some((x) => x.includes('ah mail')), 120_000, 'B woken');
    return 'delivered, B woken';
  });
  for (const u of [a, b]) await close(u).catch(() => {});
}

async function runAgent(agent, round) {
  const c = { uid: null, children: [] };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      results.push({ agent, round, name, ok: true });
      log({ agent, round, name, ok: true, ms: Date.now() - t0, uid: c.uid, out });
      console.log(`PASS ${agent} r${round} ${name} ${Math.round((Date.now() - t0) / 1000)}s${out ? ` (${out})` : ''}`);
    } catch (e) {
      const w = c.uid ? await view(c.uid).catch(() => null) : null;
      // The provider's answer, not ah's: a rate limit, a model the key can't use, out of quota.
      const notices = c.uid ? (await feed(c.uid).catch(() => [])).slice(-6).flatMap((x) => x.parts.filter((p) => p.type === 'notice').map((p) => p.text)) : [];
      const provider = notices.find((t) => /^(4\d\d|5\d\d)\b|rate limit|quota|exhausted|does not exist|validation failed/i.test(t));
      if (provider) e.message = `PROVIDER ${provider.slice(0, 120)} (${e.message})`;
      results.push({ agent, round, name, ok: false, provider: !!provider, error: e.message });
      log({ agent, round, name, ok: false, ms: Date.now() - t0, uid: c.uid, error: e.message, view: w && { status: w.status, statusSource: w.statusSource, ask: w.ask, queued: w.queued, detail: w.detail } });
      console.log(`FAIL ${agent} r${round} ${name}: ${e.message} [${c.uid}] ${w ? `status=${w.status}/${w.statusSource} ask=${JSON.stringify(w.ask)?.slice(0, 160)}` : ''}`);
      return false;
    }
    return true;
  };
  if (!(await step('start', async () => (c.uid = await start(agent))))) return;
  for (const s of ORDER) {
    if (ONLY && !ONLY.includes(s)) continue;
    // A failure leaves the session in an unknown state: the next scenario starts from idle or a fresh one.
    const ok = await step(s, () => SCENARIOS[s](agent, c));
    if (!ok) {
      await sleep(3000);
      const w = await view(c.uid).catch(() => null);
      if (!idle(w)) {
        await close(c.uid).catch(() => {});
        if (!(await step('restart', async () => (c.uid = await start(agent))))) return;
      }
    }
  }
  // Leave nothing running.
  for (const u of [c.uid, ...c.children]) await close(u).catch(() => {});
}

const RESTART = Number(args['restart-every'] ?? 0);
let restarting = null;
if (RESTART) {
  restarting = setInterval(() => {
    console.log(`-- restarting ah (${new Date().toLocaleTimeString()})`);
    log({ event: 'restart-ah' });
    execFile(process.env.CONFORMANCE_RESTART, (err, out) => console.log(`-- ah ${err ? `failed: ${err.message}` : out.trim()}`));
  }, RESTART * 60_000);
}

const t0 = Date.now();
let round = 0;
do {
  round++;
  console.log(`== round ${round} (${AGENTS.join(', ')})`);
  await Promise.all([...AGENTS.map((a) => runAgent(a, round)), ...(args.cross && round === 1 && (!ONLY || ONLY.includes('cross')) ? [cross()] : [])]);
} while ((MINUTES && Date.now() - t0 < MINUTES * 60_000) || round < ROUNDS);

if (restarting) clearInterval(restarting);
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} passed in ${Math.round((Date.now() - t0) / 60000)} min; ${fails.filter((f) => f.provider).length} of the failures were the provider's`);
for (const f of fails) console.log(`  FAIL ${f.agent} r${f.round} ${f.name}: ${f.error}`);
if (process.env.CONFORMANCE_RESULTS) writeFileSync(process.env.CONFORMANCE_RESULTS, JSON.stringify(results, null, 2));
