// A TUI stand-in that draws its input box the way Claude Code does (between two
// rules, "❯ " first) and loses the first Enter after a paste: it lands as a
// newline in the input, the way a real agent can drop one, leaving the prompt unsent.
// Ctrl+U takes the box a line at a time, as Claude Code's does. --restore: a turn
// works until it's stopped, and Esc puts its prompt back in the box, as Claude Code
// stopped before its first word does.
import { execFileSync } from 'node:child_process';

function state(value) {
  execFileSync('tmux', ['set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-harness', 'test-agent',
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state', value,
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state-at', String(Math.floor(Date.now() / 1000))]);
}
const restore = process.argv.includes('--restore');
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
    if (s.startsWith('\x1b[200~')) { pasting = true; s = s.slice(6); continue; }
    if (s.startsWith('\x1b[201~')) { pasting = false; dropNext = true; s = s.slice(6); continue; }
    if (s[0] === '\x1b' && s[1] !== '[') {
      s = s.slice(1);
      if (asked) { log.push('INTERRUPTED'); input = asked; asked = ''; }
      continue;
    }
    const c = s[0];
    s = s.slice(1);
    if (pasting) input += c === '\r' ? '\n' : c;
    else if (c === '\x15') input = input.includes('\n') ? input.slice(0, input.lastIndexOf('\n')) : '';
    else if (c === '\r' && dropNext) { dropNext = false; input += '\n'; }
    else if (c === '\r') {
      if (!input.trim()) continue;
      log.push(`RECEIVED:${input.trim().replace(/\n/g, ' ')}`);
      if (restore) asked = input.trim();
      input = '';
      state('working');
      if (!restore) setTimeout(() => state('done'), 300);
    } else input += c;
  }
  draw();
});
