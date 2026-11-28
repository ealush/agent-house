#!/usr/bin/env node
// A trust prompt like Codex 0.162's: a digit moves the cursor to its row, Enter picks the
// row under the cursor. Picking "Trust and continue" prints TRUSTED and a prompt.
const rows = process.env.MOVE_PICKER_APPROVAL ? ['Yes, run it', 'No'] : ['Trust and continue', 'Quit'];
let cursor = 0;
let done = false;
const draw = () => {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(process.env.MOVE_PICKER_APPROVAL ? '  $ rm -rf build\n\n  Run this command?\n\n' : '  /work/app\n\n  Trust this folder? Codex can read, edit, and run files here.\n\n');
  rows.forEach((r, i) => process.stdout.write(`${i === cursor ? '›' : ' '} ${i + 1}. ${r}\n`));
  process.stdout.write('\n  enter continue · esc quit\n');
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (done) return;
  if (/^[12]$/.test(s)) {
    cursor = Number(s) - 1;
    return draw();
  }
  if (s === '\r') {
    if (cursor === 1) process.exit(0);
    done = true;
    process.stdout.write('\x1b[2J\x1b[HTRUSTED\n> ');
  }
});
draw();
