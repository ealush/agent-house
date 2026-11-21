#!/usr/bin/env node
// The database schema and its migrations agree: `prisma validate`, then the committed
// migrations replayed into a throwaway SQLite file and diffed against schema.prisma.
//
//   node scripts/prisma-check.mjs      (pnpm prisma:check)
//
// ah keeps a few tables Prisma doesn't model: full-text search (FTS5 virtual tables and the
// shadow tables SQLite makes for them) and their bookkeeping, created by raw SQL in the
// migrations (server/search.ts reads them directly). Prisma's diff always proposes dropping
// those; they're allowed, derived from the migrations themselves. Any other difference is a
// schema change without its migration (or the reverse), and fails. Never touches a real
// database: the shadow file lives in a temporary folder that's removed after.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const schema = join(root, 'prisma', 'schema.prisma');
const migrations = join(root, 'prisma', 'migrations');
const cli = join(dirname(createRequire(import.meta.url).resolve('prisma/package.json')), 'build', 'index.js');
const tmp = mkdtempSync(join(tmpdir(), 'ah-prisma-check-'));
// DATABASE_URL is always the throwaway file, whatever the environment says.
const env = { ...process.env, CHECKPOINT_DISABLE: '1', DATABASE_URL: `file:${join(tmp, 'validate.db')}` };
function prisma(...args) {
  try {
    return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(`prisma ${args[0]} failed:\n${err.stderr || err.stdout || err.message}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

try {
  prisma('validate', '--schema', schema);
  console.log('prisma validate: the schema is valid');

  const models = new Set([...readFileSync(schema, 'utf8').matchAll(/^model (\w+) \{/gm)].map((m) => m[1]));
  const sql = readdirSync(migrations, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => readFileSync(join(migrations, d.name, 'migration.sql'), 'utf8')).join('\n');
  const raw = new Set();
  for (const m of sql.matchAll(/CREATE (VIRTUAL )?TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gi)) {
    if (models.has(m[2])) continue;
    raw.add(m[2]);
    if (m[1]) for (const suffix of ['config', 'content', 'data', 'docsize', 'idx']) raw.add(`${m[2]}_${suffix}`);
  }

  const script = prisma('migrate', 'diff', '--from-migrations', migrations, '--to-schema-datamodel', schema, '--shadow-database-url', `file:${join(tmp, 'shadow.db')}`, '--script');
  const statements = script.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--') && !/^PRAGMA foreign_keys=(on|off);$/i.test(l));
  const drift = statements.filter((s) => !(/^DROP TABLE "(\w+)";$/.test(s) && raw.has(s.match(/^DROP TABLE "(\w+)";$/)[1])));
  if (drift.length) {
    console.error('prisma migrations: schema.prisma and prisma/migrations disagree. Add a migration for the schema change (or fix the schema):');
    for (const s of drift) console.error(`  ${s}`);
    process.exit(1);
  }
  console.log(`prisma migrations: ${readdirSync(migrations).filter((n) => !n.endsWith('.toml')).length} migrations reproduce the schema (${raw.size} raw-SQL search tables aside)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
