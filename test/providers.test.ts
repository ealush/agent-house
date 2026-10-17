import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, logoFor, OTHER, PROVIDERS, providerFor, switchProvider } from '../web/providers.ts';

test('the common providers are there, each a full OpenAI-compatible setup', () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    ['claude', 'openai', 'gemini', 'muse'],
  );
  for (const p of PROVIDERS) {
    assert.match(p.baseUrl, /^https:\/\/[^/]+\/.+[^/]$/, `${p.id}: https, a path, no trailing slash`);
    assert.ok(p.model && p.name, `${p.id}: a name and a model to start with`);
    assert.match(p.keyUrl, /^https:\/\//, `${p.id}: where to get a key`);
    assert.match(p.envName, /^[A-Z_]+$/, `${p.id}: a variable to suggest`);
  }
});

test('picking a provider fills its endpoint, name and model; Other leaves them blank', () => {
  const c = blank('claude');
  assert.equal(c.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(c.name, 'Claude');
  assert.equal(c.envName, '', 'never hands the key to sessions unasked');
  assert.deepEqual([blank(OTHER).baseUrl, blank(OTHER).name, blank(OTHER).model], ['', '', '']);
});

test('switching providers keeps what was typed and replaces what was filled', () => {
  const g = switchProvider(blank('claude'), 'gemini');
  assert.deepEqual([g.name, g.model, g.baseUrl], ['Gemini', 'gemini-3.8-flash', 'https://generativelanguage.googleapis.com/v1beta/openai']);
  const typed = switchProvider({ ...blank('claude'), name: 'Work', model: 'claude-opus-5-5', apiKey: 'sk' }, 'openai');
  assert.deepEqual([typed.name, typed.model, typed.apiKey, typed.baseUrl], ['Work', 'claude-opus-5-5', 'sk', 'https://api.openai.com/v1']);
  const other = switchProvider(blank('openai'), OTHER);
  assert.deepEqual([other.name, other.model, other.baseUrl], ['', '', '']);
});

test('a saved endpoint maps back to its provider', () => {
  assert.equal(providerFor('https://api.openai.com/v1/'), 'openai');
  assert.equal(providerFor('HTTPS://api.meta.ai/v1'), 'muse');
  assert.equal(providerFor('http://localhost:11434/v1'), OTHER);
});

test('a subscription shows its provider mark, or the one its model names', () => {
  assert.equal(logoFor('https://api.anthropic.com/v1', 'anything'), 'claude');
  assert.equal(logoFor('https://openrouter.ai/api/v1', 'x-ai/grok-5'), 'grok');
  assert.equal(logoFor('https://openrouter.ai/api/v1', 'openai/gpt-6-luna'), 'codex');
  assert.equal(logoFor('http://localhost:11434/v1', 'qwen3'), null);
});
