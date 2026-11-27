import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Drafts, draftParts } from './drafts.ts';

test('drafts are kept per session, cleared by blank text, and survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-drafts-'));
  try {
    const file = join(dir, 'drafts.json');
    const d = new Drafts(file);
    assert.equal(d.get('a1'), null);
    const saved = d.set('a1', 'finish the migration', 'iPhone', 'c1');
    assert.equal(saved?.text, 'finish the migration');
    assert.equal(saved?.device, 'iPhone');
    d.set('b2', 'other', 'Mac<script>', 'c2');
    assert.equal(d.get('b2')?.device, 'Macscript', 'device labels are sanitized');
    assert.equal(d.set('b2', '   ', 'Mac', 'c2'), null, 'blank text clears');
    await d.save();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['a1']);
    assert.equal(new Drafts(file).get('a1')?.text, 'finish the migration');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a draft keeps its box's chips (draftParts), and loses them when saved without", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-drafts-'));
  try {
    const file = join(dir, 'drafts.json');
    const d = new Drafts(file);
    const parts = draftParts([
      { kind: 'quote', body: 'the reply', source: 'Claude' },
      { kind: 'paste', body: 'a long log' },
      { kind: 'nope', body: 'dropped' },
      { kind: 'reuse', body: '   ' },
      'not a part',
    ]);
    assert.deepEqual(parts, [{ kind: 'quote', body: 'the reply', source: 'Claude' }, { kind: 'paste', body: 'a long log' }]);
    assert.equal(draftParts([]), undefined, 'none is no parts');
    assert.equal(draftParts('x'), undefined);
    d.set('a1', '> the reply\n\na long log\n\nwhat now?', 'iPhone', 'c1', parts);
    assert.deepEqual(d.get('a1')?.parts, parts);
    await d.save();
    assert.deepEqual(new Drafts(file).get('a1')?.parts, parts, 'kept across a restart');
    // The web box has no chips: what it saves is the text alone.
    d.set('a1', '> the reply\n\na long log\n\nwhat now? edited', 'browser', 'web');
    assert.equal(d.get('a1')?.parts, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
