// Scenarios from ah's own bug-fix history, run against a disposable
// host with real agents through ah's HTTP API. Each scenario names the commits it
// re-checks. Fault injection uses the host's own tmux only, by its socket.
// Run by conformance/run.mjs, which starts the host and passes it in: CONFORMANCE_BASE (its
// address), CONFORMANCE_WORK (a git repository the sessions work in), CONFORMANCE_TMUX (its tmux
// socket), CONFORMANCE_RESTART (a command that restarts the host), CONFORMANCE_LOG (a JSON line
// per step), CONFORMANCE_RESULTS (where the results go, as JSON).
// --only a,b (scenario name prefixes), --agents claude,codex,...
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const BASE = process.env.CONFORMANCE_BASE;
if (!BASE) throw new Error('CONFORMANCE_BASE: run me with conformance/run.mjs');
// On the real ah: the host's local token (as the CLI), acting as this session (its workers).
const authNow = () => ({});
const ROOT = process.env.CONFORMANCE_WORK;
const LOG = process.env.CONFORMANCE_LOG ?? '/dev/null';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const ONLY = args.only ? args.only.split(',') : null;
const AGENTS = (args.agents ?? 'claude,codex,gemini,grok,muse,pi').split(',');
const LAUNCH = { claude: { model: 'haiku' }, codex: {}, gemini: { model: 'gemini-4-neon' }, grok: {}, muse: {}, pi: { model: 'groq/openai/gpt-oss-20b' } };
const ASKS = { gemini: { mode: 'ask' }, pi: { mode: 'default' } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = () => randomBytes(3).toString('hex').toUpperCase();
const log = (o) => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
// The host's own tmux, by its socket: never the one this runs in.
const tmux = (...a) => execFileSync('tmux', ['-S', process.env.CONFORMANCE_TMUX, ...a], { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'TMUX' && k !== 'TMUX_PANE')), encoding: 'utf8' });

