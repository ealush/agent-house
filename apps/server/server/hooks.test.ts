import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooksStatus, installClaude, installCodex, uninstallClaude, uninstallCodex } from './hooks.ts';

test('installing and removing hooks keeps your own hooks and backs files up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-hooks-'));
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  process.env.CODEX_HOME = join(dir, 'codex');
  const settings = join(dir, 'claude', 'settings.json');
  installClaude(); // creates the file
  writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  installClaude();
  installCodex();
  const s = hooksStatus();
  assert.equal(s.claude.wired, s.claude.of);
  assert.equal(s.codex.wired, true);
  const written = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(written.model, 'opus');
  assert.ok(written.hooks.Stop.some((g: any) => g.hooks.some((h: any) => h.command === 'say done')), 'your hook stays');
  assert.ok(existsSync(`${settings}.ah-backup`));
  uninstallClaude();
  uninstallCodex();
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual(after.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });
  assert.equal(hooksStatus().codex.wired, false);
  assert.equal(hooksStatus().claude.wired, 0);
});
