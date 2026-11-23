// One session reads another's conversation: `ah conversation <target|link>`, and a session's
// link sent to an agent arrives with the line that says how (server/sessionLinks.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until, type Ah } from './helpers.ts';

const CLI = fileURLToPath(new URL('../bin/ah.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/transcript-agent.js', import.meta.url));

function ahCli(ah: Ah, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...ah.env, AH_PORT: String(ah.port) } }, (e, out, err) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
    );
  });
}

test("a session reads another's conversation by its link, and a link sent to an agent says how", async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'claude', name: 'Fixture', command: `exec ${process.execPath} ${fixture}`, match: '^node$', feed: 'claude' }],
  });
  try {
    const start = async (label: string) => {
      const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files`, label } });
      assert.equal(created.status, 201, created.body);
      const { uid } = created.json();
      await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid && w.harnessId && ['idle', 'attention'].includes(w.status)), 15000, `${label} ready`);
      return uid as string;
    };
    const source = await start('Planning');
    assert.equal((await http(ah, 'POST', `/api/sessions/${source}/send`, { body: { text: 'ping' } })).status, 200);
    await until(async () => (await http(ah, 'GET', `/api/sessions/${source}/feed/prompts`)).json().prompts.length === 2, 8000, 'ping in the transcript');

    // By its link, as Copy Link makes it, from the web or the app.
    const link = `https://box.example.ts.net/#${source}`;
    const read = await ahCli(ah, 'conversation', link);
    assert.equal(read.code, 0, read.err);
    assert.match(read.out, /^# Planning\n/);
    assert.match(read.out, new RegExp(`ah session ${source}`));
    assert.match(read.out, /User · \d{4}-\d\d-\d\d \d\d:\d\dZ:\nStart the fixture/);
    assert.match(read.out, /User · [^\n]*:\nping\n\nAssistant · [^\n]*:\n→ Bash: echo ping/);
    // The last of it.
    const last = await ahCli(ah, 'conversation', source, '-n', '1');
    assert.equal(last.code, 0, last.err);
    assert.doesNotMatch(last.out, /Start the fixture/);
    assert.match(last.out, /before these are left out \(-n 0 shows them all\)/);
    // Another host's session is that host's to read.
    const elsewhere = await ahCli(ah, 'conversation', `https://box.example.ts.net/#mac/${source}`);
    assert.notEqual(elsewhere.code, 0);
    assert.match(elsewhere.err, /a session on mac: run this there/);

    // Sent to another agent, the link comes with the line that says how to read it.
    const reader = await start('Reader');
    assert.equal((await http(ah, 'POST', `/api/sessions/${reader}/send`, { body: { text: `Read ${link} first` } })).status, 200);
    const screen = await until(async () => {
      const text = (await http(ah, 'GET', `/api/sessions/${reader}/capture?lines=200`)).body;
      return text.includes(`conversation ${source}]`) && text;
    }, 8000, 'the hint reached the agent');
    assert.match(screen, new RegExp(`RECEIVED:\\[ah: ${link.replace(/[.?]/g, '\\$&')} is the ah session "Planning"\\. Print its conversation with: .*conversation ${source}\\]`));
  } finally {
    await cleanup(ah);
  }
});
