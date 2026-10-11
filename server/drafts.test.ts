import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Drafts } from './drafts.ts';

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
