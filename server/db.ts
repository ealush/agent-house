// One SQLite file per host for ah's durable state, through Prisma.
// The file (and its directory) are created owner-only before first use.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);

export function defaultDbPath(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'ah.db');
}

const clients = new Map<string, PrismaClient>();

function prepareFile(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/** Shared client per path. Callers must not $disconnect a shared client. */
export function getDb(path = defaultDbPath()): PrismaClient {
  let client = clients.get(path);
  if (!client) {
    prepareFile(path);
    client = new PrismaClient({ datasourceUrl: `file:${path}` });
    clients.set(path, client);
  }
  return client;
}

/** Drop every cached client (tests only — the server never disconnects). */
export async function disconnectAll(): Promise<void> {
  for (const [path, client] of clients) {
    clients.delete(path);
    await client.$disconnect().catch(() => {});
  }
}

/**
 * Has the database already applied every committed migration, unchanged? Read
 * straight from Prisma's own bookkeeping table (the checksum is the sha256 of
 * migration.sql), so the usual restart skips spawning the Prisma CLI.
 */
export async function upToDate(path: string, migrations: string): Promise<boolean> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').all() as Array<{ migration_name: string; checksum: string }>;
      const applied = new Map(rows.map((r) => [r.migration_name, r.checksum]));
      const dirs = readdirSync(migrations, { withFileTypes: true }).filter((d) => d.isDirectory());
      return dirs.every((d) => applied.get(d.name) === createHash('sha256').update(readFileSync(join(migrations, d.name, 'migration.sql'))).digest('hex'));
    } finally {
      db.close();
    }
  } catch {
    return false; // no table yet (a new database), or unreadable: let Prisma decide
  }
}

/** Apply committed migrations; refuses to start the server without a database. */
export async function ensureMigrated(path = defaultDbPath()): Promise<void> {
  prepareFile(path);
  const schema = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'schema.prisma');
  if (await upToDate(path, join(dirname(schema), 'migrations'))) return;
  const prismaPkg = require.resolve('prisma/package.json');
  const cli = join(dirname(prismaPkg), 'build', 'index.js');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, 'migrate', 'deploy', '--schema', schema],
      // CHECKPOINT_DISABLE: no update check against Prisma's servers on every boot.
      { env: { ...process.env, DATABASE_URL: `file:${path}`, CHECKPOINT_DISABLE: '1' }, timeout: 120_000 },
      (err, stdout, stderr) => (err ? reject(new Error(`prisma migrate deploy failed: ${stderr || stdout || err.message}`)) : resolve()),
    );
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
  });
}
