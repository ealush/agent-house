import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch } from '../web/patch.ts';

const patch = `diff --git a/README.md b/README.md
index 1..2 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Hello
+
+More.
@@ -40,3 +41,4 @@
 a
+b
@@ -90,2 +91,3 @@ function render() {
 c
+d
`;

test("hunks say where they are, and a file's first one at its top is left out", () => {
  const [f] = parsePatch(patch);
  const hunks = f.lines.filter((l) => l.kind === 'hunk').map((l) => l.text);
  assert.deepEqual(hunks, ['Line 41', '… function render() {']);
  assert.equal(f.lines[0].text, '# Hello');
  assert.equal(f.add, 4);
});
