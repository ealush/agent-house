#!/usr/bin/env node
// A scripted stand-in for Claude Code, for walking the app's screens against a disposable
// host (scripts/demo/host.mjs). It writes a Claude Code-shaped transcript (thinking, reads,
// real edits with patches, a test run, a plan, widgets) and draws a small terminal UI.
// Each line typed into it becomes a turn: a few seconds of visible work, a real edit to a
// file in the checkout, and a reply. No model, network or secret is involved.
//
//   node agent.mjs [--scenario=onboarding|api|review|approve|none]   (default: by folder)
//
// Typing /ask (or /design, with previews) opens Claude Code's question dialog; /plan or /trust, its plan approval or
// folder-trust picker, for the app's answer-from-anywhere views. A folder holding `.demo-untrusted` opens on the
// folder-trust picker, as Claude Code does in a folder it hasn't been trusted in; trusting it removes the mark.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const args = process.argv.slice(2);
// Resumed or forked (`--continue`, `--resume <id>`): the conversation already exists.
const resumed = args.includes('--continue') || args.includes('--resume');
// The scenario follows the project, unless one is named (--scenario=…).
const named = args.find((a) => a.startsWith('--scenario='))?.split('=')[1];
const scenario = named ?? (resumed ? 'none'
  : cwd.includes('/.worktrees/') ? 'review'
  : cwd.endsWith('/orbit-web') ? 'onboarding'
  : cwd.endsWith('/orbit-api') ? 'api'
  : cwd.endsWith('/orbit-infra') ? 'approve'
  : 'none');
const id = randomUUID();
const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const file = join(dir, `${id}.jsonl`);
let n = 0;
let clock = Date.now() - 45 * 60_000;
const tick = (seconds) => {
  clock += seconds * 1000;
  return new Date(clock).toISOString();
};
const line = (type, content, extra = {}, seconds = 4) =>
  appendFileSync(file, JSON.stringify({ type, uuid: `${type}-${++n}-${id.slice(0, 8)}`, sessionId: id, cwd, timestamp: tick(seconds), message: { role: type, content }, ...extra }) + '\n');

const user = (text, seconds) => line('user', text, {}, seconds);
const say = (text, seconds) => line('assistant', [{ type: 'text', text }], {}, seconds);
const think = (text) => line('assistant', [{ type: 'thinking', thinking: text }], {}, 3);
const widget = (w) => '```ah-widget\n' + JSON.stringify(w) + '\n```';
let calls = 0;
const tool = (name, input, result, data = {}, isError = false) => {
  const call = `toolu_${id.slice(0, 6)}_${++calls}`;
  line('assistant', [{ type: 'tool_use', id: call, name, input }], {}, 2);
  line('user', [{ type: 'tool_result', tool_use_id: call, content: result, is_error: isError }], { toolUseResult: data }, 3);
};

const read = (path) => {
  const text = existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), 'utf8') : '';
  tool('Read', { file_path: join(cwd, path) }, text.split('\n').map((l, i) => `${String(i + 1).padStart(5)}→${l}`).join('\n'), { type: 'text', file: { filePath: join(cwd, path), numLines: text.split('\n').length } });
};

/** Replaces `from` with `to` in a real file and records the edit with its patch. */
const edit = (path, from, to) => {
  const full = join(cwd, path);
  const before = existsSync(full) ? readFileSync(full, 'utf8') : '';
  if (!before.includes(from)) return;
  const after = before.replace(from, to);
  writeFileSync(full, after);
  const startLine = before.slice(0, before.indexOf(from)).split('\n').length;
  const oldLines = from.split('\n');
  const newLines = to.split('\n');
  const patch = [{ oldStart: startLine, oldLines: oldLines.length, newStart: startLine, newLines: newLines.length, lines: [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)] }];
  tool('Edit', { file_path: full, old_string: from, new_string: to }, `The file ${full} has been updated.`, { filePath: full, oldString: from, newString: to, structuredPatch: patch, userModified: false, replaceAll: false });
};

