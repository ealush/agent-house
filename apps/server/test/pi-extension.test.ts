// ah's pi extension (bin/pi-extension.ts) against a stand-in for pi's extension API, and the
// server's client for it (server/pi/bridge.ts) over a real Unix socket. The real pi in its
// real TUI is test/pi-bridge.test.ts.
import './scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import ahBridge from '../bin/pi-extension.ts';
import { PI_EXTENSION, piBridged, piPrompt, piRequest, piSocket, withPiBridge } from '../server/pi/bridge.ts';
import { DEFAULT_PRESETS } from '../server/config.ts';
import { until } from './helpers.ts';

type Handler = (e: any, ctx: any) => any;

/** pi's ExtensionAPI and a session's context, as much of them as the extension uses. */
function fakePi(o: { flag?: string; entries?: any[] } = {}) {
  const on = new Map<string, Handler[]>();
  const calls = { sent: [] as { text: string; opts?: any }[], entries: [] as any[], models: [] as string[], thinking: [] as string[], aborts: 0 };
  let idle = true;
  const ctx = {
    hasUI: false,
    isIdle: () => idle,
    abort: () => void calls.aborts++,
    model: { provider: 'fake', id: 'a' },
    sessionManager: { getSessionId: () => 'sess-1', getEntries: () => o.entries ?? [] },
    modelRegistry: { find: (provider: string, id: string) => (id === 'b' ? { provider, id } : undefined) },
  };
  const pi = {
    on: (name: string, h: Handler) => void on.set(name, [...(on.get(name) ?? []), h]),
    registerFlag: () => {},
    getFlag: (name: string) => (name === 'ah-approval' ? o.flag : undefined),
    getAllTools: () => [{ name: 'mcp_lookup', annotations: { readOnlyHint: true } }],
    sendUserMessage: (text: string, opts?: any) => void calls.sent.push({ text, opts }),
    appendEntry: (customType: string, data: any) => void calls.entries.push({ type: 'custom', customType, data }),
    setModel: async (m: any) => void calls.models.push(`${m.provider}/${m.id}`),
    setThinkingLevel: (l: string) => void calls.thinking.push(l),
  };
  const fire = async (name: string, e: any = {}) => {
    let out;
    for (const h of on.get(name) ?? []) out = await h(e, ctx);
    return out;
  };
  return { pi, ctx, calls, fire, on, busy: (b: boolean) => (idle = !b) };
}

async function started(o: Parameters<typeof fakePi>[0] = {}) {
  const uid = `t${randomBytes(4).toString('hex')}`;
  const path = piSocket(uid);
  process.env.AH_PI_SOCKET = path;
  const f = fakePi(o);
  ahBridge(f.pi);
  await f.fire('session_start');
  await until(() => existsSync(path), 3000, 'the socket');
  return { ...f, uid, path, ask: (msg: Record<string, unknown>) => piRequest(uid, msg) };
}

test('pi extension: started outside ah (no socket named), it stays out of the way', () => {
  delete process.env.AH_PI_SOCKET;
  const f = fakePi();
  ahBridge(f.pi);
  assert.equal(f.on.size, 0);
});

test('pi extension: a message is taken once per key, across a restart of pi too', async () => {
  const s = await started();
  try {
    assert.equal(await piPrompt(s.uid, 'hello', 'k1'), 'sent');
    assert.deepEqual(s.calls.sent, [{ text: 'hello', opts: undefined }]);
    // The same message again (a retry after a lost reply): not sent twice.
    assert.equal(await piPrompt(s.uid, 'hello', 'k1'), 'sent');
    assert.equal(s.calls.sent.length, 1);
    // While it works, a message waits for the turn (pi's follow-up), not interrupting it.
    s.busy(true);
    assert.equal(await piPrompt(s.uid, 'and then', 'k2'), 'sent');
    assert.deepEqual(s.calls.sent[1], { text: 'and then', opts: { deliverAs: 'followUp' } });
    assert.deepEqual(s.calls.entries.map((e) => e.data.taken), ['k1', 'k2']);
    await s.fire('session_shutdown');
    assert.equal(existsSync(s.path), false, 'the socket goes with pi');
  } finally {
    await s.fire('session_shutdown');
  }
  // pi restarted on the same session: what it took is in the session, so still not twice.
  const again = await started({ entries: [{ type: 'custom', customType: 'ah-bridge', data: { taken: 'k1' } }] });
  try {
    assert.equal(await piPrompt(again.uid, 'hello', 'k1'), 'sent');
    assert.equal(again.calls.sent.length, 0);
  } finally {
    await again.fire('session_shutdown');
  }
});

test('pi extension: /model and /thinking switch directly; its other slash commands are typed', async () => {
  const s = await started();
  try {
    assert.equal(await piPrompt(s.uid, '/model fake/b'), 'sent');
    assert.deepEqual(s.calls.models, ['fake/b']);
    assert.deepEqual(await piPrompt(s.uid, '/model fake/missing'), { failed: 'no model fake/missing with a key or a sign-in' });
    assert.equal(await piPrompt(s.uid, '/thinking high'), 'sent');
    assert.deepEqual(s.calls.thinking, ['high']);
    assert.equal(await piPrompt(s.uid, '/compact'), 'typed');
    assert.equal(s.calls.sent.length, 0);
  } finally {
    await s.fire('session_shutdown');
  }
});

