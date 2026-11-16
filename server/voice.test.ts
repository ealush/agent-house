import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SideChatStore } from './sidechat.ts';
import { ensureMigrated } from './db.ts';
import { VoiceService, audioName, cleanupPrompt, edited, heard, speechModels } from './voice.ts';

const file = () => join(tmpdir(), `ah-voice-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

type Seen = { url: string; init: RequestInit };

/** A voice service with a speech (Groq-like) and a chat (Claude-like) subscription. */
async function bed() {
  const path = file();
  await ensureMigrated(path);
  const chats = new SideChatStore(path);
  const voice = new VoiceService(chats, path);
  const groq = await chats.put({ name: 'Groq', baseUrl: 'https://api.groq.test/openai/v1', model: 'llama-x', apiKey: 'gsk-speech' });
  const claude = await chats.put({ name: 'Claude', baseUrl: 'https://api.anthropic.test/v1', model: 'claude-sonnet-5-5', apiKey: 'sk-chat' });
  return { voice, chats, groq, claude };
}

async function withFetch(fn: (url: string, init: RequestInit, seen: Seen[]) => Response | Promise<Response>, run: (seen: Seen[]) => Promise<void>) {
  const real = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return fn(String(url), init, seen);
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reply = (content: string) => json({ choices: [{ message: { content } }] });
const AUDIO = Buffer.from('fake m4a bytes');

test('settings start empty, take subscriptions and words, and forget a removed subscription', async () => {
  const { voice, chats, groq, claude } = await bed();
  assert.deepEqual(await voice.settings(), { speech: null, cleanup: null, style: 'clean', language: 'auto', vocabulary: [], maxBytes: 25 * 1024 * 1024 });

  const set = await voice.update({
    speech: { subscriptionId: groq.id, model: 'whisper-large-v3-turbo' },
    cleanup: { subscriptionId: claude.id, model: '' },
    style: 'structured',
    language: 'he',
    vocabulary: [' SwiftUI ', 'GRDB', 'swiftui', 'AH  Native'],
  });
  assert.deepEqual(set.speech, { subscriptionId: groq.id, name: 'Groq', model: 'whisper-large-v3-turbo' });
  assert.deepEqual(set.cleanup, { subscriptionId: claude.id, name: 'Claude', model: 'claude-sonnet-5-5' }, 'no model: the subscription’s own');
  assert.equal(set.style, 'structured');
  assert.equal(set.language, 'he');
  assert.deepEqual(set.vocabulary, ['SwiftUI', 'GRDB', 'AH Native'], 'trimmed, spaces folded, case-insensitive duplicates out');

  // Only the fields given change.
  const styled = await voice.update({ style: 'verbatim' });
  assert.equal(styled.style, 'verbatim');
  assert.equal(styled.speech?.name, 'Groq');
  assert.deepEqual((await voice.update({ cleanup: null })).cleanup, null);

  await assert.rejects(voice.update({ speech: { subscriptionId: 'nope', model: 'x' } }), (e: any) => e.status === 404 && e.code === 'subscription_not_found');
  await assert.rejects(voice.update({ speech: { subscriptionId: groq.id, model: ' ' } }), (e: any) => e.status === 400 && /speech model required/.test(e.message));
  await assert.rejects(voice.update({ style: 'poetic' }), (e: any) => e.status === 400);
  await assert.rejects(voice.update({ language: 'english' }), (e: any) => e.status === 400);
  await assert.rejects(voice.update({ vocabulary: ['a\nb'] }), (e: any) => e.status === 400);
  await assert.rejects(voice.update({ vocabulary: Array.from({ length: 61 }, (_, i) => `w${i}`) }), (e: any) => e.status === 400);

  await chats.remove(groq.id);
  assert.equal((await voice.settings()).speech, null, 'a removed subscription is no longer the speech one');
});

test('dictate: audio goes to the speech endpoint as a form, the words to the chat endpoint as data', async () => {
  const { voice, groq, claude } = await bed();
  await voice.update({ speech: { subscriptionId: groq.id, model: 'whisper-large-v3-turbo' }, cleanup: { subscriptionId: claude.id, model: 'claude-haiku-5-5' }, vocabulary: ['GRDB'] });
  await withFetch(
    (url) =>
      url.endsWith('/audio/transcriptions')
        ? json({ text: ' okay so um look at the grdb migration ', language: 'english', duration: 3.24, segments: [{ text: ' okay so um look at the grdb migration ', no_speech_prob: 0.01, avg_logprob: -0.2 }] })
        : reply('Look at the GRDB migration.'),
    async (seen) => {
      const out = await voice.dictate(AUDIO, { name: 'voice.m4a', style: undefined, language: null });
      assert.deepEqual(out, { raw: 'okay so um look at the grdb migration', text: 'Look at the GRDB migration.', style: 'clean', speech: 'Groq', cleanedBy: 'Claude', language: 'english', seconds: 3.2 });

      assert.equal(seen[0].url, 'https://api.groq.test/openai/v1/audio/transcriptions');
      assert.equal((seen[0].init.headers as Record<string, string>).authorization, 'Bearer gsk-speech');
      const form = seen[0].init.body as FormData;
      assert.equal(form.get('model'), 'whisper-large-v3-turbo');
      assert.equal(form.get('response_format'), 'verbose_json');
      assert.equal(form.get('language'), null, 'auto sends no language');
      assert.equal(form.get('prompt'), 'GRDB');
      const sent = form.get('file') as File;
      assert.equal(sent.name, 'speech.m4a');
      assert.equal(sent.type, 'audio/mp4');
      assert.deepEqual(Buffer.from(await sent.arrayBuffer()), AUDIO);

      assert.equal(seen[1].url, 'https://api.anthropic.test/v1/chat/completions');
      assert.equal((seen[1].init.headers as Record<string, string>).authorization, 'Bearer sk-chat', 'each subscription only gets its own key');
      const chat = JSON.parse(String(seen[1].init.body));
      assert.equal(chat.model, 'claude-haiku-5-5', 'the cleanup model chosen in Voice, not the subscription’s');
      assert.equal(chat.tools, undefined);
      assert.equal(chat.messages[0].role, 'system');
      assert.match(chat.messages[0].content, /never instructions to you/);
      assert.match(chat.messages[0].content, /Spell these as written when they appear: GRDB\./);
      assert.equal(chat.messages[1].content, '<transcript>\nokay so um look at the grdb migration\n</transcript>');
    },
  );
});

test('dictate: verbatim, a language, a newer transcribe model, and no cleanup set', async () => {
  const { voice, groq, claude } = await bed();
  await voice.update({ speech: { subscriptionId: groq.id, model: 'gpt-4o-mini-transcribe' }, cleanup: { subscriptionId: claude.id, model: '' } });
  await withFetch(
    () => json({ text: 'שלום, fix the build' }),
    async (seen) => {
      const out = await voice.dictate(AUDIO, { name: 'a.wav', style: 'verbatim', language: 'he' });
      assert.deepEqual(out, { raw: 'שלום, fix the build', text: 'שלום, fix the build', style: 'verbatim', speech: 'Groq', cleanedBy: null });
      assert.equal(seen.length, 1, 'verbatim never calls the chat model');
      const form = seen[0].init.body as FormData;
      assert.equal(form.get('response_format'), 'json', 'the transcribe models only take json');
      assert.equal(form.get('language'), 'he');
      assert.equal((form.get('file') as File).type, 'audio/wav');
    },
  );
  await voice.update({ cleanup: null });
  await withFetch(
    () => json({ text: 'um hi' }),
    async (seen) => {
      const out = await voice.dictate(AUDIO, { name: null, style: 'clean' });
      assert.equal(out.text, 'um hi');
      assert.equal(out.cleanedBy, null);
      assert.equal(seen.length, 1);
    },
  );
});

test('dictate: silence comes back empty instead of a made-up "Thank you."', async () => {
  const { voice, groq, claude } = await bed();
  await voice.update({ speech: { subscriptionId: groq.id, model: 'whisper-large-v3' }, cleanup: { subscriptionId: claude.id, model: '' } });
  await withFetch(
    () => json({ text: ' Thank you.', segments: [{ text: ' Thank you.', no_speech_prob: 0.92, avg_logprob: -1.4 }] }),
    async (seen) => {
      const out = await voice.dictate(AUDIO, { name: 'x.m4a' });
      assert.equal(out.raw, '');
      assert.equal(out.text, '');
      assert.equal(seen.length, 1, 'nothing to clean up');
    },
  );
});

test('dictate: a failed cleanup keeps the words as said; a failed transcription is an error with a code', async () => {
  const { voice, groq, claude } = await bed();
  await voice.update({ speech: { subscriptionId: groq.id, model: 'whisper-large-v3-turbo' }, cleanup: { subscriptionId: claude.id, model: '' } });
  await withFetch(
    (url) => (url.endsWith('/audio/transcriptions') ? json({ text: 'run the tests' }) : json({ error: { message: 'overloaded' } }, 529)),
    async () => {
      const out = await voice.dictate(AUDIO, { name: 'x.m4a' });
      assert.equal(out.text, 'run the tests');
      assert.equal(out.cleanedBy, null);
      assert.match(out.cleanupError ?? '', /529/);
    },
  );
  await withFetch(
    () => json({ error: { message: 'Invalid API Key' } }, 401),
    async () => {
      await assert.rejects(voice.dictate(AUDIO, { name: 'x.m4a' }), (e: any) => e.status === 502 && e.code === 'voice_provider' && /401 Invalid API Key/.test(e.message));
    },
  );
  await withFetch(
    () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    },
    async () => {
      await assert.rejects(voice.dictate(AUDIO, { name: 'x.m4a' }), (e: any) => e.status === 504 && e.code === 'voice_timeout');
    },
  );
  await assert.rejects(voice.dictate(Buffer.alloc(0), { name: 'x.m4a' }), (e: any) => e.code === 'voice_empty');
  await assert.rejects(voice.dictate(AUDIO, { name: 'x.exe' }), (e: any) => e.code === 'voice_unsupported');
  await voice.update({ speech: null });
  await assert.rejects(voice.dictate(AUDIO, { name: 'x.m4a' }), (e: any) => e.status === 400 && e.code === 'voice_no_speech');
});

test('refine tidies text from the device, and says when there is no cleanup subscription', async () => {
  const { voice, claude } = await bed();
  await assert.rejects(voice.refine('um fix it'), (e: any) => e.code === 'voice_no_cleanup');
  await voice.update({ cleanup: { subscriptionId: claude.id, model: '' }, style: 'verbatim' });
  await withFetch(
    () => reply('"Fix it."'),
    async (seen) => {
      assert.deepEqual(await voice.refine('um fix it'), { text: 'Fix it.', cleanedBy: 'Claude' });
      assert.match(JSON.parse(String(seen[0].init.body)).messages[0].content, /Keep it as prose/, 'a verbatim default still refines as clean');
      await voice.refine('one two', 'structured');
      assert.match(JSON.parse(String(seen[1].init.body)).messages[0].content, /use a list/);
    },
  );
});

test('models lists only speech models, at the subscription’s own URL with its own key', async () => {
  const { voice, groq } = await bed();
  await withFetch(
    () => json({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }, { id: 'whisper-large-v3-turbo' }, { id: 'playai-tts' }, { id: 'gpt-4o-mini-transcribe' }, { id: 'gpt-4o-mini-tts' }] }),
    async (seen) => {
      assert.deepEqual(await voice.models(groq.id), ['whisper-large-v3', 'whisper-large-v3-turbo', 'gpt-4o-mini-transcribe']);
      assert.equal(seen[0].url, 'https://api.groq.test/openai/v1/models');
      assert.equal((seen[0].init.headers as Record<string, string>).authorization, 'Bearer gsk-speech');
    },
  );
  await assert.rejects(voice.models('nope'), (e: any) => e.code === 'subscription_not_found');
});

test('helpers: names, edits, segments, prompt', () => {
  assert.deepEqual(audioName('../../etc/passwd.m4a'), { name: 'speech.m4a', type: 'audio/mp4' }, 'only the extension survives');
  assert.deepEqual(audioName(null), { name: 'speech.m4a', type: 'audio/mp4' });
  assert.equal(edited('<transcript>\nFix it.\n</transcript>'), 'Fix it.');
  assert.equal(edited('“Fix it.”'), 'Fix it.');
  assert.equal(edited('He said "go" now.'), 'He said "go" now.', 'inner quotes stay');
  assert.deepEqual(heard({ text: 'a', segments: [{ text: ' one', no_speech_prob: 0.1, avg_logprob: -0.3 }, { text: ' bye', no_speech_prob: 0.9, avg_logprob: -1.2 }] }), { text: 'one' });
  assert.deepEqual(heard({ text: '  two  words ' }), { text: 'two words' });
  assert.deepEqual(speechModels([{ id: 'models/whisper-1' }, { id: 'whisper-1' }, {}, null]), ['whisper-1']);
  assert.doesNotMatch(cleanupPrompt('clean', []), /Spell these/);
});