const write = (path, text) => {
  const full = join(cwd, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  tool('Write', { file_path: full, content: text }, `File created successfully at: ${full}`, { type: 'create', filePath: full });
};

const bash = (command, description, output, isError = false) => tool('Bash', { command, description }, output, { stdout: output, stderr: '', interrupted: false }, isError);
const todo = (todos) => tool('TodoWrite', { todos }, 'Todos have been modified successfully.', { newTodos: todos });

// ---------- history, written once at start

function onboarding() {
  user('The onboarding flow drops people on an empty dashboard. Add a three-step welcome (name your workspace, invite a teammate, connect a repo) and remember where they stopped.', 0);
  think('The dashboard route renders immediately after sign-up. I need a Welcome component with three steps, a persisted step index, and a guard in the router. Let me read the router and the dashboard first.');
  say('I\'ll look at how sign-up hands off to the dashboard, then add the welcome flow in front of it.');
  read('src/router.ts');
  read('src/pages/Dashboard.ts');
  todo([
    { content: 'Add a Welcome page with three steps', status: 'completed', activeForm: 'Adding the Welcome page' },
    { content: 'Persist the current step per workspace', status: 'completed', activeForm: 'Persisting the step' },
    { content: 'Route new workspaces to /welcome', status: 'in_progress', activeForm: 'Routing new workspaces' },
    { content: 'Cover the flow with tests', status: 'pending', activeForm: 'Writing tests' },
  ]);
  write('src/pages/Welcome.ts', `import { steps, saveStep, loadStep } from '../onboarding';

export function Welcome(workspace: string) {
  const at = loadStep(workspace);
  const step = steps[at];
  return \`<section class="welcome">
    <p class="eyebrow">Step \${at + 1} of \${steps.length}</p>
    <h1>\${step.title}</h1>
    <p>\${step.body}</p>
    <button data-next>\${at === steps.length - 1 ? 'Finish' : 'Continue'}</button>
  </section>\`;
}
`);
  edit('src/router.ts', "  '/': Dashboard,", "  '/': (ws) => (isNew(ws) ? Welcome(ws) : Dashboard(ws)),\n  '/welcome': Welcome,");
  bash('npm test -- onboarding', 'Run the onboarding tests', ` RUN  v3.2.4 ${cwd}

 ✓ src/onboarding.test.ts (6 tests) 41ms
   ✓ starts new workspaces at step one
   ✓ remembers the step after a reload
   ✓ skips the flow for existing workspaces
   ✓ finishing lands on the dashboard
   ✓ invite step accepts several emails
   ✓ connect step lists GitHub and GitLab

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  612ms`);
  say(`New workspaces now open on a three-step welcome instead of the empty dashboard, and the step survives reloads.

- **\`src/pages/Welcome.ts\`**: the flow, one step at a time
- **\`src/router.ts\`**: new workspaces route to \`/welcome\`
- Tests: 6 passed

${widget({ type: 'checklist', title: 'Onboarding', items: [{ text: 'Name your workspace', done: true }, { text: 'Invite a teammate', done: true }, { text: 'Connect a repository', done: 'in_progress' }] })}

${widget({ type: 'choices', prompt: 'Want me to add analytics for where people drop off?', options: [{ label: 'Yes, add drop-off events', reply: 'Add drop-off analytics events for each step' }, 'Not now'] })}`, 6);
}

function api() {
  user('p95 latency on GET /users doubled after yesterday\'s deploy. Find out why.', 0);
  think('Likely an N+1 introduced with the teams join. Check the route and the query log.');
  read('src/routes/users.ts');
  bash('npm run bench -- users', 'Benchmark the users route', `users.list   p50 38ms   p95 412ms   (was p95 190ms)
queries per request: 26 (was 2)`);
  say(`The list now loads each user's teams one query at a time: **26 queries per request** instead of 2.

${widget({ type: 'stats', title: 'GET /users', items: [{ label: 'p95', value: '412 ms', delta: '+117%', tone: 'danger' }, { label: 'Queries', value: '26', delta: '+24', tone: 'danger' }, { label: 'p50', value: '38 ms', delta: '+4%' }] })}

${widget({ type: 'bar-chart', title: 'p95 by release (ms)', unit: 'ms', data: [{ label: '1.41', value: 182 }, { label: '1.42', value: 190 }, { label: '1.43', value: 412 }] })}`, 8);
  user('Fix it with a single join.', 40);
  edit('src/routes/users.ts', '  for (const u of users) u.teams = await db.teams.forUser(u.id);', '  const teams = await db.teams.forUsers(users.map((u) => u.id));\n  for (const u of users) u.teams = teams.get(u.id) ?? [];');
  bash('npm run bench -- users', 'Benchmark again', `users.list   p50 31ms   p95 176ms
queries per request: 2`);
  say('Back to two queries and **p95 176 ms**, below where it was before the deploy.', 5);
}

function review() {
  user('Review the payments refactor on this branch before I open the PR.', 0);
  bash('git log --oneline main..HEAD', 'Commits on this branch', 'a1c9e02 Move refunds behind the ledger\n7f3d2b1 Extract Ledger from Payments');
  say(`Two findings worth fixing first:

${widget({ type: 'table', title: 'Findings', columns: ['Severity', 'File', 'Finding'], rows: [['High', 'ledger.ts:88', 'Refund is recorded before the provider confirms it'], ['Low', 'payments.ts:12', 'Unused import of Currency']] })}

${widget({ type: 'card', title: 'Ready after one fix', body: 'Record the refund in the provider callback instead, and this is good to go.', tone: 'warning', actions: [{ label: 'Fix it', reply: 'Move the refund record into the provider callback' }] })}`, 9);
}

/** Waits on a permission prompt, the way Claude Code draws one, until Enter or Esc. */
let pending = null;
function approve() {
  user('Rotate the API signing keys; the current ones are 94 days old.', 0);
  think('There is a rotation script in keys/. Running it revokes keys older than 90 days, which is what was asked; it needs approval.');
  say('The rotation script creates new signing keys and revokes anything older than 90 days. I need to run it:', 4);
  const call = `toolu_${id.slice(0, 6)}_${++calls}`;
  line('assistant', [{ type: 'tool_use', id: call, name: 'Bash', input: { command: './keys/rotate.sh', description: 'Rotate the API signing keys' } }], {}, 2);
  pending = call;
}

({ onboarding, api, review, approve })[scenario]?.();

const promptLines = () => [
  '',
  ' Bash command',
  '',
  '   ./keys/rotate.sh',
  '   Rotate the API signing keys',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for ./keys commands",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
];

// ---------- the terminal, and new turns

const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const accent = (s) => `\x1b[38;5;209m${s}\x1b[39m`;
const box = () => {
  const w = Math.max(40, Math.min(process.stdout.columns || 80, 100));
  process.stdout.write(`\n${dim('╭' + '─'.repeat(w - 2) + '╮')}\n${dim('│')} > ${' '.repeat(w - 5)}${dim('│')}\n${dim('╰' + '─'.repeat(w - 2) + '╯')}\n${dim('  ? for shortcuts')}\n`);
};
process.stdout.write(`${accent('✻')} Welcome to the demo agent\n\n${dim(`  cwd: ${cwd}`)}\n${dim(`  scenario: ${scenario}`)}\n`);
if (pending) process.stdout.write(promptLines().join('\n') + '\n');
else box();

let busy = false;
const queue = [];
let typed = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);

