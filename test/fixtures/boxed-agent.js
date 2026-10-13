// A TUI stand-in that draws its input box the way Claude Code does (between two
// rules, "❯ " first) and loses the first Enter after a paste: it lands as a
// newline in the input, the way a real agent can drop one, leaving the prompt unsent.
import { execFileSync } from 'node:child_process';

function state(value) {
  execFileSync('tmux', ['set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-harness', 'test-agent',
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state', value,
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state-at', String(Math.floor(Date.now() / 1000))]);
}
const rule = '─'.repeat(40);
const log = [];
let input = '';
let pasting = false;
let dropNext = false;
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
    const c = s[0];
    s = s.slice(1);
    if (pasting) input += c === '\r' ? '\n' : c;
    else if (c === '\r' && dropNext) { dropNext = false; input += '\n'; }
    else if (c === '\r') {
      if (!input.trim()) continue;
      log.push(`RECEIVED:${input.trim().replace(/\n/g, ' ')}`);
      input = '';
      state('working');
      setTimeout(() => state('done'), 300);
    } else input += c;
  }
  draw();
});
