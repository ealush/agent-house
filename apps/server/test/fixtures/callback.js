// A signed-out agent whose sign-in hands back to a server of its own on 127.0.0.1, the
// way Codex's "Sign in with ChatGPT" does: it draws the link (state "st4te"), and once
// its callback is opened with that state it is signed in and at its prompt. Each message
// its prompt takes is a PROMPT:<text> line in the log; each callback a CALLBACK:<query>.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [log] = process.argv.slice(2);
process.stdin.setRawMode(true);
let signedIn = false;
let typed = '';

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  appendFileSync(log, `CALLBACK:${url.search}\n`);
  if (url.pathname !== '/auth/callback' || url.searchParams.get('state') !== 'st4te') {
    res.writeHead(400).end('bad callback');
    return;
  }
  signedIn = true;
  res.writeHead(200, { 'content-type': 'text/plain' }).end('Signed in to Test. You may close this page.');
  draw();
});
server.listen(0, '127.0.0.1', () => draw());

function draw() {
  const port = server.address()?.port;
  const link = `https://auth.example.com/oauth/authorize?response_type=code&client_id=app_test&redirect_uri=http%3A%2F%2F127.0.0.1%3A${port}%2Fauth%2Fcallback&state=st4te`;
  const lines = signedIn
    ? ['SIGNED IN', `› ${typed || 'Ask anything'}`, '  ⏎ send   ⌃C quit']
    : ['  Finish signing in via your browser', "  If the link doesn't open automatically, press c to copy it:", `  ${link}`, '  On a remote or headless machine? Press esc and choose Sign in with Device Code.'];
  process.stdout.write(`\x1b[2J\x1b[H${lines.join('\r\n')}\r\n`);
}

process.stdin.on('data', (buf) => {
  const s = buf.toString('utf8');
  if (s === '\x03') process.exit(0);
  const paste = s.match(/^\x1b\[200~([\s\S]*)\x1b\[201~$/);
  if (!signedIn) return;
  if (paste) typed += paste[1];
  else if (s === '\r') {
    appendFileSync(log, `PROMPT:${typed}\n`);
    typed = '';
  } else typed += s;
  draw();
});