/** The turn in progress, so Esc can stop it as Claude Code does. */
let current = null;
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * A turn takes a while and shows its work as it goes, like a real agent: thinking, a
 * read, an edit, then the reply, a few seconds apart (7–10 s in all), so the app's working
 * state, queue and steering have something to act on. Esc stops it where it is.
 */
async function turn(prompt) {
  busy = true;
  // Live turns carry real times (the seeded history is backdated).
  clock = Math.max(clock, Date.now());
  const abort = new AbortController();
  current = abort;
  // Like Claude Code, a new conversation's transcript appears a moment after its first prompt.
  if (n === 0) await sleep(4000, abort.signal);
  user(prompt, 20);
  process.stdout.write(`\n${accent('>')} ${prompt}\n\n`);
  const frames = ['·', '✢', '✳', '✶', '✻', '✽'];
  const started = Date.now();
  const spinner = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    process.stdout.write(`\r${accent(frames[Math.floor((Date.now() - started) / 120) % frames.length])} Working… ${dim(`(${s}s · esc to interrupt)`)}`);
  }, 120);
  const notes = join(cwd, 'NOTES.md');
  const pause = (base) => sleep(base + Math.random() * 800, abort.signal);
  const steps = [
    async () => { await pause(1800); think(`The request: "${prompt}". Find where it belongs, make the smallest change that does it, and say what changed.`); },
    async () => { await pause(2200); read(existsSync(notes) ? 'NOTES.md' : 'README.md'); },
    async () => {
      await pause(2400);
      const before = existsSync(notes) ? readFileSync(notes, 'utf8') : '# Notes\n';
      writeFileSync(notes, `${before}\n- ${prompt}\n`);
      tool('Edit', { file_path: notes, old_string: before.trimEnd(), new_string: `${before.trimEnd()}\n\n- ${prompt}` }, `The file ${notes} has been updated.`, { filePath: notes, structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: before.split('\n').length, newLines: 1, lines: [`+- ${prompt}`] }] });
    },
    async () => {
      await pause(1600 + Math.min(prompt.length * 20, 1500));
      say(`Done: noted **${prompt}** in \`${relative(cwd, notes)}\`.\n\n${widget({ type: 'choices', prompt: 'Next?', options: [{ label: 'Keep going', reply: 'Keep going' }, 'Stop here'] })}`, 2);
    },
  ];
  for (const step of steps) {
    if (abort.signal.aborted) break;
    await step();
  }
  clearInterval(spinner);
  process.stdout.write('\r\x1b[2K');
  if (abort.signal.aborted) {
    line('user', '[Request interrupted by user]', {}, 1);
    process.stdout.write(`${dim('  ⎿  Interrupted · What should I do instead?')}\n`);
  } else {
    process.stdout.write(`${accent('⏺')} Done: noted it in NOTES.md.\n`);
  }
  current = null;
  box();
  busy = false;
  if (queue.length) turn(queue.shift());
}

