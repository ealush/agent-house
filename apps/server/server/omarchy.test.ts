import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { omarchyStamp, omarchyTheme, parseColors } from './omarchy.ts';

const TOKYO = 'mode = "dark"\n\naccent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\n# comment\nred = "#F7768E"\nnot_a_color = "x"\n';

test('reads an Omarchy colors.toml', () => {
  const { mode, colors } = parseColors(TOKYO);
  assert.equal(mode, 'dark');
  assert.deepEqual(colors, { accent: '#7aa2f7', background: '#1a1b26', foreground: '#a9b1d6', red: '#f7768e' });
  assert.equal(parseColors('mode = "light"').mode, 'light');
});

test('the applied theme, or null without Omarchy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-omarchy-'));
  process.env.OMARCHY_STATE_DIR = dir;
  assert.equal(omarchyTheme(), null);
  assert.equal(omarchyStamp(), null);
  mkdirSync(join(dir, 'theme'));
  writeFileSync(join(dir, 'theme', 'colors.toml'), TOKYO);
  writeFileSync(join(dir, 'theme.name'), 'tokyo-night\n');
  assert.equal(omarchyTheme()?.name, 'tokyo-night');
  assert.equal(omarchyTheme()?.colors.accent, '#7aa2f7');
  assert.equal(omarchyStamp()?.name, 'tokyo-night');
  delete process.env.OMARCHY_STATE_DIR;
});
