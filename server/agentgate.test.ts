import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackFor, compileGates, pickerAtBottom, readGate, readLinks } from './agentgate.ts';

// Screens captured from Codex 0.162.1 signed out, at 90 columns and at 49 (a phone
// attached to the window), blank lines dropped as screenTail does.
const lines = (s: string) => s.split('\n').filter((l) => l.trim());
const none = { rules: [] };

const CODEX_SIGNIN = lines(`
                      ⠉⠉⠛⠋⢻⣿⣿⣿⣿⣶⣶⣾⣿⣿⣿⠟⠁
                           ⠈⠙⠻⠿⠿⠿⠿⠿⠛⠁
  Welcome to Codex, OpenAI's command-line coding agent
  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing
> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans
  2. Sign in with Device Code
     Sign in from another device with a one-time code
  3. Provide your own API key
     Pay for what you use
  Press enter to continue`);

const CODEX_SIGNIN_NARROW = lines(`
  Welcome to Codex, OpenAI's command-line coding
agent
  Sign in with ChatGPT to use Codex as part of
your paid plan
  or connect an API key for usage-based billing
> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and
Enterprise plans
  2. Sign in with Device Code
     Sign in from another device with a one-time
code
  3. Provide your own API key
     Pay for what you use
  Press enter to continue
Login timed out`);

const CODEX_BROWSER_NARROW = lines(`
  Welcome to Codex, OpenAI's command-line coding
agent
  Finish signing in via your browser
  If the link doesn't open automatically, press c
to copy it:
  https://auth.openai.com/oauth/authorize?respons
e_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hran
n&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fau
th%2Fcallback&code_challenge=8Ka5qAoLbl3zgtpFbYX8
oXPIQXUPkrRoXPtmOFnRDaU&code_challenge_method=S25
6&state=nRVcFgFJpQJz0jfLKAxonc1zwpXDhOBopAxVmTQxf
O4&scope=openid+profile+email+offline_access+api.
connectors.read+api.connectors.invoke&id_token_ad
d_organizations=true&codex_cli_simplified_flow=tr
ue&originator=codex-tui
  On a remote or headless machine? Press esc and
choose Sign in with Device Code.
  Press esc to cancel`);

const CODEX_DEVICE = lines(`
  Welcome to Codex, OpenAI's command-line coding agent
  Finish signing in via your browser
  1. Open this link in your browser and sign in
  https://auth.openai.com/codex/device
  2. Enter this one-time code after you are signed in (expires in 15 minutes)
  JUC6-GKWC4
  Continue only if you started this login in Codex. If a website or another person gave
you this code, cancel.
  Press esc to cancel`);

const CODEX_API_KEY = lines(`
                            ⠈⠙⠛⠿⠿⠿⠿⠛⠉
  Welcome to Codex, OpenAI's command-line coding agent
> Use your own OpenAI API key for usage-based billing
  Paste or type your API key below.
╭API key─────────────────────────────────────────────────────────────────────────────────╮
│Paste or type your API key                                                              │
╰────────────────────────────────────────────────────────────────────────────────────────╯
  Press enter to save
  Press esc to go back`);

const SIGNIN_ROWS = [
  { key: '1', label: 'Sign in with ChatGPT', description: 'Usage included with Plus, Pro, Business, and Enterprise plans' },
  { key: '2', label: 'Sign in with Device Code', description: 'Sign in from another device with a one-time code' },
  { key: '3', label: 'Provide your own API key', description: 'Pay for what you use' },
];

test("any agent's sign-in picker is a gate, with its rows and what they're about", () => {
  const g = readGate(CODEX_SIGNIN, none)!;
  assert.equal(g.gate.kind, 'signin');
  assert.deepEqual(g.options, SIGNIN_ROWS);
  assert.equal(g.text, "Welcome to Codex, OpenAI's command-line coding agent\nSign in with ChatGPT to use Codex as part of your paid plan\nor connect an API key for usage-based billing", 'no logo');
});