/** The permission prompt's answer: run it (1, 2 or Enter) or not (3 or Esc). */
function answer(yes) {
  clock = Math.max(clock, Date.now());
  const call = pending;
  pending = null;
  process.stdout.write('\x1b[2J\x1b[H');
  if (yes) {
    const out = 'created signing key k_2026_10_25 (ed25519)\nrevoked 2 keys older than 90 days: k_2026_07_12, k_2026_06_30';
    line('user', [{ type: 'tool_result', tool_use_id: call, content: out, is_error: false }], { toolUseResult: { stdout: out, stderr: '', interrupted: false } }, 6);
    say(`Rotated. The new signing key is **k_2026_10_25**; two old keys are revoked.\n\n${widget({ type: 'table', title: 'Signing keys', columns: ['Key', 'State', 'Age'], rows: [['k_2026_10_25', 'active', 'today'], ['k_2026_07_12', 'revoked', '105 days'], ['k_2026_06_30', 'revoked', '117 days']] })}`, 3);
    process.stdout.write(`${accent('⏺')} Rotated: k_2026_10_25 is active, 2 old keys revoked.\n`);
  } else {
    line('user', [{ type: 'tool_result', tool_use_id: call, content: 'The user doesn\'t want to proceed with this tool use.', is_error: true }], {}, 3);
    line('user', '[Request interrupted by user for tool use]', {}, 1);
    process.stdout.write(`${dim('  ⎿  Declined. Tell me what to do instead.')}\n`);
  }
  box();
}

// ---------- Claude Code's own pickers, opened by typing /ask, /plan or /trust
//
// Drawn as Claude Code draws them (ah's test/fixtures/picker.js is the reference), so ah
// reads them off the screen the same way, and they take the same keys: digits, arrows,
// Tab, Enter, Esc. Answering writes what Claude writes once it's answered.

