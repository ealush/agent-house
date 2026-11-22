// The developer log (Settings → System → Developer): what this host did, as JSON lines,
// for you or an agent to read back while debugging. Off until you turn it on. Each day
// writes to a folder of its own (logs/2026-11-22/server.jsonl); folders older than the
// last KEEP_DAYS days are deleted. Devices send their own logs as bundles, kept beside the
// host's in the same day's folder (client-*.jsonl), whether or not the host's log is on.
//
// What goes in: starts and stops (and whether the run before ended cleanly), restarts and
// rebuilds asked for, every API request (method, path, status, time; secrets in a query
// are redacted), messages sent (their words, capped, and attachments' sizes, never their
// bytes), the queue's moves, uploads' sizes, terminals, warnings and errors. Never
// cookies, tokens, setup codes or what a file holds.
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

/** Day folders kept: today's and the two before it. */
export const KEEP_DAYS = 3;
/** A sent message's words are kept up to this many characters. */
export const TEXT_KEEP = 2000;
/** The most entries one client bundle may carry. */
export const BUNDLE_ENTRIES = 50_000;

export type LogEntry = { at: string; kind: string } & Record<string, unknown>;
export type LogFile = { name: string; bytes: number };
export type LogDay = { day: string; files: LogFile[] };
export type LoggingStatus = { server: boolean; dir: string; keepDays: number; days: LogDay[] };
export type ClientInfo = { app: string; device: string; version: string; build: string; os: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of `t`, as its folder is named (2026-11-22). */
export function dayOf(t: Date): string {
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** The day folders past keeping on `today`: every one older than its KEEP_DAYS last days. Pure. */
export function expired(days: readonly string[], today: Date, keep = KEEP_DAYS): string[] {
  const oldest = dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (keep - 1)));
  return days.filter((d) => DAY.test(d) && d < oldest);
}

const SECRET_PARAM = /token|code|secret|key|password|auth|sig|cookie/i;

/** A path with its query, each secret-looking value replaced. Pure. */
export function redactedPath(pathname: string, search: URLSearchParams): string {
  const parts = [...search].map(([k, v]) => `${encodeURIComponent(k)}=${SECRET_PARAM.test(k) ? '…' : encodeURIComponent(v.slice(0, 200))}`);
  return parts.length ? `${pathname}?${parts.join('&')}` : pathname;
}

/** A name safe as part of a file name. Pure. */
export const slug = (s: string, max = 32) => s.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, max) || 'device';

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A client bundle's sender, from what it says about itself. Pure. */
export function clientInfo(v: unknown): ClientInfo {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { app: clip(o.app, 16) || 'client', device: clip(o.device, 64), version: clip(o.version, 32), build: clip(o.build, 32), os: clip(o.os, 64) };
}

