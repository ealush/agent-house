// The conformance suite when an agent's CLI updates (conformance/run.mjs): a new Claude Code,
// Codex, agy, Grok or Muse that changes a screen, a flag or a transcript fails there, and you're
// told, rather than finding it in a session.
//
// Each version check (Core.checkHarnesses) hands the versions it read here. The first version
// seen of an agent is only noted: a fresh install runs nothing. A different one later is run
// through the suite in the background, one run at a time (an agent updated meanwhile waits for
// the next). What each run found is kept beside the versions, and a failure is an alert.
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConformanceConfig } from './conformance/settings.ts';

export type ConformanceRecord = {
  /** The version the suite last saw (ran, or noted on first sight). */
  version: string;
  /** Its last run: when, whether every check ah owns passed, and where its report is. */
  run?: { at: string; ok: boolean; report: string; failed: number };
};

type Report = { versions?: Record<string, string | null>; failed?: number; passed?: number; total?: number; error?: string; suites?: Record<string, Array<{ ok: boolean; agent?: string; name?: string; s?: string; error?: string }>> };

export type ConformanceDeps = {
  /** Where the versions and runs are kept (…/state/ah/conformance/versions.json). */
  file: string;
  /** The reports' folder (a run's own under it). */
  reports: string;
  config: () => ConformanceConfig;
  alert: (p: { title: string; body: string; tag: string; url?: string }) => void;
  /** Runs the suite for `agents` with its report at `report`; resolves when it's done. */
  run?: (agents: string[], report: string, reason: string) => Promise<void>;
};

const RUNNER = new URL('../conformance/run.mjs', import.meta.url).pathname;

export class Conformance {
  private deps: ConformanceDeps;
  private records: Record<string, ConformanceRecord> = {};
  private running: Promise<void> | null = null;
  /** Agents updated while a run was under way: the next run's (why, and the version it's for). */
  private waiting = new Map<string, { why: string; version: string }>();
  /** The versions the run under way is for: seen again meanwhile, they aren't queued twice. */
  private current = new Map<string, string>();

  constructor(deps: ConformanceDeps) {
    this.deps = deps;
    try {
      if (existsSync(deps.file)) this.records = JSON.parse(readFileSync(deps.file, 'utf8'));
    } catch (err) {
      console.error('conformance: its record could not be read, starting afresh:', (err as Error).message);
    }
  }

  /** What the suite last saw and found, per agent. */
  status(): Record<string, ConformanceRecord> {
    return structuredClone(this.records);
  }

  /** After a version check: each covered agent's version as its CLI says it. */
  versions(seen: Record<string, string | null | undefined>): void {
    const c = this.deps.config();
    const changed = new Map<string, { why: string; version: string }>();
    for (const agent of c.agents) {
      const version = seen[agent];
      if (!version) continue;
      const before = this.records[agent]?.version;
      if (before === version || this.current.get(agent) === version || this.waiting.get(agent)?.version === version) continue;
      // First sight is the baseline; and with the suite off, versions are only noted, so
      // turning it on later doesn't run it for updates long past.
      if (before !== undefined && c.onUpdate) changed.set(agent, { why: `${before} → ${version}`, version });
      else this.records[agent] = { ...this.records[agent], version };
    }
    this.save();
    if (!changed.size) return;
    for (const [a, v] of changed) this.waiting.set(a, v);
    this.next(seen);
  }

  private next(seen: Record<string, string | null | undefined>) {
    if (this.running || !this.waiting.size) return;
    const batch = new Map(this.waiting);
    this.waiting.clear();
    const agents = [...batch.keys()];
    this.current = new Map([...batch].map(([a, v]) => [a, v.version]));
    const reason = [...batch].map(([a, v]) => `${a} ${v.why}`).join(', ');
    const report = join(this.deps.reports, new Date().toISOString().replace(/[:.]/g, '-'));
    console.log(`conformance: ${reason}: running the suite (${report})`);
    const run = this.deps.run ?? runSuite;
    this.running = run(agents, report, reason)
      .catch((err) => console.error('conformance: the run failed to start:', (err as Error).message))
      .then(() => this.settle(agents, report, seen))
      .finally(() => {
        this.running = null;
        this.current.clear();
        this.next(seen);
      });
  }

  private settle(agents: string[], report: string, seen: Record<string, string | null | undefined>) {
    let r: Report | null = null;
    try {
      r = JSON.parse(readFileSync(join(report, 'report.json'), 'utf8'));
    } catch {}
    const at = new Date().toISOString();
    const failed = r ? (r.failed ?? 0) : 1;
    for (const a of agents) {
      const version = r?.versions?.[a] ?? seen[a] ?? this.records[a]?.version;
      if (version) this.records[a] = { version, run: { at, ok: failed === 0, report, failed } };
    }
    this.save();
    if (!failed) {
      console.log(`conformance: ${agents.join(', ')}: ${r?.passed}/${r?.total} passed`);
      return;
    }
    const names = agents.map((a) => `${a} ${r?.versions?.[a] ?? seen[a] ?? ''}`.trim()).join(', ');
    const fails = Object.values(r?.suites ?? {})
      .flat()
      .filter((x) => !x.ok)
      .map((x) => `${x.agent ?? ''} ${x.name ?? x.s ?? ''}`.trim());
    const body = r ? `${failed} check${failed === 1 ? '' : 's'} failed: ${fails.slice(0, 3).join('; ')}${fails.length > 3 ? '…' : ''}. Report: ${report}` : `The suite didn't finish. Report: ${report}`;
    console.warn(`conformance: ${names}: ${body}`);
    this.deps.alert({ title: `${names} may not work with ah`, body, tag: 'conformance' });
  }

  private save() {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify(this.records, null, 2));
      renameSync(`${this.deps.file}.tmp`, this.deps.file);
    } catch (err) {
      console.error('conformance: its record could not be saved:', (err as Error).message);
    }
  }
}

/** The runner as a child of ah: your environment without ah's own (it starts a host of its own). */
function runSuite(agents: string[], report: string, reason: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AH_') && k !== 'TMUX' && k !== 'TMUX_PANE'));
    const child = spawnProcess(process.execPath, [RUNNER, '--agents', agents.join(','), '--report', report, '--reason', reason], { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}
