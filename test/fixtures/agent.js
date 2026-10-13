// A deterministic TUI stand-in for testing sends without an installed AI CLI.
import { execFileSync } from 'node:child_process';

function state(value) {
  execFileSync('tmux', ['set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-harness', 'test-agent',
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state', value,
    ';', 'set-option', '-w', '-t', process.env.TMUX_PANE, '@ah-state-at', String(Math.floor(Date.now() / 1000))]);
}
// --claude-interrupt: behave like Claude Code, whose Esc ends the turn without
// a Stop hook, and whose spinner animates while it works. --turn=<ms> sets how
// long a turn runs.
const claudeInterrupt = process.argv.includes('--claude-interrupt');
const turnMs = Number(process.argv.find((a) => a.startsWith('--turn='))?.slice(7)) || 600;
let spinner;
const spin = () => {
  let i = 0;
  spinner = setInterval(() => process.stdout.write(`\r${'|/-\\'[i++ % 4]} working`), 100);
};
const stopSpin = () => {
  if (spinner) process.stdout.write('\r          \r');
  clearInterval(spinner);
  spinner = undefined;
};
process.stdin.setRawMode(true);
state('idle');
console.log('READY');
let text = '';
let turnTimer;
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char === '\x1b' || char === '\x03') {
      clearTimeout(turnTimer);
      stopSpin();
      text = '';
      if (!claudeInterrupt) state('done');
      console.log('INTERRUPTED');
    } else if (char === '\r' || char === '\n') {
      const prompt = text;
      text = '';
      state('working');
      console.log(`RECEIVED:${prompt}`);
      if (claudeInterrupt) spin();
      turnTimer = setTimeout(() => { stopSpin(); state('done'); console.log(`FINISHED:${prompt}`); }, turnMs);
    } else text += char;
  }
});
