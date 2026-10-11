// Browser preview, black box: a dev server started inside a session is found,
// previewed through ah's own proxy port behind the same sign-in, and comes back
// after ah restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

/** GET on a preview port, as a browser on this machine would (Host = localhost:<port>). */
function viaPreview(port: number, path: string, cookie?: string) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...(cookie ? { cookie } : {}) }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const DEV = `node -e "require('http').createServer((q,r)=>r.end('dev server saw '+(q.headers.cookie||'no cookie')+' at '+q.headers.host)).listen(0,'127.0.0.1',function(){console.log('LISTENING='+this.address().port)})"`;

test('a dev server in a session is previewed behind ah’s sign-in, and survives a restart', async () => {
  let ah: Ah = await startAh();
  try {
    const cookie = await signIn(ah);
    const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text: DEV } });
    const devPort = Number(await until(async () => /LISTENING=(\d+)/.exec(ah.tmux('capture-pane', '-p', '-t', id))?.[1], 10000, 'dev server up'));

    // Found among the session's own listening ports.
    const info = await until(async () => {
      const r = (await http(ah, 'GET', `/api/sessions/${uid}/preview`, { cookie })).json();
      return r.ports.includes(devPort) && r;
    }, 8000, 'port detected');
    assert.equal(info.preview, null);
    assert.equal(info.live, true);

    assert.equal((await http(ah, 'PUT', `/api/sessions/${uid}/preview`, { cookie, body: { target: 0 } })).status, 400);
    assert.equal((await http(ah, 'PUT', `/api/sessions/${uid}/preview`, { body: { target: devPort } })).status, 401, 'signed in only');
    const started = await http(ah, 'PUT', `/api/sessions/${uid}/preview`, { cookie, body: { target: devPort } });
    assert.equal(started.status, 200, started.body);
    const { port } = started.json().preview;
    assert.ok(port >= 47600 && port <= 47699);

    assert.equal((await viaPreview(port, '/')).status, 401, 'the preview asks for the same sign-in');
    const ok = await viaPreview(port, '/', `${cookie}; theme=dark`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, `dev server saw theme=dark at localhost:${devPort}`, 'no ah cookie reaches the dev server');
    assert.match(String(ok.headers['content-security-policy']), new RegExp(`frame-ancestors .*http://localhost:${ah.port}`));

    // ah's own pages may frame previews.
    const page = await http(ah, 'GET', '/');
    assert.match(String(page.headers['content-security-policy']), /frame-src http:\/\/localhost:\*/);

    // Restart ah: the preview comes back for the still-running session.
    ah = await ah.restart();
    const back = await until(async () => (await http(ah, 'GET', `/api/sessions/${uid}/preview`, { cookie })).json().preview, 20000, 'preview restored');
    assert.equal(back.target, devPort);
    assert.equal((await viaPreview(back.port, '/', cookie)).status, 200);

    assert.equal((await http(ah, 'DELETE', `/api/sessions/${uid}/preview`, { cookie })).status, 200);
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/preview`, { cookie })).json().preview, null);
    await assert.rejects(viaPreview(back.port, '/', cookie), 'its port is closed');
  } finally {
    await cleanup(ah);
  }
});