async function api(method, path, body) {
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await fetch(BASE + path, { method, headers: { ...authNow(), 'x-ah': '1', origin: BASE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      break;
    } catch (e) {
      if (i >= 40 || e.name === 'TimeoutError') throw e;
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
const idle = (w) => w && w.agent && ['idle', 'attention'].includes(w.status);
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(1200);
  }
  throw new Error(`timed out (${Math.round(ms / 1000)}s): ${what}`);
}
const feed = async (uid) => (await api('GET', `/api/sessions/${uid}/feed`)).json?.entries ?? [];
const texts = (entries, role) => entries.filter((e) => !role || e.role === role).flatMap((e) => e.parts.filter((p) => p.type === 'text').map((p) => p.text));
const userCount = async (uid, needle) => texts(await feed(uid), 'user').filter((t) => t.includes(needle)).length;
const said = async (uid, needle) => texts(await feed(uid), 'assistant').some((t) => t.includes(needle));
const screen = async (uid) => (await api('GET', `/api/sessions/${uid}/terminal/text`)).json?.screen ?? '';

async function start(agent, extra = {}, cwd = ROOT) {
  const r = await api('POST', '/api/windows', { preset: agent, cwd, trust: true, name: `repro-${agent}`, ...LAUNCH[agent], ...extra });
  if (r.status !== 201) throw new Error(`create ${agent}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}
async function ready(uid, ms = 120_000) {
  return until(async () => {
    const w = await view(uid);
    if (w?.status === 'waiting' && w.ask?.gate?.kind === 'trust' && w.ask.trust?.accept) await api('POST', `/api/sessions/${uid}/choose`, { key: w.ask.trust.accept });
    return idle(w) && w;
  }, ms, 'ready');
}
async function close(uid) {
  const w = await view(uid);
  if (w) await api('DELETE', `/api/windows/${w.id}`);
}
const send = (uid, text, id) => api('POST', `/api/sessions/${uid}/send`, { text, ...(id ? { id } : {}) });
const LONG = 'Write the numbers from 1 to 600, one per line, with no other text. Do not use any tools.';
function check(ok, msg) {
  if (!ok) throw new Error(msg);
}

// ---------- the scenarios: [name, shas, agents it applies to, fn(agent) → note]
const S = [];
const sc = (name, shas, agents, fn) => S.push({ name, shas, agents, fn });

sc('watched: two sends back to back land once each, in order, none shown as not sent', 'aadc3ab3 ede0ea82 9cfdb53c', ['claude', 'codex', 'gemini', 'grok', 'muse', 'pi'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    const a = `LAND${tag()}`, b = `LAND${tag()}`;
    await send(s.uid, `Reply with exactly the word ${a} and nothing else.`);
    await send(s.uid, `Reply with exactly the word ${b} and nothing else.`);
    await until(() => said(s.uid, b), 180_000, `${b}`);
    await until(async () => idle(await view(s.uid)), 60_000, 'idle');
    const us = texts(await feed(s.uid), 'user');
    check(us.filter((t) => t.includes(a)).length === 1 && us.filter((t) => t.includes(b)).length === 1, `each once: ${us.slice(-4).join(' | ')}`);
    check(us.findIndex((t) => t.includes(a)) < us.findIndex((t) => t.includes(b)), 'in order');
    await sleep(15_000);
    check(((await view(s.uid)).unsent ?? 0) === 0, `unsent ${(await view(s.uid)).unsent}`);
  } finally {
    await close(s.uid);
  }
});

sc('first prompt: sent before the agent is up, it and the next are submitted once, in order', '89c741f1 da4a982a 2f108746', ['claude', 'codex', 'gemini', 'grok', 'muse', 'pi'], async (agent) => {
  const s = await start(agent);
  try {
    const a = `FIRST${tag()}`, b = `SECOND${tag()}`;
    const r1 = await send(s.uid, `Reply with exactly the word ${a} and nothing else.`);
    const r2 = await send(s.uid, `Reply with exactly the word ${b} and nothing else.`);
    log({ scenario: 'first', agent, r1: r1.json, r2: r2.json });
    await until(() => said(s.uid, b), 240_000, `${b}`);
    await until(async () => idle(await view(s.uid)), 60_000, 'idle');
    check((await userCount(s.uid, a)) === 1 && (await userCount(s.uid, b)) === 1, 'each once');
    check(!(await screen(s.uid)).includes(a), 'nothing left in the box');
    return `${r1.json?.outcome}${r1.json?.starting ? ' (starting)' : ''}, then ${r2.json?.outcome}`;
  } finally {
    await close(s.uid);
  }
});

sc("named: a sender's id is typed once, retried after delivery and while queued", 'aa044203 37570e67 a21a8821', ['claude', 'codex', 'pi'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    const id = `r-${tag()}`;
    const w = `ONCE${tag()}`;
    await send(s.uid, `Reply with exactly the word ${w} and nothing else.`, id);
    await until(() => said(s.uid, w), 120_000, w);
    const again = await send(s.uid, `Reply with exactly the word ${w} and nothing else.`, id);
    check(again.json?.outcome === 'delivered', `retry: ${again.text}`);
    await until(async () => idle(await view(s.uid)), 60_000, 'idle');
    await send(s.uid, LONG);
    await until(async () => (await view(s.uid))?.status === 'busy', 60_000, 'busy');
    const qid = `q-${tag()}`, q = `QUEUED${tag()}`;
    const q1 = await send(s.uid, `Reply with exactly the word ${q} and nothing else.`, qid);
    const q2 = await send(s.uid, `Reply with exactly the word ${q} and nothing else.`, qid);
    check(q1.json?.outcome === 'queued' && q2.json?.outcome === 'queued', `queued twice? ${q1.text} ${q2.text}`);
    const items = (await api('GET', `/api/sessions/${s.uid}/queue`)).json ?? [];
    check(items.filter((i) => i.id === qid).length === 1, `one in the queue: ${JSON.stringify(items).slice(0, 200)}`);
    await api('POST', `/api/sessions/${s.uid}/interrupt`);
    await until(() => said(s.uid, q), 180_000, q);
    await sleep(5000);
    check((await userCount(s.uid, w)) === 1 && (await userCount(s.uid, q)) === 1, 'once each');
  } finally {
    await close(s.uid);
  }
});

sc('steer: Send Now during a long turn stops it and goes in once; a second Send Now is clean', '9968c67c 68ca21dd 063a190c', ['claude', 'codex', 'gemini', 'grok', 'muse', 'pi'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    await send(s.uid, LONG);
    await until(async () => (await view(s.uid))?.status === 'busy', 60_000, 'busy');
    await sleep(3000);
    const a = `STEER${tag()}`, b = `STEER${tag()}`;
    const q1 = (await send(s.uid, `Reply with exactly the word ${a} and nothing else.`)).json;
    const q2 = (await send(s.uid, `Reply with exactly the word ${b} and nothing else.`)).json;
    const t0 = Date.now();
    const [n1, n2] = await Promise.all([api('POST', `/api/sessions/${s.uid}/queue/${q1.queueId}/send-now`), sleep(300).then(() => api('POST', `/api/sessions/${s.uid}/queue/${q2.queueId}/send-now`))]);
    const ms = Date.now() - t0;
    // 404: the turn ended and the queue delivered it first (a fast model): as good as sent now.
    check(n1.status === 200 || n1.json?.code === 'queue_item_gone', `first send-now ${n1.status} ${n1.text}`);
    check(n1.json?.code !== 'did_not_stop', 'stopped');
    // The second Send Now stops the turn answering the first (that's what it's for): both go in,
    // and the agent answers after the last (what it says is the model's business).
    await until(async () => {
      const es = await feed(s.uid);
      const at = es.findIndex((e) => e.role === 'user' && e.parts.some((p) => p.type === 'text' && p.text.includes(b)));
      return at >= 0 && es.slice(at + 1).some((e) => e.role === 'assistant' && e.parts.some((p) => p.type === 'text'));
    }, 180_000, `a reply after ${b}`);
    // Done working: idle, or asking you something (a model may ask which of the two it meant).
    await until(async () => ['idle', 'attention', 'waiting'].includes((await view(s.uid))?.status), 60_000, 'not working');
    // Claude stopped before its first word hands the first back, and it goes in again with the
    // second (063a190c): at most twice, never lost; the second once.
    const na = await userCount(s.uid, a), nb = await userCount(s.uid, b);
    check(na >= 1 && na <= 2 && nb === 1, `each in: ${na}, ${nb}`);
    return `first in ${Math.round(ms / 1000)}s, second ${n2.status}`;
  } finally {
    await close(s.uid);
  }
});

sc("trust: a message waits behind the agent's trust prompt, goes in once after it's accepted", 'da6f2938 baab3f0c d71dd7d5', ['claude', 'codex', 'gemini', 'grok', 'muse'], async (agent) => {
  const dir = `${ROOT}/t-${agent}-${tag().toLowerCase()}`;
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  const r = await api('POST', '/api/windows', { preset: agent, cwd: dir, name: `repro-trust-${agent}`, ...LAUNCH[agent] });
  check(r.status === 201, `create ${r.status} ${r.text}`);
  const s = r.json;
  try {
    const w = await until(async () => {
      const x = await view(s.uid);
      if (idle(x)) return { noPrompt: true };
      return x?.status === 'waiting' && x.ask?.gate?.kind === 'trust' && x;
    }, 90_000, 'its trust prompt');
    if (w.noPrompt) return 'asked nothing in a new folder (trusted already)';
    const t = `TRUSTED${tag()}`;
    const sent = (await send(s.uid, `Reply with exactly the word ${t} and nothing else.`)).json;
    check(sent?.outcome === 'queued' && sent?.held === 'trust', `held: ${JSON.stringify(sent)}`);
    await sleep(3000);
    check(!(await screen(s.uid)).includes(t), 'not typed into the prompt');
    await api('POST', `/api/sessions/${s.uid}/choose`, { key: w.ask.trust.accept });
    await until(() => said(s.uid, t), 180_000, `${t} after trusting`);
    check((await userCount(s.uid, t)) === 1, 'once');
    return 'held, then delivered once';
  } finally {
    await close(s.uid);
  }
});

sc('scrolled back: a message sent while the terminal is in copy mode goes in, Enter and all', 'f0351640 8dd6ca86', ['claude', 'codex', 'gemini'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    tmux('copy-mode', '-t', s.id);
    try {
      tmux('send-keys', '-t', s.id, '-X', 'scroll-up');
    } catch {}
    const t = `COPY${tag()}`;
    await send(s.uid, `Reply with exactly the word ${t} and nothing else.`);
    await until(() => said(s.uid, t), 120_000, t);
    check((await userCount(s.uid, t)) === 1, 'once');
  } finally {
    await close(s.uid);
  }
});

sc('long: a 40,000-character message goes in once; 140,000 is refused, saying so', '0460434d', ['claude', 'pi'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    const t = `FORTYK${tag()}`;
    const body = `Reply with exactly the word ${t} and nothing else. Ignore the filler below.\n` + 'filler words here. '.repeat(2100);
    const r = await send(s.uid, body);
    check(r.status === 200, `40K: ${r.status} ${r.text.slice(0, 200)}`);
    await until(() => said(s.uid, t), 240_000, t);
    check((await userCount(s.uid, t)) === 1, 'once');
    const big = await send(s.uid, 'x'.repeat(140_000));
    check(big.status === 400 && /too_long|too long/i.test(big.text), `140K: ${big.status} ${big.text.slice(0, 200)}`);
  } finally {
    await close(s.uid);
  }
});

sc('numbered: a message that is a numbered list is typed as text, and Send Now after it glues nothing', '325a273c d6cdd6e7 063a190c', ['claude'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    const done = `LISTDONE${tag()}`, st = `STEERED${tag()}`;
    await send(s.uid, `1. Write the numbers from 1 to 300, one per line.\n2. Then say ${done}.`);
    const q = (await send(s.uid, `Reply with exactly the word ${st} and nothing else.`)).json;
    if (q?.queueId) await api('POST', `/api/sessions/${s.uid}/queue/${q.queueId}/send-now`);
    // Delivered is what's checked: the model may well answer the list it's handed back and
    // leave the word (Haiku did, with both in one paste).
    await until(async () => (await userCount(s.uid, st)) > 0, 180_000, `${st} delivered`);
    await until(async () => idle(await view(s.uid)), 120_000, 'idle');
    const us = texts(await feed(s.uid), 'user');
    // Stopped before its first word, Claude hands the list back: it goes in again ahead of the
    // urgent one (063a190c), apart from it, never glued to it, and not a third time.
    check(us.filter((t) => t.includes('Write the numbers from 1 to 300')).length <= 2, 'the list at most twice (sent, and handed back once)');
    check(!us.some((t) => t.includes(`${done}.Reply`) || t.includes(`${done}Reply`)), 'never glued');
    check((await userCount(s.uid, st)) === 1, 'steered once');
    check(!(await screen(s.uid)).includes(st), 'box empty');
  } finally {
    await close(s.uid);
  }
});

sc("relaunch: a message to a relaunched session's old uid follows its conversation into one window", 'c6c132f9 baf5b78a f3414a5b', ['claude', 'codex'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    const word = `KIWI${tag()}`;
    await send(s.uid, `Remember the word ${word}. Reply with exactly OK.`);
    await until(async () => idle(await view(s.uid)) && (await userCount(s.uid, word)) === 1 && (await said(s.uid, 'OK')), 120_000, 'ok');
    const hid = (await view(s.uid)).harnessId;
    const rl = await api('POST', `/api/sessions/${s.uid}/relaunch`, agent === 'claude' ? { model: 'sonnet' } : {});
    check([200, 201].includes(rl.status), `relaunch ${rl.status} ${rl.text.slice(0, 200)}`);
    const q = `What word did I ask you to remember? Reply with just it. (${tag()})`;
    const r = await send(s.uid, q);
    log({ scenario: 'relaunch', agent, relaunch: rl.json, send: r.json });
    await until(async () => texts(await feed(rl.json?.uid ?? s.uid), 'assistant').some((t) => t.includes(word)), 180_000, 'remembers');
    const live = (await state()).windows.filter((w) => w.harnessId === hid && w.agent);
    check(live.length === 1, `one window on the conversation: ${live.length}`);
    check((await userCount(rl.json?.uid ?? s.uid, q)) === 1, 'once');
    s.uid = rl.json?.uid ?? s.uid;
  } finally {
    await close(s.uid);
  }
});

sc('answer once: concurrent approves type one answer; a stale alert never approves the next command', '70e5f832 155bac4e 548b9ac4', ['gemini', 'pi'], async (agent) => {
  const s = await start(agent, ASKS[agent]);
  try {
    await ready(s.uid);
    const f = `${ROOT}/once-${tag().toLowerCase()}.txt`;
    await send(s.uid, `Use your shell to run exactly: echo ONE >> ${f} . Then use your shell to run exactly: echo TWO >> ${f} . Run them as two separate commands, one after the other.`);
    const w1 = await until(async () => {
      const w = await view(s.uid);
      return w?.status === 'waiting' && w.answerable && w;
    }, 120_000, 'the first approval');
    const answers = await Promise.all([api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'approve', prompt: w1.askId }), api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'approve' }), api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'approve' })]);
    const codes = answers.map((a) => a.status).sort();
    check(codes.filter((c) => c === 200).length === 1, `one approve: ${codes}`);
    const w2 = await until(async () => {
      const w = await view(s.uid);
      return w?.status === 'waiting' && w.answerable && w.askId !== w1.askId && w;
    }, 120_000, 'the second approval').catch(() => null);
    if (w2) {
      const stale = await api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'approve', prompt: w1.askId });
      check(stale.status === 409, `stale alert: ${stale.status} ${stale.text}`);
      await api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'deny', prompt: w2.askId });
    }
    await until(async () => idle(await view(s.uid)), 120_000, 'idle');
    const content = (() => {
      try {
        return execFileSync('cat', [f], { encoding: 'utf8' });
      } catch {
        return '';
      }
    })();
    check(content.split('\n').filter((l) => l === 'ONE').length === 1, `ONE once: ${JSON.stringify(content)}`);
    check(!content.includes('TWO'), 'the denied one never ran');
    return w2 ? `answers ${codes}; stale refused` : `answers ${codes}; it asked once`;
  } finally {
    await close(s.uid);
  }
});

sc('held: a message sent while a permission prompt is up waits; it never answers the prompt', 'da6f2938', ['gemini'], async (agent) => {
  const s = await start(agent, ASKS[agent]);
  try {
    await ready(s.uid);
    const f = `${ROOT}/held-${tag().toLowerCase()}.txt`;
    await send(s.uid, `Use your shell to run exactly: echo HELD >> ${f}`);
    const w = await until(async () => {
      const x = await view(s.uid);
      return x?.status === 'waiting' && x.answerable && x;
    }, 120_000, 'its approval');
    const t = `AFTER${tag()}`;
    const r = (await send(s.uid, `Reply with exactly the word ${t} and nothing else.`)).json;
    check(r?.outcome === 'queued' && r?.held === 'picker', `held: ${JSON.stringify(r)}`);
    await sleep(3000);
    check((await view(s.uid))?.askId === w.askId, 'the prompt untouched');
    await api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'approve', prompt: w.askId });
    await until(() => said(s.uid, t), 180_000, `${t} after the approval`);
    check((await userCount(s.uid, t)) === 1, 'once');
  } finally {
    await close(s.uid);
  }
});

sc('phone width: an approval drawn in a 49-column window still reads whole and is answerable', 'fd43884f 4e50c5f7 31ac7c69', ['gemini'], async (agent) => {
  const s = await start(agent, ASKS[agent]);
  try {
    await ready(s.uid);
    tmux('resize-window', '-t', s.id, '-x', '49', '-y', '14');
    const path = `${ROOT}/some-very-long-directory-name-with-dashes-${tag().toLowerCase()}/node_modules`;
    await send(s.uid, `Use your shell to run exactly: ls ${path}`);
    const w = await until(async () => {
      const x = await view(s.uid);
      return x?.status === 'waiting' && x.answerable && x;
    }, 120_000, 'its approval at phone width');
    check((w.ask?.text ?? '').replace(/\s+/g, '').includes(path.replace(/\s+/g, '')), `the command whole: ${JSON.stringify(w.ask?.text)}`);
    await api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'deny', prompt: w.askId });
    await until(async () => idle(await view(s.uid)), 120_000, 'idle');
  } finally {
    try {
      tmux('resize-window', '-t', s.id, '-A');
    } catch {}
    await close(s.uid);
  }
});

sc('restart: queued follow-ups survive ah restarting in the middle of Send Now, each once, in order', '35aa8c3e 7bb3d84d 44662d80 525c5c65', ['claude', 'codex'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    await send(s.uid, LONG);
    await until(async () => (await view(s.uid))?.status === 'busy', 60_000, 'busy');
    const a = `QA${tag()}`, b = `QB${tag()}`;
    const qa = (await send(s.uid, `Reply with exactly the word ${a} and nothing else.`)).json;
    const qb = (await send(s.uid, `Reply with exactly the word ${b} and nothing else.`)).json;
    check(qa?.outcome === 'queued' && qb?.outcome === 'queued', 'both queued');
    const now = api('POST', `/api/sessions/${s.uid}/queue/${qb.queueId}/send-now`).catch(() => null);
    await sleep(300);
    execFileSync(process.env.CONFORMANCE_RESTART, { encoding: 'utf8' });
    await now;
    await until(() => said(s.uid, a), 300_000, a);
    await until(() => said(s.uid, b), 300_000, b);
    await until(async () => idle(await view(s.uid)) && !(await view(s.uid)).queued, 120_000, 'idle, queue empty');
    // Each answered once. The client asks again for a Send Now the restart cut off; landing
    // just after the new ah's queue typed the one ahead, its stop ends that turn unanswered,
    // and it goes in again after the urgent one: typed twice then, never lost.
    const answers = texts(await feed(s.uid), 'assistant');
    check(answers.filter((t) => t.includes(a)).length === 1 && answers.filter((t) => t.includes(b)).length === 1, 'each answered once');
    check((await userCount(s.uid, b)) === 1 && (await userCount(s.uid, a)) <= 2, 'the urgent one typed once, the one ahead at most twice');
  } finally {
    await close(s.uid);
  }
});

sc('requeue: a queued message edited (removed, sent again, moved back) keeps its place', 'bfd40a27 1058e7ce', ['claude', 'codex'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    await send(s.uid, LONG);
    await until(async () => (await view(s.uid))?.status === 'busy', 60_000, 'busy');
    const [a, b, c] = [`RA${tag()}`, `RB${tag()}`, `RC${tag()}`];
    const ids = [];
    for (const w of [a, b, c]) ids.push((await send(s.uid, `Reply with exactly the word ${w} and nothing else.`)).json.queueId);
    await api('DELETE', `/api/sessions/${s.uid}/queue/${ids[1]}`);
    const b2 = (await send(s.uid, `Reply with exactly the word ${b}E and nothing else.`)).json.queueId;
    const mv = await api('POST', `/api/sessions/${s.uid}/queue/${b2}/move`, { to: 1 });
    check(mv.status === 200, `move ${mv.status} ${mv.text}`);
    const order = ((await api('GET', `/api/sessions/${s.uid}/queue`)).json ?? []).map((q) => q.text.match(/word (\S+) and/)?.[1]);
    check(JSON.stringify(order) === JSON.stringify([a, `${b}E`, c]), `queue order ${order}`);
    await api('POST', `/api/sessions/${s.uid}/interrupt`);
    await until(() => said(s.uid, c), 300_000, c);
    const us = texts(await feed(s.uid), 'user');
    const at = (w) => us.findIndex((t) => t.includes(`word ${w} and`));
    check(at(a) < at(`${b}E`) && at(`${b}E`) < at(c), `delivered in order: ${[at(a), at(`${b}E`), at(c)]}`);
    check(!us.some((t) => t.includes(`word ${b} and`)), 'the removed one never went');
  } finally {
    await close(s.uid);
  }
});

sc('background task: Gemini with a task still running in the background is idle, takes messages, and Send Now works', 'e7d8e514', ['gemini'], async (agent) => {
  const s = await start(agent);
  try {
    await ready(s.uid);
    const t = `STARTED${tag()}`;
    await send(s.uid, `Use your shell to start this as a background task and do not wait for it: sleep 600 . Then reply with exactly the word ${t}`);
    for (let i = 0; i < 6 && !(await said(s.uid, t)); i++) {
      const w = await view(s.uid);
      if (w?.status === 'waiting' && w.answerable) await api('POST', `/api/sessions/${s.uid}/answer`, { answer: 'approve', prompt: w.askId });
      await sleep(10_000);
    }
    await until(() => said(s.uid, t), 120_000, t);
    await until(async () => idle(await view(s.uid)), 60_000, 'idle with the task running');
    const p = `PONG${tag()}`;
    const r = (await send(s.uid, `Reply with exactly the word ${p} and nothing else.`)).json;
    check(r?.outcome === 'delivered', `delivered: ${JSON.stringify(r)}`);
    await until(() => said(s.uid, p), 120_000, p);
    await send(s.uid, LONG);
    await until(async () => (await view(s.uid))?.status === 'busy', 60_000, 'busy');
    const q = `NOW${tag()}`;
    const qr = (await send(s.uid, `Reply with exactly the word ${q} and nothing else.`)).json;
    const n = await api('POST', `/api/sessions/${s.uid}/queue/${qr.queueId}/send-now`);
    check(n.status === 200 && n.json?.code !== 'did_not_stop', `send-now ${n.status} ${n.text}`);
    await until(() => said(s.uid, q), 180_000, q);
  } finally {
    await close(s.uid);
    try {
      execFileSync('pkill', ['-x', '-f', 'sleep 600']);
    } catch {}
  }
});

sc("question dialog: at phone width, a message sent while Claude's question is up waits, the answer goes in, then the message", 'f74cdcf7 5e63ce6c fd43884f ad4346dc 3ba40c8b', ['claude'], async (agent) => {
  const s = await start(agent, { mode: 'default' });
  try {
    await ready(s.uid);
    tmux('resize-window', '-t', s.id, '-x', '49', '-y', '15');
    await send(s.uid, 'Use your AskUserQuestion tool to ask me one question, "Pick a color", with the options Red and Blue. After I answer, reply with exactly the chosen color in capitals.');
    const w = await until(async () => {
      const x = await view(s.uid);
      return x?.status === 'waiting' && x.ask?.kind === 'choice' && x;
    }, 120_000, 'the question dialog');
    const t = `QUEUED${tag()}`;
    const r = (await send(s.uid, `Reply with exactly the word ${t} and nothing else.`)).json;
    check(r?.outcome === 'queued', `held: ${JSON.stringify(r)}`);
    const q = w.ask.questions?.[0] ?? w.ask.dialog;
    const blue = (q?.options ?? []).findIndex((o) => /blue/i.test(o.label ?? o));
    check(blue >= 0, `the options read whole: ${JSON.stringify(q).slice(0, 300)}`);
    const a = await api('POST', `/api/sessions/${s.uid}/questions`, { answers: [{ picked: [blue] }] });
    check(a.status === 200, `answer ${a.status} ${a.text.slice(0, 200)}`);
    await until(() => said(s.uid, 'BLUE'), 120_000, 'BLUE');
    await until(() => said(s.uid, t), 120_000, `${t} after the answer`);
    check((await userCount(s.uid, t)) === 1, 'once');
    check(!/^Asking/.test((await view(s.uid)).detail ?? ''), 'not still asking');
  } finally {
    try {
      tmux('resize-window', '-t', s.id, '-A');
    } catch {}
    await close(s.uid);
  }
});

sc('fork refusals: an invalid fork leaves no worktree; a valid one recalls what the parent was told', '7a43829b 14a0a682 b0cacc1b 502c6e1a', ['claude', 'codex', 'muse'], async (agent) => {
  const s = await start(agent);
  let child = null;
  try {
    await ready(s.uid);
    // A plain code word: told to remember a "SECRET", Muse declines to repeat it.
    const word = `FERN${tag()}`;
    await send(s.uid, `Remember the word ${word}. Reply with exactly OK.`);
    await until(async () => idle(await view(s.uid)) && (await userCount(s.uid, word)) === 1 && (await said(s.uid, 'OK')), 120_000, 'ok');
    const before = execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    const bad = await api('POST', `/api/sessions/${s.uid}/fork`, { mode: 'invalid-mode' });
    check(bad.status === 400, `invalid: ${bad.status} ${bad.text.slice(0, 200)}`);
    check(execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }) === before, 'no worktree left behind');
    const ok = await api('POST', `/api/sessions/${s.uid}/fork`, { name: `repro fork ${agent}` });
    check(ok.status === 201, `fork ${ok.status} ${ok.text.slice(0, 200)}`);
    child = ok.json.uid;
    await ready(child, 180_000);
    await send(child, 'What word did I ask you to remember? Reply with just the word.');
    await until(() => said(child, word), 180_000, `the fork recalls ${word}`);
  } finally {
    await close(s.uid);
    if (child) await close(child);
  }
});

// ---------- run
const results = [];
const plan = S.filter((x) => !ONLY || ONLY.some((o) => x.name.startsWith(o)));
for (const x of plan) {
  const agents = x.agents.filter((a) => AGENTS.includes(a));
  console.log(`\n== ${x.name}  [${x.shas}]`);
  await Promise.all(
    agents.map(async (agent) => {
      const t0 = Date.now();
      try {
        const note = await x.fn(agent);
        results.push({ s: x.name, agent, ok: true });
        console.log(`  PASS ${agent} ${Math.round((Date.now() - t0) / 1000)}s${note ? ` (${note})` : ''}`);
        log({ scenario: x.name, agent, ok: true, note });
      } catch (e) {
        results.push({ s: x.name, agent, ok: false, error: e.message });
        console.log(`  FAIL ${agent}: ${e.message}`);
        log({ scenario: x.name, agent, ok: false, error: e.message });
      }
    }),
  );
}
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
for (const f of fails) console.log(`  FAIL ${f.s.split(':')[0]} ${f.agent}: ${f.error}`);
if (process.env.CONFORMANCE_RESULTS) writeFileSync(process.env.CONFORMANCE_RESULTS, JSON.stringify(results, null, 2));
