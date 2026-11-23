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
const startDelayMs = Number(process.argv.find((a) => a.startsWith('--start-delay='))?.slice(14)) || 0;
// --modes: Shift+Tab cycles a permission mode, shown in a footer line like Claude's.
const modes = process.argv.includes('--modes');
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
if (startDelayMs > 0) {
  process.stdout.write('starting...');
  const boot = setInterval(() => process.stdout.write('.'), 200);
  await new Promise((r) => setTimeout(r, startDelayMs));
  clearInterval(boot);
  process.stdout.write('\n');
}
process.stdin.setRawMode(true);
state('idle');
console.log('READY');
const MODES = ['manual mode on', 'accept edits on', 'plan mode on'];
let mode = 0;
if (modes) console.log(`  ⏸ ${MODES[mode]}`);
let text = '';
let turnTimer;
process.stdin.on('data', (chunk) => {
  let input = chunk.toString();
  if (modes && input.includes('\x1b[Z')) {
    for (const _ of input.matchAll(/\x1b\[Z/g)) mode = (mode + 1) % MODES.length;
    console.log(`  ⏸ ${MODES[mode]}`);
    input = input.replaceAll('\x1b[Z', '');
  }
  for (const char of input) {
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
      // --modes: "PICKER" draws a permission prompt over the footer, as a turn can.
      if (modes && prompt === 'PICKER') console.log(` Do you want to proceed?\n ❯ 1. Yes\n   2. No\n  ⏸ ${MODES[mode]}`);
      if (claudeInterrupt) spin();
      turnTimer = setTimeout(() => { stopSpin(); state('done'); console.log(`FINISHED:${prompt}`); }, turnMs);
    } else text += char;
  }
});