test('a phone-width window wraps rows to the first column, and the picker still reads', () => {
  const g = readGate(CODEX_SIGNIN_NARROW, none)!;
  assert.equal(g.gate.kind, 'signin');
  assert.deepEqual(g.options, SIGNIN_ROWS);
});

test('a browser sign-in gives the whole link, says it returns to this host, and offers Esc', () => {
  const g = readGate(CODEX_BROWSER_NARROW, none)!;
  assert.equal(g.gate.kind, 'signin');
  assert.deepEqual(g.gate.links, [
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=8Ka5qAoLbl3zgtpFbYX8oXPIQXUPkrRoXPtmOFnRDaU&code_challenge_method=S256&state=nRVcFgFJpQJz0jfLKAxonc1zwpXDhOBopAxVmTQxfO4&scope=openid+profile+email+offline_access+api.connectors.read+api.connectors.invoke&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex-tui',
  ]);
  assert.equal(g.gate.local, true);
  assert.equal(g.gate.callback, 'http://127.0.0.1:1455/auth/callback');
  assert.equal(g.gate.back, true);
  // A short window (a phone's, 21 rows) cuts "Press esc to cancel": "Press esc and choose
  // Sign in with Device Code" still says Esc goes back.
  assert.equal(readGate(CODEX_BROWSER_NARROW.slice(0, -1), none)?.gate.back, true);
  assert.equal(g.gate.code, undefined);
  assert.equal(g.options, undefined);
  assert.ok(g.text.split('\n').some((l) => l.trim().startsWith('https://auth.openai.com/oauth/authorize?response_type=code&') && l.endsWith('originator=codex-tui')), 'the link is one line of the text');
});

test('a device-code sign-in gives the link and the code', () => {
  const g = readGate(CODEX_DEVICE, none)!;
  assert.deepEqual(g.gate, { kind: 'signin', links: ['https://auth.openai.com/codex/device'], code: 'JUC6-GKWC4', back: true });
});

test('a code of letters alone, on its own line, is still the code', () => {
  // The real Codex handed out "JVSW-GRZKI" on another run.
  const g = readGate(CODEX_DEVICE.map((l) => l.replace('JUC6-GKWC4', 'JVSW-GRZKI')), none)!;
  assert.equal(g.gate.code, 'JVSW-GRZKI');
  assert.equal(readGate(CODEX_DEVICE.map((l) => l.replace('JUC6-GKWC4', 'NO-OP')), none)!.gate.code, undefined, 'short words are not a code');
  assert.equal(readGate([...CODEX_DEVICE.slice(0, -1), '  Open it READ-ONLY first', CODEX_DEVICE.at(-1)!].filter((l) => !l.includes('JUC6')), none)!.gate.code, undefined, 'nor letters inside a sentence');
});

test('a box for an API key is a gate that takes typed text', () => {
  const g = readGate(CODEX_API_KEY, none)!;
  assert.deepEqual(g.gate, { kind: 'signin', input: 'Paste or type your API key below.', back: true });
  assert.equal(g.text, 'Use your own OpenAI API key for usage-based billing\nPaste or type your API key below.\nPress enter to save\nPress esc to go back', 'from its heading on: no logo, cursor or input field');
});

test("an agent's reply about signing in, link and code included, is not a gate", () => {
  const reply = lines(`
• To sign in to the GitHub CLI, run gh auth login, open
  https://github.com/login/device and enter code ABCD-1234.
  Then press Enter to continue in that terminal.
› Ask Codex to do anything
  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit`);
  assert.equal(readGate(reply, none), null);
  assert.equal(pickerAtBottom(reply), false);
  const claude = lines(`
● Here's how to log in:
  1. Open https://example.com/login
  2. Paste the API key below
───────────────────────────────
❯
───────────────────────────────
  ? for shortcuts`);
  assert.equal(readGate(claude, none), null);
  assert.equal(pickerAtBottom(claude), false);
});

