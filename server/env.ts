// Session environment (Settings → Environment): variables every session
// window starts with, so an agent can reach a key or a tool's config without
// it living in a shell profile. Chat subscriptions can hand their key to
// sessions the same way (Subscription.envName), so one key serves side chat
// and the agents alike.
//
// Values reach the window through `tmux new-window -e`, so they apply to
// sessions started, resumed or relaunched after a change; a running process
// keeps the environment it started with. Each launch records a fingerprint of
// what it got (meta 'ah.env'), which is how Settings can name the sessions
// that started before a change.
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { defaultDbPath, getDb } from './db.ts';
import { HttpError } from './http.ts';

export class EnvError extends HttpError {}

export type EnvVarInfo = {
  name: string;
  /** Null for a secret: it is never sent back once saved. */
  value: string | null;
  secret: boolean;
};
/** A variable a chat subscription hands to sessions: its key, under envName. */
export type EnvExport = { name: string; subscriptionId: string; subscription: string };

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE = 8192;
const MAX_VARS = 100;
// tmux, the shell and ah set these per window; a fixed value would break the
// session (PATH can't be extended without a shell, so it would replace tmux's).
const RESERVED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'PWD', 'OLDPWD', 'SHLVL', 'TMUX', 'TMUX_PANE']);

/** Throws an EnvError naming what's wrong with a variable name. */
export function checkName(name: string): void {
  if (!ENV_NAME.test(name)) throw new EnvError(400, 'use letters, digits and underscores, not starting with a digit');
  if (RESERVED.has(name.toUpperCase())) throw new EnvError(400, `${name} is set by the shell or tmux for each session; set it in your shell profile instead`);
}

/** Names that look like credentials start out secret in the form. */
export function looksSecret(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH/i.test(name);
}

/** Short, order-independent digest of an environment; '' when empty. */
export function fingerprint(env: Record<string, string>): string {
  const names = Object.keys(env).sort();
  if (!names.length) return '';
  const h = createHash('sha256');
  for (const n of names) h.update(`${n}\0${env[n]}\0`);
  return h.digest('hex').slice(0, 16);
}

export class EnvStore {
  private db: PrismaClient;

  constructor(dbPath = process.env.AH_DB_FILE ?? defaultDbPath()) {
    this.db = getDb(dbPath);
  }

  async list(): Promise<{ vars: EnvVarInfo[]; exports: EnvExport[] }> {
    const [vars, subs] = await Promise.all([
      this.db.envVar.findMany({ orderBy: { name: 'asc' } }),
      this.db.subscription.findMany({ where: { envName: { not: null } }, select: { id: true, name: true, envName: true }, orderBy: { envName: 'asc' } }),
    ]);
    return {
      vars: vars.map((v) => ({ name: v.name, value: v.secret ? null : v.value, secret: v.secret })),
      exports: subs.map((s) => ({ name: s.envName!, subscriptionId: s.id, subscription: s.name })),
    };
  }

  /**
   * Create or update one variable. A blank value on an existing secret keeps
   * the stored one, like subscription keys; turning a secret visible needs
   * the value again, so the API never reveals a stored secret.
   */
  async put(input: { name: string; value?: string; secret: boolean }): Promise<EnvVarInfo> {
    const name = input.name.trim();
    checkName(name);
    if (input.value !== undefined && (input.value.length > MAX_VALUE || input.value.includes('\0'))) throw new EnvError(400, 'value too long or not text');
    const sub = await this.db.subscription.findFirst({ where: { envName: name }, select: { name: true } });
    if (sub) throw new EnvError(409, `${name} already comes from the "${sub.name}" subscription`);
    const existing = await this.db.envVar.findUnique({ where: { name } });
    let value = input.value ?? '';
    if (existing && value === '' && existing.secret) {
      if (!input.secret) throw new EnvError(400, 'enter the value to make it visible');
      value = existing.value;
    }
    if (!existing && (await this.db.envVar.count()) >= MAX_VARS) throw new EnvError(400, `at most ${MAX_VARS} variables`);
    const row = await this.db.envVar.upsert({ where: { name }, create: { name, value, secret: input.secret }, update: { value, secret: input.secret } });
    return { name: row.name, value: row.secret ? null : row.value, secret: row.secret };
  }

  async remove(name: string): Promise<void> {
    try {
      await this.db.envVar.delete({ where: { name } });
    } catch {
      throw new EnvError(404, 'variable not found');
    }
  }

  /** What a new session window starts with: saved variables plus subscription keys. */
  async forLaunch(): Promise<Record<string, string>> {
    const [vars, subs] = await Promise.all([
      this.db.envVar.findMany(),
      this.db.subscription.findMany({ where: { envName: { not: null } }, select: { envName: true, apiKey: true } }),
    ]);
    const env: Record<string, string> = {};
    for (const v of vars) env[v.name] = v.value;
    for (const s of subs) if (s.envName && s.apiKey) env[s.envName] = s.apiKey;
    return env;
  }
}
