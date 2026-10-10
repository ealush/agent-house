// Draws an agent's picker the way Claude Code does, then records every key it
// gets as one KEY:<json> line in a log file, so tests can check exactly what was typed.
import { appendFileSync } from 'node:fs';

const [mode, log] = process.argv.slice(2);
const SCREENS = {
  question: [
    '←  ☐ Color  ☐ Toppings  ✔ Submit  →',
    'Pick a color',
    '❯ 1. Red',
    '     Choose red',
    '  2. Green',
    '  3. Blue',
    '  4. Type something.',
    '────────────────────',
    '  5. Chat about this',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ],
  plain: ['READY', 'all done here'],
  permission: [
    ' Bash command',
    '   rm -rf build',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for rm commands",
    '   3. No, and tell Claude what to do differently (esc)',
  ],
};
process.stdin.setRawMode(true);
console.log(SCREENS[mode].join('\n'));
process.stdin.on('data', (chunk) => appendFileSync(log, `KEY:${JSON.stringify(chunk.toString())}\n`));