const QUESTIONS = [
  {
    header: 'Storage', question: 'Where should sign-in sessions be stored?', multiSelect: false,
    options: [
      { label: 'Postgres', description: 'The main database; sessions survive deploys' },
      { label: 'Redis', description: 'Fastest; lost on restart unless persisted' },
      { label: 'Signed cookies', description: 'Nothing stored server-side; can’t revoke one' },
    ],
  },
  {
    header: 'Events', question: 'Which events should the audit log keep?', multiSelect: true,
    options: [
      { label: 'Sign-ins', description: 'Every successful and failed sign-in' },
      { label: 'Role changes', description: 'Who granted what, and when' },
      { label: 'Exports', description: 'Downloads of workspace data' },
    ],
  },
];
// `/design`: a question whose options carry previews, as Claude Code 2.1.300 draws it (the
// highlighted option's preview boxed beside the options, notes, no free-text row), then a
// plain multi-choice one.
const DESIGN = [
  {
    header: 'Layout', question: 'Which layout for the settings page?', multiSelect: false,
    options: [
      { label: 'Stacked', description: 'Sections one above the other', preview: '+----------------+\n| Profile        |\n+----------------+\n| Security       |\n+----------------+' },
      { label: 'Sidebar', description: 'A list of sections beside the page', preview: '+-------+--------+\n| Prof. | Name   |\n| Sec.  | Email  |\n| Notif.| Avatar |\n+-------+--------+' },
      { label: 'Tabs', description: 'One section at a time', preview: '[Profile][Security]\n+----------------+\n| Name           |\n| Email          |\n+----------------+' },
    ],
  },
  {
    header: 'Extras', question: 'Which extras should it have?', multiSelect: true,
    options: [
      { label: 'Dark mode', description: 'A dark color theme toggle' },
      { label: 'Search', description: 'Find a setting by name' },
      { label: 'Keyboard shortcuts', description: 'Jump between sections with keys' },
    ],
  },
];
const PLAN = `## Move sessions to Postgres

1. Add a \`sessions\` table (id, user, created, expires, revoked)
2. Read and write sessions through \`SessionStore\` instead of memory
3. Revoke on sign-out and on password change
4. Backfill nothing: existing sessions expire on their own within a day`;

/**
 * ah's Claude Code hook (bin/ah-hook.js), called the way Claude Code calls it: `/design` records
 * its questions at PreToolUse, as a real session with ah's hooks does, so the app gets every
 * option's preview, not just the one on screen. SessionEnd hands the window back to reading
 * the screen afterwards. (`/ask` stays hookless: the dialog read off the screen.)
 */
function hook(event, extra = {}) {
  if (!process.env.AH_DEMO_HOOK) return;
  spawnSync(process.execPath, [process.env.AH_DEMO_HOOK, 'claude'], { input: JSON.stringify({ session_id: id, hook_event_name: event, ...extra }) });
}

/** The picker on screen: null, or what it is and where its cursor and answers are. */
let picker = null;
const CHAT = '────────────────────────────────────────';

function pickerLines() {
  const p = picker;
  if (p.qs) {
    const QUESTIONS = p.qs;
    const tab = (i) => `${i < p.q ? '☒' : '☐'} ${QUESTIONS[i].header}`;
    const bar = `←  ${QUESTIONS.map((_, i) => tab(i)).join('  ')}  ✔ Submit  →`;
    if (p.q < QUESTIONS.length) {
      const q = QUESTIONS[p.q];
      const n = q.options.length;
      const mark = (i) => (p.cursor === i ? '❯' : ' ');
      if (q.options.some((o) => o.preview)) {
        // The highlighted option's preview, boxed to the right of the options.
        const shown = q.options[Math.min(p.cursor, n) - 1].preview.split('\n');
        const width = 42;
        const box = [`┌${'─'.repeat(width)}┐`, ...shown.map((l) => `│ ${l.padEnd(width - 2)} │`), `└${'─'.repeat(width)}┘`, `Notes: ${p.typing ? `${p.notes}▏` : p.notes || 'press n to add notes'}`];
        const left = q.options.map((o, i) => `${mark(i + 1)} ${i + 1}. ${o.label}`);
        const rows = Array.from({ length: Math.max(left.length, box.length) }, (_, i) => `${(left[i] ?? '').padEnd(34)}${box[i] ?? ''}`.trimEnd());
        return [bar, '', q.question, '', ...rows, CHAT, `${mark(n + 1)} Chat about this`, '', 'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel'];
      }
      const rows = q.options.flatMap((o, i) => [
        `${mark(i + 1)} ${i + 1}. ${q.multiSelect ? `[${p.picked.has(i) ? '✔' : ' '}] ` : ''}${o.label}`,
        `     ${o.description}`,
      ]);
      const other = q.multiSelect ? `[${p.other ? '✔' : ' '}] ${p.other || 'Type something'}` : p.typing ? p.other : 'Type something.';
      const chatRow = q.multiSelect ? n + 3 : n + 2;
      return [bar, '', q.question, '', ...rows, `${mark(n + 1)} ${n + 1}. ${other}`, ...(q.multiSelect ? [`${mark(n + 2)}    Submit`] : []), CHAT, `${mark(chatRow)} ${n + 2}. Chat about this`, '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'];
    }
    return [bar, '', 'Review your answers', '', ...QUESTIONS.flatMap((q, i) => [` ● ${q.question}`, `   → ${p.answers[i]}`, ...(p.notes_[i] ? [`     Notes: ${p.notes_[i]}`] : [])]), '', 'Ready to submit your answers?', '', `${p.cursor === 1 ? '❯' : ' '} 1. Submit answers`, `${p.cursor === 2 ? '❯' : ' '} 2. Cancel`];
  }
  if (p.kind === 'plan') {
    const rows = ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning'];
    return ['', ' Ready to code?', '', ' Here is Claude’s plan:', ` ╭${'─'.repeat(60)}╮`, ...PLAN.split('\n').map((l) => ` │ ${l}`), ` ╰${'─'.repeat(60)}╯`, '', ' Would you like to proceed?', '', ...rows.map((r, i) => ` ${p.cursor === i + 1 ? '❯' : ' '} ${i + 1}. ${r}`), ''];
  }
  const rows = ['Yes, I trust this folder', 'No, exit'];
  return ['', ` Do you trust the files in this folder?`, '', `   ${cwd}`, '', ' Claude Code may read, write or run files here.', '', ...rows.map((r, i) => ` ${p.cursor === i + 1 ? '❯' : ' '} ${r}`), '', ' Enter to confirm · Esc to cancel', ''];
}