const FILE_PATH = /(?:^|\s)((?:~|\/)[^\s'"`]+\.\w{1,8})(?=[\s'"`]|$)/g;

/** The files a message names by path (its attachments), with their sizes: never what they hold. */
export async function attachmentsIn(text: string): Promise<{ ext: string; bytes: number | null }[]> {
  const out: { ext: string; bytes: number | null }[] = [];
  for (const m of [...text.matchAll(FILE_PATH)].slice(0, 20)) {
    const path = m[1].startsWith('~/') ? join(homedir(), m[1].slice(2)) : m[1];
    const s = await stat(path).catch(() => null);
    if (s && !s.isFile()) continue;
    out.push({ ext: (m[1].match(/\.(\w{1,8})$/)?.[1] ?? '').toLowerCase(), bytes: s ? s.size : null });
  }
  return out;
}

/** A message as the log keeps it: its length, its words up to TEXT_KEEP, its attachments' sizes. */
export async function messageDetail(text: string): Promise<Record<string, unknown>> {
  const files = await attachmentsIn(text);
  return {
    chars: text.length,
    text: text.length > TEXT_KEEP ? `${text.slice(0, TEXT_KEEP)}…` : text,
    ...(files.length ? { attachments: files, attachmentBytes: files.reduce((n, f) => n + (f.bytes ?? 0), 0) } : {}),
  };
}

type Previous = { pid: number; startedAt: string; ended?: string; signal?: string };

export class DevLog {
  private on = false;
  private root = '';
  private settingsFile = '';
  private runFile = '';
  private ready = false;
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private today = '';
  private now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /**
   * Where the log lives and whether it's on (read from logging.json). Until this runs the
   * log is off, so tests and tools that import a module that logs never write anywhere.
   */
  init(stateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah')) {
    this.root = join(stateDir, 'logs');
    this.settingsFile = join(stateDir, 'logging.json');
    this.runFile = join(stateDir, 'logging-run.json');
    try {
      this.on = JSON.parse(readFileSync(this.settingsFile, 'utf8')).server === true;
    } catch {
      this.on = false;
    }
    this.ready = true;
    void this.prune().catch(() => {});
    setInterval(() => void this.prune().catch(() => {}), 3600_000).unref();
  }

  get enabled() {
    return this.on;
  }

  get dir() {
    return this.root;
  }

  /** Turn the host's log on or off; kept across restarts. */
  set(on: boolean) {
    if (!this.ready) return;
    if (this.on && !on) this.event('logging', { on: false });
    this.on = on;
    mkdirSync(join(this.settingsFile, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(this.settingsFile, JSON.stringify({ server: on }) + '\n', { mode: 0o600 });
    if (on) this.event('logging', { on: true });
  }

  /** One thing that happened. Nothing happens while the log is off. */
  event(kind: string, detail: Record<string, unknown> = {}) {
    if (!this.on) return;
    const at = this.now();
    let line: string;
    try {
      line = JSON.stringify({ at: at.toISOString(), kind, ...detail });
    } catch {
      line = JSON.stringify({ at: at.toISOString(), kind, unserializable: true });
    }
    const day = dayOf(at);
    if (day !== this.today) {
      this.flush();
      this.today = day;
      void this.prune().catch(() => {});
    }
    this.pending.push(line);
    this.timer ??= setTimeout(() => this.flush(), 250);
  }

  /** Something failed: its message and, for a thrown error, its stack. */
  error(where: string, err: unknown, detail: Record<string, unknown> = {}) {
    const e = err as { message?: string; stack?: string; code?: string } | null;
    this.event('error', { where, message: e?.message ?? String(err), ...(e?.code ? { code: e.code } : {}), ...(e?.stack ? { stack: e.stack } : {}), ...detail });
  }

  /** Written out now, in the background. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length || !this.ready) return;
    const lines = this.pending.join('\n') + '\n';
    const dir = join(this.root, this.today || dayOf(this.now()));
    this.pending = [];
    this.writing = this.writing.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(join(dir, 'server.jsonl'), lines, { mode: 0o600 });
    }).catch(() => {});
  }

  /** Written out before this returns: the process is about to exit. */
  flushSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length || !this.ready) return;
    const dir = join(this.root, this.today || dayOf(this.now()));
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, 'server.jsonl'), this.pending.join('\n') + '\n', { mode: 0o600 });
    } catch {}
    this.pending = [];
  }

  /** Everything written so far is on disk (tests). */
  async settled() {
    this.flush();
    await this.writing;
  }

  /** Delete the day folders past keeping. */
  async prune() {
    if (!this.root) return;
    const days = await readdir(this.root).catch(() => [] as string[]);
    for (const d of expired(days, this.now())) await rm(join(this.root, d), { recursive: true, force: true });
  }

  /** Warnings and errors the server prints go in the log too (console.log can hold a setup code; it doesn't). */
  teeConsole() {
    for (const level of ['warn', 'error'] as const) {
      const print = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        print(...args);
        if (this.on) this.event(level, { message: format(...args).slice(0, 8000) });
      };
    }
    process.on('uncaughtExceptionMonitor', (err, origin) => {
      this.error('process', err, { origin });
      this.flushSync();
    });
  }

  /** This run started: logged with how the one before it ended, then remembered for the next. */
  started(detail: Record<string, unknown>) {
    let previous: Previous | null = null;
    try {
      previous = JSON.parse(readFileSync(this.runFile, 'utf8'));
    } catch {}
    const run: Previous = { pid: process.pid, startedAt: this.now().toISOString() };
    try {
      writeFileSync(this.runFile, JSON.stringify(run) + '\n', { mode: 0o600 });
    } catch {}
    this.event('start', {
      pid: process.pid,
      node: process.version,
      ...detail,
      previous: previous ? { pid: previous.pid, startedAt: previous.startedAt, ended: previous.ended ? 'cleanly' : 'without shutting down (crash, kill or power loss)', ...(previous.signal ? { signal: previous.signal } : {}) } : null,
    });
  }

  /** This run is ending on its own terms. */
  stopping(signal: string) {
    this.event('stop', { pid: process.pid, signal, uptimeSec: Math.round(process.uptime()) });
    try {
      const run = JSON.parse(readFileSync(this.runFile, 'utf8')) as Previous;
      writeFileSync(this.runFile, JSON.stringify({ ...run, ended: this.now().toISOString(), signal }) + '\n', { mode: 0o600 });
    } catch {}
    this.flushSync();
  }

  /** What Settings shows: on or off, where, and each kept day's files. */
  async status(): Promise<LoggingStatus> {
    await this.settled();
    const days: LogDay[] = [];
    const names = (await readdir(this.root).catch(() => [] as string[])).filter((d) => DAY.test(d)).sort().reverse();
    for (const day of names) {
      const files: LogFile[] = [];
      for (const name of (await readdir(join(this.root, day)).catch(() => [] as string[])).sort()) {
        const s = await stat(join(this.root, day, name)).catch(() => null);
        if (s?.isFile()) files.push({ name, bytes: s.size });
      }
      days.push({ day, files });
    }
    return { server: this.on, dir: this.root, keepDays: KEEP_DAYS, days };
  }

  /** A device's log, kept in today's folder as one JSON line per entry after a header line. The file's path. */
  async saveClient(client: ClientInfo, entries: readonly Record<string, unknown>[], note: string, from: string): Promise<string> {
    const at = this.now();
    const dir = join(this.root, dayOf(at));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    const base = `client-${stamp}-${slug(client.app, 16)}-${slug(client.device)}`;
    let file = join(dir, `${base}.jsonl`);
    for (let n = 2; await stat(file).then(() => true, () => false); n++) file = join(dir, `${base}-${n}.jsonl`);
    const header = { kind: 'bundle', receivedAt: at.toISOString(), from, ...client, entries: entries.length, ...(note ? { note } : {}) };
    await appendFile(file, [header, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    this.event('client-bundle', { file, app: client.app, device: client.device, entries: entries.length });
    void this.prune().catch(() => {});
    return file;
  }
}

/** The host's one log. main.ts calls init(); everything else just logs. */
export const devlog = new DevLog();
