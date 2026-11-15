// A signed-out agent the way Codex draws it: a picker of ways to sign in, a device
// code screen, a box for an API key, and, once signed in, its prompt. Every key it
// gets is one KEY:<json> line in the log, and each message its prompt takes a
// PROMPT:<text> line, so tests can check what was typed where.
//
//   1 → the browser screen, its link back to 127.0.0.1; Esc → back
//   2 → the device code screen; Esc → back; z there → signed in
//   3 → the API key box; Enter with "sk-good" in it → signed in
import { appendFileSync } from 'node:fs';

const [log] = process.argv.slice(2);
process.stdin.setRawMode(true);
let at = 'pick';
let typed = '';

const SCREENS = {
  pick: () => [
    "  Welcome to Codex, OpenAI's command-line coding agent",
    '  Sign in with ChatGPT to use Codex as part of your paid plan',
    '> 1. Sign in with ChatGPT',
    '     Usage included with Plus, Pro, Business, and Enterprise plans',
    '  2. Sign in with Device Code',
    '     Sign in from another device with a one-time code',
    '  3. Provide your own API key',
    '     Pay for what you use',
    '  Press enter to continue',
  ],
  browser: () => [
    '  Finish signing in via your browser',
    "  If the link doesn't open automatically, press c to copy it:",
    '  https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=test',
    '  On a remote or headless machine? Press esc and choose Sign in with Device Code.',
    '  Press esc to cancel',
  ],
  device: () => [
    '  Finish signing in via your browser',
    '  1. Open this link in your browser and sign in',
    '  https://auth.openai.com/codex/device',
    '  2. Enter this one-time code after you are signed in (expires in 15 minutes)',
    '  JUC6-GKWC4',
    '  Press esc to cancel',
  ],
  key: () => [
    '> Use your own OpenAI API key for usage-based billing',
    '  Paste or type your API key below.',
    '╭API key──────────────────────────────────────╮',
    `│${'*'.repeat(typed.length) || 'Paste or type your API key'}`.padEnd(46) + '│',
    '╰─────────────────────────────────────────────╯',
    '  Press enter to save',
    '  Press esc to go back',
  ],
  prompt: () => ['SIGNED IN', `› ${typed || 'Ask anything'}`, '  ⏎ send   ⌃C quit'],
};
const draw = () => process.stdout.write(`\x1b[2J\x1b[H${SCREENS[at]().join('\r\n')}\r\n`);
draw();

process.stdin.on('data', (buf) => {
  const s = buf.toString('utf8');
  appendFileSync(log, `KEY:${JSON.stringify(s)}\n`);
  // A bracketed paste arrives as one chunk: its text, not keys.
  const paste = s.match(/^\x1b\[200~([\s\S]*)\x1b\[201~$/);
  if (paste) {
    if (at === 'key' || at === 'prompt') typed += paste[1];
    return draw();
  }
  if (s === '\x03') process.exit(0);
  if (at === 'pick') {
    if (s === '1') at = 'browser';
    else if (s === '2') at = 'device';
    else if (s === '3') at = 'key';
  } else if (at === 'browser') {
    if (s === '\x1b') at = 'pick';
  } else if (at === 'device') {
    if (s === '\x1b') at = 'pick';
    else if (s === 'z') at = 'prompt';
  } else if (at === 'key') {
    if (s === '\x1b') (at = 'pick'), (typed = '');
    else if (s === '\r' && typed === 'sk-good') (at = 'prompt'), (typed = '');
    else if (s !== '\r') typed += s;
  } else if (s === '\r') {
    appendFileSync(log, `PROMPT:${typed}\n`);
    typed = '';
  } else typed += s;
  draw();
});