const drawPicker = () => process.stdout.write(`\x1b[2J\x1b[H${pickerLines().join('\r\n')}\r\n`);

function openPicker(kind) {
  picker = { kind, q: 0, cursor: 1, picked: new Set(), other: '', typing: false, notes: '', answers: [], notes_: [], qs: kind === 'ask' ? QUESTIONS : kind === 'design' ? DESIGN : null };
  clock = Math.max(clock, Date.now());
  if (kind === 'design') {
    user('Redesign the settings page. Ask me about the layout first.', 1);
    say('Two choices first; the layout ones come with a sketch.', 3);
    hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: DESIGN } });
  } else if (kind === 'ask') {
    user('Add an audit log for sign-ins, and move sessions out of memory while you’re at it.', 1);
    say('Two decisions first, then I’ll write it.', 3);
  } else if (kind === 'plan') {
    user('Plan the move of sign-in sessions to Postgres before changing anything.', 1);
    think('Plan mode: read the session code, write a plan, and ask before editing.');
    read('README.md');
    // Like any tool that asks first, the call is in the transcript while it waits.
    picker.call = `toolu_${id.slice(0, 6)}_${++calls}`;
    line('assistant', [{ type: 'tool_use', id: picker.call, name: 'ExitPlanMode', input: { plan: PLAN } }], {}, 2);
  }
  drawPicker();
}

