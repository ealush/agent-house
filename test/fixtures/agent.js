// A deterministic TUI stand-in for testing sends without an installed AI CLI.
import { execFileSync } from 'node:child_process';

function state(value) {
  execFileSync('tmux', ['set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-harness', 'test-agent',
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state', value,
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state-at', String(Math.floor(Date.now() / 1000))]);
}
process.stdin.setRawMode(true);
state('idle');
console.log('READY');
let text = '';
let turnTimer;
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char === '\x1b' || char === '\x03') {
      clearTimeout(turnTimer);
      text = '';
      state('done');
      console.log('INTERRUPTED');
    } else if (char === '\r' || char === '\n') {
      const prompt = text;
      text = '';
      state('working');
      console.log(`RECEIVED:${prompt}`);
      turnTimer = setTimeout(() => { state('done'); console.log(`FINISHED:${prompt}`); }, 600);
    } else text += char;
  }
});
