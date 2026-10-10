import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileScore, frontMatter, slashCommands } from './complete.ts';

test('front matter reads plain and folded descriptions', () => {
  assert.deepEqual(frontMatter('---\nname: x\ndescription: >\n  Two\n  lines.\n---\nbody'), { name: 'x', description: 'Two lines.' });
  assert.deepEqual(frontMatter('---\ndescription: "quoted"\n---'), { description: 'quoted' });
  assert.deepEqual(frontMatter('no front matter'), {});
});

test('file names that start with the query rank first', () => {
  const files = ['web/gui/GuiSurface.tsx', 'server/sessions.ts', 'web/Session.tsx', 'docs/gui.md'];
  const ranked = files.filter((f) => fileScore('sess', f) > 0).sort((a, b) => fileScore('sess', b) - fileScore('sess', a));
  assert.deepEqual(ranked, ['web/Session.tsx', 'server/sessions.ts']);
  assert.equal(fileScore('zzz', 'web/App.tsx'), 0);
});

test('Claude offers project commands, then yours, then skills, then built-ins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-complete-'));
  const home = join(root, 'home');
  const cwd = join(root, 'proj');
  mkdirSync(join(cwd, '.claude', 'commands', 'git'), { recursive: true });
  mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills', 'crash'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'commands', 'git', 'ship.md'), '---\ndescription: Commit and push\n---\n');
  writeFileSync(join(home, '.claude', 'commands', 'standup.md'), 'Summarize yesterday\n');
  writeFileSync(join(home, '.claude', 'skills', 'crash', 'SKILL.md'), '---\nname: diagnose-crash\ndescription: Why it crashed\n---\n');
  const cmds = await slashCommands({ id: 'claude', name: 'Claude', command: 'claude' }, cwd, home);
  assert.deepEqual(cmds.slice(0, 3), [
    { name: 'git:ship', description: 'Commit and push', source: 'project' },
    { name: 'standup', description: 'Summarize yesterday', source: 'user' },
    { name: 'diagnose-crash', description: 'Why it crashed', source: 'skill' },
  ]);
  assert.ok(cmds.some((c) => c.name === 'compact' && c.source === 'built-in'));
});