/** Closes the picker, says what happened in the transcript, and goes back to the prompt box. */
function closePicker(outcome) {
  const p = picker;
  picker = null;
  clock = Math.max(clock, Date.now());
  if (p.kind === 'design') hook('SessionEnd');
  process.stdout.write('\x1b[2J\x1b[H');
  if (p.qs) {
    const QUESTIONS = p.qs;
    const call = `toolu_${id.slice(0, 6)}_${++calls}`;
    line('assistant', [{ type: 'tool_use', id: call, name: 'AskUserQuestion', input: { questions: QUESTIONS } }], {}, 1);
    if (outcome === 'submitted') {
      const answers = Object.fromEntries(QUESTIONS.map((q, i) => [q.question, p.answers[i]]));
      const annotations = Object.fromEntries(QUESTIONS.flatMap((q, i) => (p.notes_[i] ? [[q.question, { notes: p.notes_[i] }]] : [])));
      const text = `User has answered your questions: ${QUESTIONS.map((q, i) => `"${q.question}"="${p.answers[i]}"${p.notes_[i] ? ` user notes: ${p.notes_[i]}` : ''}`).join(', ')}. You can now continue with the user's answers in mind.`;
      line('user', [{ type: 'tool_result', tool_use_id: call, content: text }], { toolUseResult: { questions: QUESTIONS, answers, annotations } }, 2);
      if (p.kind === 'design') {
        say(`A **${p.answers[0]}** layout${p.notes_[0] ? ` (noted: “${p.notes_[0]}”)` : ''}, with ${p.answers[1]}. Sketching it now.`, 3);
        process.stdout.write(`${accent('⏺')} Layout: ${p.answers[0]}${p.notes_[0] ? ` (notes: ${p.notes_[0]})` : ''} · Extras: ${p.answers[1]}\n`);
      } else {
        say(`Going with **${p.answers[0]}** for sessions, and the audit log keeps **${p.answers[1]}**. I’ll start with the sessions table.`, 3);
        process.stdout.write(`${accent('⏺')} Sessions: ${p.answers[0]} · Audit: ${p.answers[1]}\n`);
      }
    } else if (outcome === 'chat') {
      line('user', [{ type: 'tool_result', tool_use_id: call, content: 'User declined to answer questions', is_error: true }], {}, 2);
      say('Sure, let’s talk it through. What would you change about these choices?', 3);
      process.stdout.write(`${dim('  ⎿  You chose to chat about it.')}\n`);
    } else {
      line('user', [{ type: 'tool_result', tool_use_id: call, content: 'User declined to answer questions', is_error: true }], {}, 2);
      process.stdout.write(`${dim('  ⎿  You declined to answer.')}\n`);
    }
  } else if (p.kind === 'plan') {
    const call = p.call;
    if (outcome === 1 || outcome === 2) {
      line('user', [{ type: 'tool_result', tool_use_id: call, content: 'User has approved your plan. You can now start coding.' }], { toolUseResult: { plan: PLAN } }, 2);
      say(outcome === 1 ? 'Plan approved; edits will go through without asking. Starting with the table.' : 'Plan approved; I’ll ask before each edit. Starting with the table.', 3);
      process.stdout.write(`${accent('⏺')} Plan approved.\n`);
    } else {
      line('user', [{ type: 'tool_result', tool_use_id: call, content: "The user doesn't want to proceed with this tool use. The tool use was rejected.", is_error: true }], {}, 2);
      process.stdout.write(`${dim('  ⎿  Still planning. Tell me what to change.')}\n`);
    }
  } else {
    if (outcome === 1) rmSync(join(cwd, '.demo-untrusted'), { force: true });
    process.stdout.write(outcome === 1 ? `${accent('⏺')} Trusted ${cwd}.\n` : `${dim('  ⎿  Not trusted; nothing here will run.')}\n`);
  }
  box();
}

