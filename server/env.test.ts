import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvStore, checkName, fingerprint, maskSecret } from './env.ts';
import { SideChatStore } from './sidechat.ts';
import { ensureMigrated } from './db.ts';

const file = () => join(tmpdir(), `ah-env-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

async function fresh() {
  const path = file();
  await ensureMigrated(path);
  return { env: new EnvStore(path), subs: new SideChatStore(path) };
}

test('env: secrets are never listed, visible values are; both reach a launch', async () => {
  const { env } = await fresh();
  const key = 'LLM_1116abcdefghijklmnopqrstuvwxyz5vJQ';
  await env.put({ name: 'IMAGE_API_KEY', value: key, secret: true });
  await env.put({ name: 'IMAGE_MODEL', value: 'gpt-image-2', secret: false });
  const { vars } = await env.list();
  assert.deepEqual(vars, [
    { name: 'IMAGE_API_KEY', value: null, secret: true, hint: 'LLM_1116…vJQ' },
    { name: 'IMAGE_MODEL', value: 'gpt-image-2', secret: false, hint: null },
  ]);
  assert.ok(!JSON.stringify(vars).includes(key));
  assert.deepEqual(await env.forLaunch(), { IMAGE_API_KEY: key, IMAGE_MODEL: 'gpt-image-2' });
});

test('env: a blank value keeps a stored secret, but revealing one needs the value', async () => {
  const { env } = await fresh();
  await env.put({ name: 'TOKEN', value: 'old', secret: true });
  await env.put({ name: 'TOKEN', secret: true });
  assert.equal((await env.forLaunch()).TOKEN, 'old');
  await assert.rejects(env.put({ name: 'TOKEN', value: '', secret: false }), /enter the value/);
  await env.put({ name: 'TOKEN', value: 'new', secret: false });
  assert.equal((await env.list()).vars[0].value, 'new');
  await env.remove('TOKEN');
  assert.deepEqual(await env.forLaunch(), {});
  await assert.rejects(env.remove('TOKEN'), /not found/);
});

test('env: names must be plain identifiers and not ones each session sets itself', () => {
  for (const ok of ['A', '_X', 'OPENAI_API_KEY', 'lower_1']) assert.doesNotThrow(() => checkName(ok));
  for (const bad of ['', '1A', 'A-B', 'A B', 'A=B', '$A']) assert.throws(() => checkName(bad), /letters, digits/);
  for (const reserved of ['PATH', 'HOME', 'TMUX', 'TMUX_PANE', 'term']) assert.throws(() => checkName(reserved), /shell profile/);
});

test('env: values must be text of bounded size', async () => {
  const { env } = await fresh();
  await assert.rejects(env.put({ name: 'A', value: 'a\0b', secret: false }), /not text/);
  await assert.rejects(env.put({ name: 'A', value: 'x'.repeat(8193), secret: false }), /too long/);
  // Multi-line values (a PEM, say) are fine: they go to tmux as one argv element.
  await env.put({ name: 'A', value: 'line 1\nline 2', secret: false });
  assert.equal((await env.forLaunch()).A, 'line 1\nline 2');
});

test('env: a subscription can hand its key to sessions, one owner per name', async () => {
  const { env, subs } = await fresh();
  const sub = await subs.put({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'sk-sub', envName: 'OPENAI_API_KEY' });
  assert.equal(sub.envName, 'OPENAI_API_KEY');
  assert.deepEqual((await env.list()).exports, [{ name: 'OPENAI_API_KEY', subscriptionId: sub.id, subscription: 'OpenAI' }]);
  assert.deepEqual(await env.forLaunch(), { OPENAI_API_KEY: 'sk-sub' });

  await assert.rejects(env.put({ name: 'OPENAI_API_KEY', value: 'x', secret: true }), /comes from the "OpenAI" subscription/);
  await assert.rejects(subs.put({ name: 'Other', baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', envName: 'OPENAI_API_KEY' }), /already sets/);
  await env.put({ name: 'MUSE_KEY', value: 'm', secret: true });
  await assert.rejects(subs.put({ id: sub.id, name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', envName: 'MUSE_KEY' }), /Settings → Environment/);
  await assert.rejects(subs.put({ id: sub.id, name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', envName: 'PATH' }), /variable name/);

  // Saving without envName leaves it; '' stops handing the key out.
  await subs.put({ id: sub.id, name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' });
  assert.equal((await subs.list())[0].envName, 'OPENAI_API_KEY');
  await subs.put({ id: sub.id, name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', envName: '' });
  assert.deepEqual(await env.forLaunch(), { MUSE_KEY: 'm' });
});

test('fingerprint: empty is empty, order does not matter, values do', () => {
  assert.equal(fingerprint({}), '');
  assert.equal(fingerprint({ A: '1', B: '2' }), fingerprint({ B: '2', A: '1' }));
  assert.notEqual(fingerprint({ A: '1' }), fingerprint({ A: '2' }));
  assert.notEqual(fingerprint({ AB: '' }), fingerprint({ A: 'B' }));
});

test('maskSecret: ends around an ellipsis, never more than a third of the secret', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('short-pass1'), '••••••');
  assert.equal(maskSecret('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789WXYZ'), 'sk-proj-…WXYZ');
  for (const n of [12, 13, 16, 20, 24, 31, 40, 100]) {
    const v = 'x'.repeat(n);
    const shown = maskSecret(v).replace('…', '').length;
    assert.ok(shown * 3 <= n, `${n} chars shows ${shown}`);
    assert.ok(shown >= 4, `${n} chars shows only ${shown}`);
  }
});
