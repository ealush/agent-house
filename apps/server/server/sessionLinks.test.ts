import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkHints, withoutLinkHints, isLinkHint } from './sessionLinks.ts';
import { needleFor } from './feed/landed.ts';
import { ADAPTERS } from './feed/feed.ts';

const titles: Record<string, string> = { abcd1234: 'Rust migration plan' };
const title = (uid: string) => titles[uid] ?? null;

test("a session's link in a message gets a line naming it and how to read it", () => {
  const sent = linkHints('Look at what we did in https://box.ts.net/#abcd1234 and https://box.ts.net/#abcd1234?m=12 first', title, 'ah');
  assert.equal(
    sent,
    'Look at what we did in https://box.ts.net/#abcd1234 and https://box.ts.net/#abcd1234?m=12 first\n\n' +
      '[ah: https://box.ts.net/#abcd1234 is the ah session "Rust migration plan". Print its conversation with: ah conversation abcd1234]',
    'one line per session, however often it is linked',
  );
  // Not a session here, or no link at all: as it was.
  assert.equal(linkHints('see https://box.ts.net/#zzzz9999', title, 'ah'), 'see https://box.ts.net/#zzzz9999');
  assert.equal(linkHints('see https://example.com/docs#intro', title, 'ah'), 'see https://example.com/docs#intro');
  // Said already (a message sent again): not twice.
  assert.equal(linkHints(sent, title, 'ah'), sent);
});

test('the line is the agent’s to read: messages read back without it, and delivery is matched without it', () => {
  const typed = 'Compare with https://box.ts.net/#abcd1234';
  const sent = linkHints(typed, title, '/usr/bin/node /srv/ah/bin/ah.js');
  assert.notEqual(sent, typed);
  assert.equal(withoutLinkHints(sent), typed);
  assert.ok(isLinkHint(sent.split('\n').at(-1)!));
  assert.equal(withoutLinkHints('a message\n\n[ah: something else]'), 'a message\n\n[ah: something else]', 'only its own lines');
  // The longest line would be the hint: the needle comes from what was typed.
  assert.equal(needleFor(sent), needleFor(typed));
  // A transcript's user message, as every list and bubble reads it.
  const line = { type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: sent } };
  const entry = ADAPTERS.claude(line, 1)!;
  assert.deepEqual(entry.parts, [{ type: 'text', text: typed }]);
});
