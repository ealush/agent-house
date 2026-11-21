import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page shows a "restart ah" banner when state.api < web API_VERSION.
// If the two constants drift apart, a newer page hits unknown routes on an
// older server and fails cryptically instead (e.g. branch switching 404s).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function version(file: string): number {
  const m = readFileSync(join(root, file), 'utf8').match(/export const API_VERSION = (\d+);/);
  assert.ok(m, `${file} must export API_VERSION`);
  return Number(m[1]);
}

test('page and server agree on API_VERSION', () => {
  assert.equal(version('web/api.ts'), version('server/core.ts'));
});
