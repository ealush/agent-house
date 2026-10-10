import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// "Send now" is not destructive (the message was already queued to be sent),
// so it must fire immediately without a confirm dialog.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = readFileSync(join(root, 'web', 'Queue.tsx'), 'utf8');

test('send-now delivers without a confirm dialog', () => {
  assert.doesNotMatch(tsx, /askConfirm/, 'no confirm import or call remains in Queue.tsx');
  assert.ok(tsx.includes('client.sendNow'), 'send-now still calls client.sendNow');
});