test('a permission prompt about signing in is not a sign-in', () => {
  const claude = lines(`
 Bash command
   gh auth login --web && open https://github.com/login/device
   Sign in to GitHub
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for gh auth login commands in /home/me/code/app
   3. No, and tell Claude what to do differently (esc)
 Esc to cancel · Tab to amend · ctrl+e to explain`);
  assert.equal(readGate(claude, none), null);
});

test("a preset's own screen is a gate of its kind, and its trust row is the one to accept", () => {
  const grok = lines(`
        Do you trust the contents of this directory?
/home/me/code/emoji-picker-react
  Grok Build may run or modify contents in this directory,
                   posing security risks.
               Yes, proceed                 y
               No, quit                     n
                               Grok Build  1.0.77 [stable]`);
  const g = readGate(grok, compileGates({ trust: { pattern: 'Do you trust the contents of this directory\\?', accept: '^Yes, proceed' } }))!;
  assert.equal(g.gate.kind, 'trust');
  assert.equal(g.accept, 'y');
  assert.deepEqual(g.options?.map((o) => o.key), ['y', 'n']);
  assert.equal(readGate(grok, none), null, 'not a sign-in, and no preset rule');
  const setup = compileGates({ gates: [{ kind: 'setup', pattern: 'Choose the text style' }] });
  const theme = lines(`
 Choose the text style that looks best with your terminal
 ❯ 1. Dark mode ✔
   2. Light mode
   3. Dark mode (colorblind-friendly)
 Enter to confirm · Esc to exit`);
  assert.equal(readGate(theme, setup)?.gate.kind, 'setup');
});

test('a picker counts at the bottom of the screen, under its own footer', () => {
  const update = lines(`
  ✨ Update available! 0.162.1 -> 0.163.0
  Release notes: https://github.com/openai/codex/releases/latest
› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version
  Press enter to continue`);
  assert.equal(pickerAtBottom(update), true);
  assert.equal(readGate(update, none), null, 'a picker, but not a sign-in');
  // The same rows with the agent's input box under them are its reply.
  assert.equal(pickerAtBottom([...update.slice(0, -1), '› Ask Codex to do anything', '  ⏎ send   ⌃C quit']), false);
});

test('links rejoin only from a line that reaches the edge', () => {
  assert.deepEqual(readLinks(['see https://a.example/x and', 'https://b.example/y.']), ['https://a.example/x', 'https://b.example/y']);
  assert.deepEqual(readLinks(['  https://a.example/a/very/long/path/that/reaches/the/edge/of/the/window/pa', 'th?q=1 then press enter']), ['https://a.example/a/very/long/path/that/reaches/the/edge/of/the/window/path?q=1']);
  // A list under a link that happens to be the widest line goes on as a list.
  assert.deepEqual(readLinks(['  1. Open: https://portal.example.com/manage-subscription?user_code=EP26-28KT', '  2. If prompted, enter code: EP26-28KT']), ['https://portal.example.com/manage-subscription?user_code=EP26-28KT']);
});

test("a sign-in an agent printed line by line is over once it says it's ready below it", () => {
  const rules = compileGates({ gates: [{ kind: 'signin', pattern: 'Starting Hermes login' }], ready: '^Welcome to Hermes Agent!|^❯ ' });
  const waiting = lines(`
Starting Hermes login via Nous Portal...
To continue:
  1. Open: https://portal.nousresearch.com/manage-subscription?user_code=EP26-28KT
  2. If prompted, enter code: EP26-28KT
Waiting for approval (polling every 1s)...`);
  assert.deepEqual(readGate(waiting, rules)?.gate, { kind: 'signin', links: ['https://portal.nousresearch.com/manage-subscription?user_code=EP26-28KT'], code: 'EP26-28KT' });
  const done = [...waiting, 'Login successful.', 'Welcome to Hermes Agent! Type your message or /help for commands.', '─────', '❯ ', '─────'];
  assert.equal(readGate(done, rules), null);
});