/** One key into the picker on screen, the way Claude Code takes it. */
function pickerKey(s) {
  const p = picker;
  const up = s === '\x1b[A' || s === '\x1bOA';
  const down = s === '\x1b[B' || s === '\x1bOB' || s === '\t';
  if (s === '\x1b') return closePicker('cancelled');
  if (p.kind === 'trust' || p.kind === 'plan') {
    const n = p.kind === 'plan' ? 3 : 2;
    if (up) p.cursor = Math.max(1, p.cursor - 1);
    else if (down) p.cursor = Math.min(n, p.cursor + 1);
    else if (s === '\r') return closePicker(p.cursor);
    else if (p.kind === 'plan' && /^[1-3]$/.test(s)) return closePicker(Number(s));
    return drawPicker();
  }
  const QUESTIONS = p.qs;
  if (p.q === QUESTIONS.length) {
    if (up || down) p.cursor = up ? 1 : 2;
    else if (s === '1' || (s === '\r' && p.cursor === 1)) return closePicker('submitted');
    else if (s === '2' || (s === '\r' && p.cursor === 2)) return closePicker('cancelled');
    return drawPicker();
  }
  const q = QUESTIONS[p.q];
  const n = q.options.length;
  const next = (answer) => {
    p.answers[p.q] = answer;
    p.notes_[p.q] = p.notes.trim();
    p.q += 1;
    p.cursor = 1;
    p.picked = new Set();
    p.other = '';
    p.notes = '';
    p.typing = false;
    // One single-choice question has no review: its answer is final.
    if (QUESTIONS.length === 1 && !q.multiSelect) return closePicker('submitted');
  };
  if (q.options.some((o) => o.preview)) {
    // Digits only move the cursor; Enter picks. n opens notes; Enter keeps them and picks.
    if (p.typing && s === '\r') next(q.options[p.cursor - 1].label);
    else if (p.typing && s === '\x7f') p.notes = p.notes.slice(0, -1);
    else if (p.typing && /^[ -~]$/.test(s)) p.notes += s;
    else if (up) p.cursor = Math.max(1, p.cursor - 1);
    else if (down) p.cursor = Math.min(n + 1, p.cursor + 1);
    else if (new RegExp(`^[1-${n}]$`).test(s)) p.cursor = Number(s);
    else if (s === 'n' && p.cursor <= n) p.typing = true;
    else if (s === '\r' && p.cursor === n + 1) return closePicker('chat');
    else if (s === '\r') next(q.options[p.cursor - 1].label);
    return drawPicker();
  }
  if (!q.multiSelect) {
    if (p.typing && s === '\r') next(p.other.trim() || 'No answer');
    else if (p.typing && s === '\x7f') p.other = p.other.slice(0, -1);
    else if (p.typing && !up && !down) p.other += s;
    else if (up) p.cursor = Math.max(1, p.cursor - 1);
    else if (down) p.cursor = Math.min(n + 2, p.cursor + 1);
    else if (s === String(n + 2) || (s === '\r' && p.cursor === n + 2)) return closePicker('chat');
    else if (new RegExp(`^[1-${n}]$`).test(s)) next(q.options[Number(s) - 1].label);
    else if (s === String(n + 1) || (s === '\r' && p.cursor === n + 1)) {
      p.typing = true;
      p.cursor = n + 1;
    } else if (s === '\r') next(q.options[p.cursor - 1].label);
    return drawPicker();
  }
  const done = () => next([...[...p.picked].sort().map((i) => q.options[i].label), p.other.trim()].filter(Boolean).join(', ') || 'Nothing');
  if (new RegExp(`^[1-${n}]$`).test(s) && p.cursor !== n + 1) {
    const i = Number(s) - 1;
    if (p.picked.has(i)) p.picked.delete(i);
    else p.picked.add(i);
  } else if (up) p.cursor = Math.max(1, p.cursor - 1);
  else if (down) p.cursor = Math.min(n + 3, p.cursor + 1);
  else if (s === '\r' && p.cursor === n + 3) return closePicker('chat');
  else if (s === '\x1b[C' || s === '\x1bOC' || (s === '\r' && p.cursor >= n + 1)) done();
  else if (s === '\r' && p.cursor <= n) {
    const i = p.cursor - 1;
    if (p.picked.has(i)) p.picked.delete(i);
    else p.picked.add(i);
  } else if (p.cursor === n + 1 && s === '\x7f') p.other = p.other.slice(0, -1);
  else if (p.cursor === n + 1 && /^[ -~]$/.test(s)) p.other += s;
  drawPicker();
}

process.stdin.on('data', (chunk) => {
  if (picker) {
    // One send-keys can carry several keys ("Down Down Down"): take them one at a time.
    for (const s of chunk.toString().match(/\x1b\[[A-D]|\x1bO[A-D]|[\s\S]/g) ?? []) if (picker) pickerKey(s);
    return;
  }
  for (const char of chunk.toString()) {
    if (pending) {
      if (char === '\r' || char === '\n' || char === '1' || char === '2') answer(true);
      else if (char === '\x1b' || char === '3') answer(false);
      continue;
    }
    if (char === '\x1b') {
      current?.abort();
      continue;
    }
    if (char === '\x03') process.exit(0);
    if (char === '\x7f') {
      typed = typed.slice(0, -1);
      continue;
    }
    if (char !== '\r' && char !== '\n') {
      typed += char;
      continue;
    }
    const prompt = typed.trim();
    typed = '';
    if (!prompt) continue;
    const opens = { '/ask': 'ask', '/design': 'design', '/plan': 'plan', '/trust': 'trust' }[prompt];
    if (opens && !busy) {
      openPicker(opens);
      return;
    }
    if (busy) queue.push(prompt);
    else turn(prompt);
  }
});

// Last, once the picker's state exists: a folder not yet trusted asks before anything else.
if (!resumed && existsSync(join(cwd, '.demo-untrusted'))) openPicker('trust');
