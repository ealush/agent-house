// The pi bridge end to end: the real pi, its real TUI in a disposable host's tmux, ah's
// extension loaded (config `experimental.piBridge`), a scripted model in place of a provider.
// Everything goes through ah's HTTP API, as a phone would: a message goes in once, Stop
// stops, an approval is answered from ah (after ah itself restarted), the model switches live.
//
// Needs pi on this machine (AH_TEST_PI, `mise which pi`, or pi on PATH); skipped without it.
import './scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, http, startAh, until, type Ah } from './helpers.ts';
import { fakePiModels, startFakeModel } from './fixtures/fake-openai.ts';

function findPi(): string | null {
  if (process.env.AH_TEST_PI) return process.env.AH_TEST_PI;
  // mise's shim installs pi into whatever HOME it runs under: the binary itself, then.
  for (const [cmd, args] of [['mise', ['which', 'pi']], ['sh', ['-c', 'command -v pi']]] as const) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out && !readFileSync(out, 'utf8').slice(0, 200).includes('mise use')) return out;
    } catch {}
  }
  return null;
}

const PI = findPi();

test('pi bridge: send once, Stop, an approval across an ah restart, a live model switch', { skip: PI ? false : 'pi is not installed here', timeout: 120_000 }, async () => {
  const model = await startFakeModel();
  // The pane inherits the private tmux server's environment: no network, no update check.
  Object.assign(process.env, { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
  let ah: Ah | null = null;
  const first = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    experimental: { piBridge: true },
    presets: [{ id: 'pi', name: 'pi', command: PI!, modelArgs: ['--model', '{model}'], feed: 'pi', match: '^pi$', resumeId: `${PI} --session {id}`, interruptKeys: ['Escape'] }],
  });
  ah = first;
  try {
    const agentDir = join(first.dir, 'home', '.pi', 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify(fakePiModels(model.url)));
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ quietStartup: true }));

    const created = await http(first, 'POST', '/api/windows', { body: { preset: 'pi', cwd: `${first.dir}/files`, model: 'fake/fake-1' } });
    assert.equal(created.status, 201, created.body);
    const { uid } = created.json();
    const view = async () => (await http(ah!, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    const screen = () => ah!.tmux('capture-pane', '-p', '-t', created.json().id);
    // pi writes its session file once there's a reply to keep.
    const session = (): any[] => {
      try {
        const root = join(agentDir, 'sessions');
        const dir = readdirSync(root).map((d) => join(root, d))[0];
        const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
        return readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    const said = (text: string) => session().filter((e) => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message.content).includes(text)).length;
    const replied = (text: string) => session().some((e) => e.type === 'message' && e.message.role === 'assistant' && JSON.stringify(e.message.content).includes(text));

    // The extension speaks for it: state from its own report, the session id and the model it runs.
    const ready = await until(async () => {
      const w = await view();
      return w?.agent === 'pi' && w.statusSource === 'hook' && ['idle', 'attention'].includes(w.status) && w;
    }, 30_000, 'pi with the bridge, idle');
    assert.ok(ready.harnessId, 'its session id, without guessing from transcripts');

    // 1. A message goes in once, and a retry of it (a reply lost on the way back) doesn't go in again.
    const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'hello there', id: 'msg-1' } });
    assert.equal(sent.status, 200, sent.body);
    assert.equal(sent.json().outcome, 'delivered');
    await until(() => replied('You said: hello there'), 15_000, 'the reply');
    await until(async () => ['idle', 'attention'].includes((await view()).status), 10_000, 'idle again');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'hello there', id: 'msg-1' } })).json().outcome, 'delivered');
    assert.equal(said('hello there'), 1, 'once');
    // Spent for good once pi recorded it (its message_end for a user message), kept in the
    // session: the retry above was refused by that, not only by the hand-over still pending.
    assert.ok(session().some((e) => e.type === 'custom' && e.customType === 'ah-bridge' && e.data?.taken === 'msg-1'), `pi recorded the key: ${JSON.stringify(session().map((e) => e.type))}`);

    // 2. A command waits for you; ah restarts while it does; the answer from the new ah runs it.
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'RUN echo bridged-ok' } });
    const asking = await until(async () => {
      const w = await view();
      return w.status === 'waiting' && w;
    }, 15_000, 'waiting on the command');
    assert.equal(asking.ask.kind, 'command');
    assert.equal(asking.ask.text, 'echo bridged-ok');
    assert.match(asking.ask.id, /^call_/, "pi's own id for the approval");
    assert.equal(asking.answerable, true);
    assert.match(screen(), /Run this command\?/, "pi's own dialog is on screen too");
    ah = await first.restart();
    const still = await until(async () => {
      const w = await view();
      return w?.status === 'waiting' && w;
    }, 20_000, 'still waiting after the restart');
    assert.equal(still.askId, asking.askId, 'the same question');
    const answered = await http(ah, 'POST', `/api/sessions/${uid}/answer`, { body: { answer: 'approve', prompt: still.askId } });
    assert.equal(answered.status, 200, answered.body);
    await until(() => replied('The command printed: bridged-ok'), 15_000, 'it ran');
    assert.doesNotMatch(screen(), /Run this command\?/, 'the dialog closed with it');

    // 3. A message while it waits is the answer: no, and why.
    await until(async () => ['idle', 'attention'].includes((await view()).status), 10_000, 'idle');
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'RUN rm -rf /tmp/nothing' } });
    await until(async () => (await view()).status === 'waiting', 15_000, 'waiting again');
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'no, list it first' } });
    await until(() => session().some((e) => e.message?.role === 'toolResult' && JSON.stringify(e.message.content).includes('no, list it first')), 15_000, 'declined with the reason');

    // 4. Stop stops a turn mid-stream.
    await until(async () => ['idle', 'attention'].includes((await view()).status), 10_000, 'idle');
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'SLOW please' } });
    await until(async () => (await view()).status === 'busy', 10_000, 'working');
    await until(() => session().length && screen().includes('tick tick'), 10_000, 'streaming');
    const stop = await http(ah, 'POST', `/api/sessions/${uid}/interrupt`);
    assert.equal(stop.status, 200, stop.body);
    await until(() => session().some((e) => e.message?.role === 'assistant' && e.message.stopReason === 'aborted'), 10_000, 'aborted');
    await until(async () => (await view()).status !== 'busy', 10_000, 'not working');

    // 4b. Send Now: a message queued behind a long turn stops it and goes to pi itself, once.
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'SLOW again please' } });
    await until(async () => (await view()).status === 'busy', 10_000, 'working again');
    const queued = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'urgent: hello now' } });
    assert.equal(queued.json().outcome, 'queued', queued.body);
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${queued.json().queueId}/send-now`);
    assert.equal(now.status, 200, now.body);
    await until(() => replied('You said: urgent: hello now'), 20_000, 'the urgent one answered');
    assert.equal(said('urgent: hello now'), 1, 'once');
    await until(async () => ['idle', 'attention'].includes((await view()).status), 15_000, 'idle');

    // 5. The model switches live, through pi itself.
    const sw = await http(ah, 'POST', `/api/sessions/${uid}/switch`, { body: { model: 'fake/fake-2' } });
    assert.equal(sw.status, 200, sw.body);
    await until(() => session().some((e) => e.type === 'model_change' && e.modelId === 'fake-2'), 10_000, 'switched');
    await until(async () => (await view()).model === 'fake/fake-2', 10_000, 'ah shows it');

    // Its prompts are the bridge's, not a screen's: the screen rules' audit leaves them be.
    assert.doesNotMatch(first.log() + ah.log(), /screen rules missed a pi prompt/);
  } finally {
    await cleanup(first);
    await model.close();
  }
});