// Every agent CLI on the developer's host, captured from a private tmux at 100x45:
// signed out with an empty home, and in a folder it hasn't seen (server/fixtures/gates).
const { DEFAULT_PRESETS } = await import('./config.ts');
const { readFileSync } = await import('node:fs');
const screen = (name: string) => readFileSync(new URL(`./fixtures/gates/${name}.txt`, import.meta.url), 'utf8').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-40);
const read = (agent: string, name: string) => readGate(screen(name), compileGates(DEFAULT_PRESETS.find((p) => p.id === agent) ?? {}));

test("every agent's own first-run, trust and sign-in screens are read, with what answers them", () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['claude', 'claude-1-theme', { kind: 'setup' }],
    ['claude', 'claude-2-login-method', { kind: 'signin', rows: 3 }],
    ['claude', 'claude-3-subscription-url', { kind: 'signin', link: 'https://claude.com/cai/oauth/authorize', input: 'Paste code here if prompted >' }],
    ['claude', 'trust-claude-1', { kind: 'trust', accept: 'nav:1' }],
    ['codex', 'trust-codex-1-git', { kind: 'trust', accept: '1' }],
    ['gemini', 'gemini-2-auth-picker', { kind: 'signin', rows: 3 }],
    ['gemini', 'gemini-3-google-url', { kind: 'signin', link: 'https://accounts.google.com/o/oauth2/v2/auth', input: 'Enter the authorization code:' }],
    ['gemini', 'trust-gemini-1', { kind: 'trust', accept: '1' }],
    ['grok', 'grok-1-device-code', { kind: 'signin', code: '6ARM-WJY7', link: 'https://accounts.x.ai/oauth2/device?user_code=6ARM-WJY7' }],
    ['grok', 'trust-grok-1', { kind: 'trust', accept: 'y' }],
    ['muse', 'muse-2-login-picker', { kind: 'signin' }],
    ['muse', 'muse-3-device-code', { kind: 'signin', code: 'LWJG-XLXJ', link: 'https://auth.meta.com/oauth/device/?code=LWJG-XLXJ' }],
    ['hermes', 'hermes-1-no-provider', { kind: 'setup', input: 'Set up a provider now? [Y/n]:' }],
    ['hermes', 'hermes-3-nous-device-code', { kind: 'signin', code: 'EP26-28KT', link: 'https://portal.nousresearch.com/manage-subscription?user_code=EP26-28KT' }],
    ['cursor', 'cursor-agent-2-login-link', { kind: 'signin', link: 'https://cursor.com/loginDeepControl' }],
    ['copilot', 'trust-copilot-1', { kind: 'trust', accept: '1' }],
    ['copilot', 'copilot-6-device-code', { kind: 'signin', code: '14CA-A892', link: 'https://github.com/login/device' }],
    ['crush', 'crush-1-model-picker', { kind: 'setup' }],
    ['crush', 'crush-3-anthropic-apikey-paste', { kind: 'signin', input: 'Enter your Anthropic Key.' }],
    ['pi', 'pi-2-login-method', { kind: 'signin', rows: 3 }],
    ['pi', 'pi-8-copilot-device-code', { kind: 'signin', code: 'C563-C63F', link: 'https://github.com/login/device', back: true }],
  ];
  for (const [agent, name, want] of cases) {
    const g = read(agent, name);
    assert.ok(g, `${name}: read`);
    assert.equal(g.gate.kind, want.kind, `${name}: kind`);
    if (want.rows) assert.equal(g.options?.length, want.rows, `${name}: rows`);
    if (want.accept) assert.equal(g.accept, want.accept, `${name}: the row that trusts`);
    if (want.code) assert.equal(g.gate.code, want.code, `${name}: code`);
    if (want.link) assert.ok(g.gate.links?.[0]?.startsWith(want.link as string), `${name}: first link ${g.gate.links?.[0]}`);
    if (want.input) assert.equal(g.gate.input, want.input, `${name}: input`);
    if (want.back) assert.equal(g.gate.back, true, `${name}: back`);
    assert.ok(!/Changelog|Update Available/.test(g.text), `${name}: the screen's own words, not a notice above it`);
  }
});

