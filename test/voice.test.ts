import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { startAh, cleanup, http } from './helpers.ts';

const SPOKEN = 'okay so um make the composer stop jumping';
const SECRET = 'gsk-voice-test-91c';

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** A provider stand-in: Groq-style speech and chat endpoints that record what they get. */
async function provider() {
  const seen: { path: string; auth: string | undefined; type: string | undefined; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const b = await body(req);
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, type: req.headers['content-type'], body: b });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'whisper-large-v3-turbo' }, { id: 'llama-chat' }] }));
    if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: SPOKEN, language: 'english', duration: 2.5, segments: [{ text: SPOKEN, no_speech_prob: 0.02, avg_logprob: -0.1 }] }));
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: 'Make the composer stop jumping.' } }] }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

test('voice: set up from subscriptions, dictate a recording, refine device text, nothing said is logged', async () => {
  const p = await provider();
  const ah = await startAh({ auth: { mode: 'off' } });
  try {
    const hello = (await http(ah, 'GET', '/api/hello')).json();
    assert.equal(hello.features.voice, 1, 'the host says it can do voice');

    // Nothing set: the host can't transcribe, and says so with a code a client branches on.
    const empty = await http(ah, 'GET', '/api/voice');
    assert.equal(empty.status, 200, empty.body);
    assert.equal(empty.json().speech, null);
    const refused = await http(ah, 'POST', '/api/voice/dictate?name=speech.m4a', { raw: Buffer.from('audio'), headers: { 'content-type': 'audio/mp4' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json().code, 'voice_no_speech');

    const sub = await http(ah, 'POST', '/api/subscriptions', { body: { name: 'Groq', baseUrl: p.url, model: 'llama-chat', apiKey: SECRET } });
    assert.equal(sub.status, 200, sub.body);
    const id = sub.json().id;

    const models = await http(ah, 'POST', '/api/voice/models', { body: { subscriptionId: id } });
    assert.deepEqual(models.json(), { models: ['whisper-large-v3-turbo'] });

    const put = await http(ah, 'PUT', '/api/voice', { body: { speech: { subscriptionId: id, model: 'whisper-large-v3-turbo' }, cleanup: { subscriptionId: id, model: 'llama-chat' }, vocabulary: ['SwiftUI'] } });
    assert.equal(put.status, 200, put.body);
    assert.deepEqual(put.json().speech, { subscriptionId: id, name: 'Groq', model: 'whisper-large-v3-turbo' });
    assert.ok(!put.body.includes(SECRET));
    assert.equal((await http(ah, 'PUT', '/api/voice', { body: { speech: { subscriptionId: 'gone', model: 'x' } } })).json().code, 'subscription_not_found');

    const audio = Buffer.from('pretend this is AAC in an MP4 box');
    const said = await http(ah, 'POST', '/api/voice/dictate?name=speech.m4a&style=clean', { raw: audio, headers: { 'content-type': 'audio/mp4' } });
    assert.equal(said.status, 200, said.body);
    assert.deepEqual(said.json(), { raw: SPOKEN, text: 'Make the composer stop jumping.', style: 'clean', speech: 'Groq', cleanedBy: 'Groq', language: 'english', seconds: 2.5 });

    const speech = p.seen.find((s) => s.path === '/v1/audio/transcriptions')!;
    assert.equal(speech.auth, `Bearer ${SECRET}`);
    assert.match(speech.type ?? '', /^multipart\/form-data; boundary=/);
    assert.ok(speech.body.includes(audio), 'the recording reached the provider as sent');
    assert.ok(speech.body.includes('filename="speech.m4a"'));

    // A batch of a longer dictation: heard only, with what came before as the speech model's prompt.
    const batch = await http(ah, 'POST', `/api/voice/dictate?name=speech.m4a&style=verbatim&context=${encodeURIComponent('so far so good')}`, { raw: audio, headers: { 'content-type': 'audio/mp4' } });
    assert.equal(batch.status, 200, batch.body);
    assert.equal(batch.json().cleanedBy, null);
    assert.ok(p.seen.at(-1)!.body.includes('SwiftUI. so far so good'), 'the batch went with what came before');
    const tooMuch = await http(ah, 'POST', `/api/voice/dictate?name=speech.m4a&context=${'x'.repeat(2001)}`, { raw: audio, headers: { 'content-type': 'audio/mp4' } });
    assert.equal(tooMuch.status, 400);

    const refined = await http(ah, 'POST', '/api/voice/refine', { body: { text: 'um make it stop', style: 'clean', phone: 'um make it stop now' } });
    assert.equal(refined.status, 200, refined.body);
    assert.deepEqual(refined.json(), { text: 'Make the composer stop jumping.', cleanedBy: 'Groq' });

    const big = await http(ah, 'POST', '/api/voice/dictate?name=speech.m4a', { raw: Buffer.alloc(25 * 1024 * 1024 + 1), headers: { 'content-type': 'audio/mp4' } });
    assert.equal(big.status, 413);
    assert.equal(big.json().code, 'voice_too_large');

    // The activity log says a dictation happened, never what was said.
    const state = join(ah.dir, 'state', 'ah');
    // (ah.db holds the key itself, masked in every response: SECURITY.md.)
    const logs = readdirSync(state)
      .filter((f) => !f.startsWith('ah.db'))
      .map((f) => readFileSync(join(state, f), 'utf8'))
      .join('\n');
    assert.match(logs, /"event":"voice.dictate"/);
    assert.match(p.seen.at(-1)!.body.toString(), /<phone>/, 'the phone\'s hearing went to the cleanup');
    for (const words of ['composer stop jumping', 'make it stop', 'so far so good', SECRET]) assert.ok(!logs.includes(words), `"${words}" stays out of the logs`);
  } finally {
    p.close();
    await cleanup(ah);
  }
});
