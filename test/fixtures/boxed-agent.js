// A TUI stand-in that draws its input box the way Claude Code does (between two
// rules, "❯ " first) and loses the first Enter after a paste: it lands as a
// newline in the input, the way a real agent can drop one, leaving the prompt unsent.
// Ctrl+U takes the box a line at a time, as Claude Code's does. --restore: a turn
// works until it's stopped, and Esc puts its prompt back in the box, as Claude Code
// stopped before its first word does. --transcript: each prompt it takes is written to
// a Claude Code-shaped transcript, so ah can watch for it. --turn=<ms>: how long a turn
// works. --deaf=<n>: its n-th paste won't submit, however often Enter is pressed (a busy
// TUI), until the box is emptied with Ctrl+U.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function state(value) {
  execFileSync('tmux', ['set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-harness', 'test-agent',
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state', value,
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state-at', String(Math.floor(Date.now() / 1000))]);
}
const restore = process.argv.includes('--restore');
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const turnMs = Number(flag('turn') ?? 300);
const deafOn = Number(flag('deaf') ?? 0);
let pastes = 0;
let deaf = false;
let transcript = null;
if (process.argv.includes('--transcript')) {
  const id = randomUUID();
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  let n = 0;
  transcript = (type, content) => appendFileSync(file, JSON.stringify({ type, uuid: `${type}-${++n}`, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content } }) + '\n');
  transcript('user', 'Start the fixture');
  transcript('assistant', [{ type: 'text', text: 'Ready.' }]);
}
const rule = '─'.repeat(40);
const log = [];
let input = '';
let pasting = false;
let dropNext = false;
let asked = '';
const draw = () => {
  const box = (input || 'Try "something"').split('\n').map((l, i) => (i ? `  ${l}` : `❯ ${l}`));
  process.stdout.write(`\x1b[2J\x1b[H${[...log, rule, ...box, rule, '  footer'].join('\r\n')}`);
};
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h');
state('idle');
draw();
process.stdin.on('data', (chunk) => {
  let s = chunk.toString();
  while (s) {
    if (s.startsWith('\x1b[200~')) { pasting = true; deaf = ++pastes === deafOn; s = s.slice(6); continue; }
    if (s.startsWith('\x1b[201~')) { pasting = false; dropNext = true; s = s.slice(6); continue; }
    if (s[0] === '\x1b' && s[1] !== '[') {
      s = s.slice(1);
      if (asked) { log.push('INTERRUPTED'); input = asked; asked = ''; }
      continue;
    }
    const c = s[0];
    s = s.slice(1);
    if (pasting) input += c === '\r' ? '\n' : c;
    else if (c === '\x15') {
      input = input.includes('\n') ? input.slice(0, input.lastIndexOf('\n')) : '';
      if (!input) deaf = false;
    } else if (c === '\r' && deaf) continue;
    else if (c === '\r' && dropNext) { dropNext = false; input += '\n'; }
    else if (c === '\r') {
      if (!input.trim()) continue;
      log.push(`RECEIVED:${input.trim().replace(/\n/g, ' ')}`);
      if (restore) asked = input.trim();
      transcript?.('user', input.trim());
      input = '';
      state('working');
      if (!restore) setTimeout(() => { transcript?.('assistant', [{ type: 'text', text: 'Done.' }]); state('done'); }, turnMs);
    } else input += c;
  }
  draw();
});
