// "Also open on …": a page counts once however many connections it holds, so
// switching views on one device never reads as a second device with its name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startAh, cleanup, http, until, type Ah } from './helpers.ts';

/** Opens a GUI stream for a session as a given page; returns its closer. */
function look(ah: Ah, uid: string, device: string, client?: string) {
  const q = `device=${device}${client ? `&client=${client}` : ''}`;
  const req = request({ host: '127.0.0.1', port: ah.port, path: `/api/sessions/${uid}/feed/stream?${q}`, headers: { host: `localhost:${ah.port}` }, agent: false }, (res) => res.resume());
  req.on('error', () => {});
  req.end();
  return () => req.destroy();
}

test('a page is one viewer, however many connections it holds', async () => {
  const ah = await startAh({ auth: { mode: 'off' } });
  try {
    ah.tmux('new-session', '-d', '-s', 'it', '-n', 'zz-viewed');
    const uid = await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.name === 'zz-viewed')?.uid, 10_000, 'window');
    const devices = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid).devices as string[];
    const settle = (want: string[]) => until(async () => JSON.stringify((await devices()).sort()) === JSON.stringify(want) || null, 5_000, `devices ${want}`);

    // The GUI stream and a terminal kept warm: the same page twice.
    const a1 = look(ah, uid, 'Desk', 'page-a');
    const a2 = look(ah, uid, 'Desk', 'page-a');
    await settle(['Desk']);
    // Another page with the same name is another viewer.
    const b = look(ah, uid, 'Desk', 'page-b');
    await settle(['Desk', 'Desk']);
    a1();
    await settle(['Desk', 'Desk']);
    a2();
    await settle(['Desk']);
    b();
    await settle([]);
    // Without a page id each connection counts on its own, as before.
    const c1 = look(ah, uid, 'Phone');
    const c2 = look(ah, uid, 'Phone');
    await settle(['Phone', 'Phone']);
    c1();
    c2();
    await settle([]);
  } finally {
    await cleanup(ah);
  }
});