test('pi extension: a command waits for an answer, checked against what it asks', async () => {
  const s = await started();
  try {
    const call = s.fire('tool_call', { toolCallId: 'c1', toolName: 'bash', input: { command: 'rm -rf build' } });
    await until(async () => (await s.ask({ type: 'state' }))?.status === 'waiting', 3000, 'waiting');
    assert.deepEqual((await s.ask({ type: 'state' }))!.waiting, [{ approval: 'c1', kind: 'command', text: 'rm -rf build' }]);
    // An answer to something it no longer asks is refused.
    assert.equal((await s.ask({ type: 'answer', allow: true, expect: 'ls' }))!.code, 'prompt_changed');
    assert.equal((await s.ask({ type: 'answer', allow: true, expect: 'rm -rf build' }))!.ok, true);
    assert.equal(await call, undefined, 'approved: it runs');
    assert.equal((await s.ask({ type: 'answer', allow: true }))!.code, 'not_waiting');

    const edit = s.fire('tool_call', { toolCallId: 'c2', toolName: 'edit', input: { path: 'a.ts' } });
    await until(async () => (await s.ask({ type: 'state' }))?.status === 'waiting', 3000, 'waiting');
    assert.equal(((await s.ask({ type: 'state' }))!.waiting as any)[0].text, 'Edit a.ts');
    await s.ask({ type: 'answer', allow: false });
    assert.deepEqual(await edit, { block: true, reason: 'The user did not approve this.' });

    // Reads, searches and a tool that says it only reads don't ask.
    assert.equal(await s.fire('tool_call', { toolCallId: 'c3', toolName: 'read', input: { path: 'a.ts' } }), undefined);
    assert.equal(await s.fire('tool_call', { toolCallId: 'c4', toolName: 'mcp_lookup', input: {} }), undefined);
  } finally {
    await s.fire('session_shutdown');
  }
});

test('pi extension: a message while it waits declines with what you said; Stop declines and aborts', async () => {
  const s = await started();
  try {
    const call = s.fire('tool_call', { toolCallId: 'c1', toolName: 'bash', input: { command: 'npm publish' } });
    await until(async () => (await s.ask({ type: 'state' }))?.status === 'waiting', 3000, 'waiting');
    assert.equal(await piPrompt(s.uid, 'not yet, run the tests first', 'k9'), 'sent');
    assert.deepEqual(await call, { block: true, reason: 'The user declined and said: not yet, run the tests first' });
    assert.equal(s.calls.sent.length, 0, 'the answer, not a new turn');

    const next = s.fire('tool_call', { toolCallId: 'c2', toolName: 'write', input: { path: 'x' } });
    await until(async () => (await s.ask({ type: 'state' }))?.status === 'waiting', 3000, 'waiting');
    assert.equal((await s.ask({ type: 'stop' }))!.ok, true);
    assert.deepEqual(await next, { block: true, reason: 'Stopped by the user.' });
    assert.equal(s.calls.aborts, 1);
  } finally {
    await s.fire('session_shutdown');
  }
});

test("pi extension: parallel calls ask one at a time; --ah-approval never asks nothing", async () => {
  const s = await started();
  try {
    const a = s.fire('tool_call', { toolCallId: 'a', toolName: 'bash', input: { command: 'one' } });
    const b = s.fire('tool_call', { toolCallId: 'b', toolName: 'bash', input: { command: 'two' } });
    await until(async () => (await s.ask({ type: 'state' }))?.status === 'waiting', 3000, 'waiting');
    assert.deepEqual(((await s.ask({ type: 'state' }))!.waiting as any).map((w: any) => w.text), ['one']);
    await s.ask({ type: 'answer', allow: true, expect: 'one' });
    await a;
    await until(async () => ((await s.ask({ type: 'state' }))?.waiting as any)?.[0]?.text === 'two', 3000, 'the second');
    await s.ask({ type: 'answer', allow: true, expect: 'two' });
    await b;
  } finally {
    await s.fire('session_shutdown');
  }
  const never = await started({ flag: 'never' });
  try {
    assert.equal(await never.fire('tool_call', { toolCallId: 'n', toolName: 'bash', input: { command: 'rm x' } }), undefined);
  } finally {
    await never.fire('session_shutdown');
  }
});

test('pi bridge: nothing listening means type it; the preset loads the extension when on', async () => {
  assert.equal(await piRequest('nobody', { type: 'state' }), null);
  assert.equal(await piPrompt('nobody', 'hello'), 'typed');
  assert.ok(piSocket('x'.repeat(40)).length < 104, 'fits a Unix socket path');

  const pi = DEFAULT_PRESETS.find((p) => p.id === 'pi')!;
  const on = withPiBridge(pi);
  assert.equal(on.command, `pi -e ${PI_EXTENSION}`);
  assert.equal(on.resumeId, `pi -e ${PI_EXTENSION} --session {id}`);
  assert.equal(on.resume, `pi -e ${PI_EXTENSION} --continue`);
  assert.equal(withPiBridge({ ...pi, command: '/opt/pi/bin/pi --offline' }).command, `/opt/pi/bin/pi -e ${PI_EXTENSION} --offline`);
  assert.deepEqual(on.modes?.map((m) => m.id), ['default', 'yolo']);
  assert.equal(on.switchModel, '/model {model}');
  const claude = DEFAULT_PRESETS.find((p) => p.id === 'claude')!;
  assert.equal(withPiBridge(claude), claude, 'only pi');

  assert.equal(piBridged({ agent: 'pi', statusSource: 'hook' }), true);
  assert.equal(piBridged({ agent: 'pi', statusSource: 'screen' }), false, 'pi without the extension');
  assert.equal(piBridged({ agent: 'claude', statusSource: 'hook' }), false);
});
