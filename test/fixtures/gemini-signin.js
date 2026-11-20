// A signed-out Gemini CLI waiting on its browser sign-in, at a phone's 49 columns: the
// link wrapped at its block's margin, then the spinner's box. It draws once the window
// is short (the test makes it 9 rows), so the link is in the scrollback, off the screen.
import { readFileSync } from 'node:fs';

const screen = readFileSync(new URL('../../server/fixtures/gates/gemini-oauth-49.txt', import.meta.url), 'utf8');
process.stdin.setRawMode(true);
const draw = () => process.stdout.write(screen.replace(/\n$/, '').replace(/\n/g, '\r\n'));
const short = () => process.stdout.rows <= 9;
if (short()) draw();
else process.stdout.once('resize', draw);
process.stdin.on('data', () => {});
