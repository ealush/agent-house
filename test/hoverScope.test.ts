import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Hover is the pointer's, not a finger's tap left behind (web/pointer.ts): every
// selector with :hover in it is scoped :where(:root:not([data-touch])), which adds
// no specificity. Browser scrollbars (::-webkit-scrollbar…) have no element to scope.
const SHEETS = ['web/styles.css', 'web/gui/gui.css', 'web/review/review.css', 'web/site-theme.css'];
const SCOPE = ':where(:root:not([data-touch])) ';

test('every :hover rule is scoped to a pointer, never a finger', () => {
  const bad: string[] = [];
  for (const f of SHEETS) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    css.split('\n').forEach((line, i) => {
      const sel = line.trim();
      if (!sel.includes(':hover') || !/[,{]$/.test(sel) || sel.startsWith('::')) return;
      if (!sel.startsWith(SCOPE)) bad.push(`${f}:${i + 1}  ${sel}`);
    });
  }
  assert.deepEqual(bad, [], `Scope these with ${SCOPE.trim()}`);
});
