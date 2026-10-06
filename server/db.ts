// One SQLite file per host for ah's durable state, through Prisma.
// The file (and its directory) are created owner-only before first use.
import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
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

/** Apply committed migrations; refuses to start the server without a database. */
export async function ensureMigrated(path = defaultDbPath()): Promise<void> {
  prepareFile(path);
  const prismaPkg = require.resolve('prisma/package.json');
  const cli = join(dirname(prismaPkg), 'build', 'index.js');
  const schema = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'schema.prisma');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, 'migrate', 'deploy', '--schema', schema],
      { env: { ...process.env, DATABASE_URL: `file:${path}` }, timeout: 120_000 },
      (err, stdout, stderr) => (err ? reject(new Error(`prisma migrate deploy failed: ${stderr || stdout || err.message}`)) : resolve()),
    );
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
  });
}
