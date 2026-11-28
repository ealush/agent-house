import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conformance } from './conformance.ts';
import { DEFAULT_CONFORMANCE, type ConformanceConfig } from './conformance/settings.ts';

/** A Conformance whose runs write the report given, and say who they were for. */
function setup(o: { config?: Partial<ConformanceConfig>; report?: (agents: string[]) => object } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-conf-'));
  const runs: Array<{ agents: string[]; reason: string }> = [];
  const alerts: Array<{ title: string; body: string }> = [];
  let release: () => void = () => {};
  let hold = false;
  const config = { ...DEFAULT_CONFORMANCE, ...o.config };
  const make = () =>
    new Conformance({
      file: join(dir, 'versions.json'),
      reports: dir,
      config: () => config,
      alert: (p) => void alerts.push(p),
      run: async (agents, report, reason) => {
        runs.push({ agents, reason });
        if (hold) await new Promise<void>((r) => (release = r));
        mkdirSync(report, { recursive: true });
        writeFileSync(join(report, 'report.json'), JSON.stringify(o.report?.(agents) ?? { failed: 0, passed: 4, total: 4, versions: {} }));
      },
    });
  return { make, runs, alerts, config, hold: () => (hold = true), release: () => release() };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('the first version seen is noted, not run; a new one is run through the suite, that agent alone', async () => {
  const s = setup();
  const c = s.make();
  c.versions({ claude: '2.1.300', codex: '0.162.1' });
  await settle();
  assert.deepEqual(s.runs, [], 'a fresh install runs nothing');
  c.versions({ claude: '2.1.300', codex: '0.162.1' });
  await settle();
  assert.deepEqual(s.runs, []);
  c.versions({ claude: '2.1.301', codex: '0.162.1' });
  await settle();
  assert.deepEqual(s.runs, [{ agents: ['claude'], reason: 'claude 2.1.300 → 2.1.301' }]);
  assert.equal(c.status().claude.version, '2.1.301');
  assert.equal(c.status().claude.run?.ok, true);
  assert.deepEqual(s.alerts, [], 'a pass says nothing');
  // Kept across an ah restart: the same version isn't run again.
  s.make().versions({ claude: '2.1.301', codex: '0.162.1' });
  await settle();
  assert.equal(s.runs.length, 1);
});

test('one run at a time: an agent updated meanwhile is the next run', async () => {
  const s = setup();
  const c = s.make();
  c.versions({ claude: '1', codex: '1' });
  s.hold();
  c.versions({ claude: '2', codex: '1' });
  await settle();
  c.versions({ claude: '2', codex: '2' });
  await settle();
  assert.deepEqual(s.runs.map((r) => r.agents), [['claude']], 'not two at once');
  s.release();
  await settle();
  s.release();
  await settle();
  assert.deepEqual(s.runs.map((r) => r.agents), [['claude'], ['codex']]);
});

test('a failed run is an alert naming the version and what failed', async () => {
  const s = setup({ report: () => ({ failed: 2, passed: 6, total: 8, versions: { codex: 'codex-cli 0.163.0' }, suites: { capabilities: [{ ok: false, agent: 'codex', name: 'queue' }, { ok: false, agent: 'codex', name: 'fork' }, { ok: true }] } }) });
  const c = s.make();
  c.versions({ codex: 'codex-cli 0.162.1' });
  c.versions({ codex: 'codex-cli 0.163.0' });
  await settle();
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].title, /codex codex-cli 0\.163\.0/);
  assert.match(s.alerts[0].body, /2 checks failed: codex queue; codex fork/);
  assert.equal(c.status().codex.run?.ok, false);
});

test('with the suite off, versions are noted and nothing runs, nor later for updates long past', async () => {
  const s = setup({ config: { onUpdate: false } });
  const c = s.make();
  c.versions({ claude: '1' });
  c.versions({ claude: '2' });
  await settle();
  assert.deepEqual(s.runs, []);
  s.config.onUpdate = true;
  c.versions({ claude: '2' });
  await settle();
  assert.deepEqual(s.runs, [], 'turned on, it starts from the version now');
  c.versions({ claude: '3' });
  await settle();
  assert.equal(s.runs.length, 1);
});
