// Draws an agent's picker the way Claude Code does, then records every key it
// gets as one KEY:<json> line in a log file, so tests can check exactly what was typed.
//
//   question   a working two-question dialog (Color, then multi-select Toppings,
//              then the review), redrawn as keys arrive, like Claude's
//   hijacked   the same, but after the first answer a different question takes
//              over (input from elsewhere), so the rest must not be typed
//   permission / plain   static screens
import { appendFileSync } from 'node:fs';

const [mode, log] = process.argv.slice(2);
const STATIC = {
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

const draw = (lines) => process.stdout.write(`\x1b[2J\x1b[H${lines.join('\r\n')}\r\n`);
if (STATIC[mode]) console.log(STATIC[mode].join('\n'));

// The dialog's state.
const COLORS = ['Red', 'Green', 'Blue'];
const TOPPINGS = ['Cheese', 'Olives', 'Basil'];
let q = 0;
let cursor = 1;
let typing = false;
let other = '';
const picked = new Set();
let color = '';

function screen() {
  const tab = (done, name) => `${done ? '☒' : '☐'} ${name}`;
  const bar = `←  ${tab(q > 0, mode === 'hijacked' && q > 0 ? 'Planet' : 'Color')}  ${tab(q > 1, 'Toppings')}  ✔ Submit  →`;
  if (q === 0)
    return [bar, 'Pick a color', ...COLORS.map((c, i) => `${cursor === i + 1 ? '❯' : ' '} ${i + 1}. ${c}`), `${cursor === 4 ? '❯' : ' '} 4. ${typing ? other : 'Type something.'}`, '────────────', '  5. Chat about this', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'];
  if (q === 1 && mode === 'hijacked')
    return [bar, 'Pick a planet', '❯ 1. Mars', '  2. Venus', '  3. Type something.', '────────────', '  4. Chat about this', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'];
  if (q === 1)
    return [
      bar,
      'Pick toppings',
      ...TOPPINGS.map((t, i) => `${cursor === i + 1 ? '❯' : ' '} ${i + 1}. [${picked.has(i) ? '✔' : ' '}] ${t}`),
      `${cursor === 4 ? '❯' : ' '} 4. [${other ? '✔' : ' '}] ${other || 'Type something'}`,
      `${cursor === 5 ? '❯' : ' '}    Submit`,
      '────────────',
      '  5. Chat about this',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    ];
  if (q === 2) return [bar, 'Review your answers', ` ● Pick a color`, `   → ${color}`, ' ● Pick toppings', `   → ${[...[...picked].sort().map((i) => TOPPINGS[i]), other].filter(Boolean).join(', ')}`, 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel'];
  return ['SUBMITTED'];
}

if (!STATIC[mode]) draw(screen());

process.stdin.on('data', (chunk) => {
  const raw = chunk.toString();
  appendFileSync(log, `KEY:${JSON.stringify(raw)}\n`);
  if (STATIC[mode]) return;
  // One send-keys can carry several keys ("Down Down Down"): take them one at a time.
  for (const s of raw.match(/\x1b\[[A-D]|\x1bO[A-D]|[\s\S]/g) ?? []) key(s);
  draw(screen());
});

function key(s) {
  if (q === 0) {
    if (typing && s === '\r') {
      color = other;
      other = '';
      typing = false;
      q = 1;
      cursor = 1;
    } else if (typing) other += s;
    else if (/^[1-3]$/.test(s)) {
      color = COLORS[Number(s) - 1];
      q = 1;
      cursor = 1;
    } else if (s === '4') {
      typing = true;
      cursor = 4;
    }
  } else if (q === 1 && mode !== 'hijacked') {
    if (/^[1-3]$/.test(s)) {
      const i = Number(s) - 1;
      if (picked.has(i)) picked.delete(i);
      else picked.add(i);
    } else if (s === '\x1b[B' || s === '\x1bOB') cursor = Math.min(5, cursor + 1);
    else if (s === '\t') cursor = Math.min(5, cursor + 1);
    else if (s === '\x1b[C' || s === '\x1bOC' || (s === '\r' && cursor === 5)) q = 2;
    else if (cursor === 4 && /^[ -~]+$/.test(s)) other += s;
  } else if (q === 2 && s === '1') q = 3;
}
