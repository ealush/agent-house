// The server's dependency rules, checked (docs/architecture.md). Static: reads the import
// graph of server/, never runs it. A type-only import (`import type`) is free: it's
// erased before the code runs and can't load a module or close a cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server/', import.meta.url));

type Mod = { local: string[]; external: string[] };

function modules(): Map<string, Mod> {
  const out = new Map<string, Mod>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'fixtures') walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        const src = readFileSync(p, 'utf8');
        const local: string[] = [];
        const external: string[] = [];
        for (const m of src.matchAll(/^(?:import|export)(\s+type)?\s[^;]*?\sfrom\s'([^']+)';/gms)) {
          if (m[1]) continue;
          if (m[2].startsWith('.')) local.push(relative(SERVER, normalize(join(dirname(p), m[2]))));
          else external.push(m[2]);
        }
        out.set(relative(SERVER, p), { local, external });
      }
    }
  };
  walk(SERVER);
  return out;
}

const graph = modules();

/** Everything `from` loads when it runs. */
function closure(from: string): Set<string> {
  const seen = new Set<string>();
  const visit = (m: string) => {
    if (seen.has(m)) return;
    seen.add(m);
    for (const d of graph.get(m)?.local ?? []) visit(d);
  };
  visit(from);
  return seen;
}

/** Modules that reach the outside world on their own, rather than through a port they're handed. */
const AMBIENT_IO = /^(?:node:)?(?:fs|fs\/promises|child_process|net|http|https|os|dgram|tls|worker_threads|zlib)$|^@prisma\/|^ws$|^node-pty$|^web-push$|^@simplewebauthn\//;

function ambientIo(from: string): string[] {
  const out: string[] = [];
  for (const m of closure(from)) for (const e of graph.get(m)?.external ?? []) if (AMBIENT_IO.test(e)) out.push(`${m} → ${e}`);
  return out;
}

test('no import cycles in the server', () => {
  // Tarjan's strongly connected components over runtime imports.
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const cycles: string[][] = [];
  const connect = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v)?.local ?? []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const c: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        c.push(w);
      } while (w !== v);
      if (c.length > 1) cycles.push(c.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) connect(v);
  assert.deepEqual(cycles, []);
});

test('reading the config never loads a service or the database', () => {
  const loaded = [...closure('config.ts')].filter((m) => m !== 'config.ts');
  const external = loaded.flatMap((m) => graph.get(m)!.external).filter((e) => !e.startsWith('node:'));
  assert.deepEqual(external, [], 'config.ts pulls in a package');
  // Each context's settings live in a leaf module of its own (usage/settings.ts, …).
  for (const m of loaded) assert.ok(/(^|\/)settings\.ts$|^errors\.ts$|^uploads\.ts$|^agentgate\.ts$|^choices\.ts$/.test(m), `config.ts loads ${m}`);
});

// The functional core: decisions and transformations that take their facts as arguments
// and perform effects only through the ports they're handed (a PrismaClient passed in,
// a deps object), never by importing fs, a process, a socket or the database themselves.
// Each runs in a unit test with plain values or fakes. Add to this list; don't remove from it.
const CORE = [
  'errors.ts',
  'admission.ts',
  'stateStream.ts',
  'answers.ts',
  'features.ts',
  'choices.ts',
  'cliHelpers.ts',
  'supervision.ts',
  'fleet/mailbox.ts',
  'fleet/tasks.ts',
  'agentgate.ts',
  'launch.ts',
  'feed/schema.ts',
  'feed/parts.ts',
  'feed/adapters/claude.ts',
  'feed/adapters/codex.ts',
  'feed/adapters/grok.ts',
  'feed/adapters/hermes.ts',
  'feed/adapters/muse.ts',
  'subagents/model.ts',
  'spaces/model.ts',
  'checkouts/settings.ts',
  'checkouts/model.ts',
  'subagents/claude.ts',
  'subagents/codex.ts',
  'jobs/cron.ts',
  'jobs/scheduler.ts',
  'migrate/manifest.ts',
  'notes/store.ts',
  'notes/handoff.ts',
  'portable/schema.ts',
  'portable/handoff.ts',
  'recovery/classify.ts',
  'recovery/settings.ts',
  'review/stack.ts',
  'imagePaths.ts',
  'review/owners.ts',
  'review/view.ts',
  'usage/prices.ts',
  'usage/settings.ts',
];

test('the functional core reaches no I/O on its own', () => {
  for (const m of CORE) {
    assert.ok(graph.has(m), `${m} is listed but doesn't exist`);
    assert.deepEqual(ambientIo(m), [], `${m} reaches I/O`);
  }
});