test("Gemini's sign-in link, wrapped at its own margin, is read whole, even scrolled above a short window", () => {
  const gemini = compileGates(DEFAULT_PRESETS.find((p) => p.id === 'gemini')!);
  // At 49 columns (a phone), every line of the block indented two, the link's too.
  const raw = readFileSync(new URL('./fixtures/gates/gemini-oauth-49.txt', import.meta.url), 'utf8').split('\n').map((l) => l.trimEnd());
  const link = /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?redirect_uri=\S+&client_id=681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j\.apps\.googleusercontent\.com$/;
  const whole = readGate(raw, gemini);
  assert.match(whole?.gate.links?.[0] ?? '', link);
  assert.equal(whole?.gate.callback, 'http://127.0.0.1:38637/oauth2callback');
  assert.ok(whole?.text.includes(whole.gate.links![0]), 'its words carry the link on one line');
  // The keyboard up (or the card under it) leaves only the spinner's box on the screen.
  for (const rows of [6, 9, 14]) {
    const screen = raw.slice(-rows - 1);
    assert.equal(readGate(screen, gemini), null, `${rows} rows alone: no link to read`);
    assert.match(readGate(screen, gemini, raw.slice(0, -rows - 1))?.gate.links?.[0] ?? '', link, `${rows} rows with the scrollback over them`);
  }
  // Words at the block's margin under a link that reaches the edge stay words.
  assert.deepEqual(readLinks(['  https://a.example/a/very/long/path/that/reaches/the/edg', '  then press enter to go on']), ['https://a.example/a/very/long/path/that/reaches/the/edg']);
});

test('an agent at its prompt, signed out or past a sign-in it printed, is not behind one', () => {
  for (const [agent, name] of [['hermes', 'hermes-4-prompt-after-cancel'], ['copilot', 'copilot-2-prompt-signed-out'], ['pi', 'pi-1-prompt-no-models'], ['opencode', 'opencode-1-prompt-no-signin']]) {
    assert.equal(read(agent, name), null, name);
  }
});

test("only the address this sign-in hands back to is opened, from this sign-in", () => {
  const gate = readGate(CODEX_BROWSER_NARROW, none)!.gate;
  const state = 'nRVcFgFJpQJz0jfLKAxonc1zwpXDhOBopAxVmTQxfO4';
  const ok = callbackFor(gate, `http://localhost:1455/auth/callback?code=ac_123&scope=openid&state=${state}`);
  assert.equal(ok?.href, `http://127.0.0.1:1455/auth/callback?code=ac_123&scope=openid&state=${state}`, 'opened on the redirect host itself');
  for (const bad of [
    `http://127.0.0.1:1455/auth/callback?code=ac_123&state=someone-else`,
    `http://127.0.0.1:1455/auth/callback?code=ac_123`,
    `http://127.0.0.1:22/auth/callback?code=ac_123&state=${state}`,
    `http://127.0.0.1:1455/admin?state=${state}`,
    `http://10.0.0.5:1455/auth/callback?code=ac_123&state=${state}`,
    `https://127.0.0.1:1455/auth/callback?code=ac_123&state=${state}`,
    `file:///etc/passwd`,
    'not a url',
  ]) assert.equal(callbackFor(gate, bad), null, bad);
  assert.equal(callbackFor(readGate(CODEX_DEVICE, none)!.gate, `http://127.0.0.1:1455/auth/callback?state=${state}`), null, 'a device code has no callback');
});

