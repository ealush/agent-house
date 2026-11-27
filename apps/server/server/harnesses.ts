// Keeping each agent's settings current. Agent CLIs update on their own schedule,
// and their permission modes and effort levels change with them; a preset written
// for last month's version goes stale. So ah asks each installed CLI its version,
// and when that changes it reads the new version's --help: the choices listed for
// the preset's mode flag (--permission-mode, --approval-mode, --mode) and effort
// flag (--effort, --reasoning-effort, --thinking) replace the ones the preset was
// written with. A choice the CLI added appears; one it dropped goes. The names and
// descriptions ah gives the choices it already knew are kept.
//
// Also here, the host's own list: agents hidden from New session, and agents
// added by hand (any command on PATH, run in a terminal).
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Preset, PresetChoice } from './config.ts';

const exec = promisify(execFile);

export type Probe = {
  /**
   * The program it asked ("agy"). A preset that now runs another CLI (Gemini: `gemini`,
   * then `agy`) must not be rewritten by the old one's --help. Absent in probes saved
   * before it was recorded.
   */
  command?: string;
  /** What `<cli> --version` printed (first line), or null when it couldn't run. */
  version: string | null;
  checkedAt: number;
  /** The choices --help lists for the preset's mode flag and effort flag. */
  modeChoices?: string[];
  effortChoices?: string[];
  /** What the last new version changed, in words ("New mode: Don't ask"). */
  changes: string[];
};

/** An agent added on this host: any command, run in a terminal like the built-in ones. */
export type CustomAgent = { id: string; name: string; command: string; resume?: string };

/** `piBridge`: Settings → Agents' switch for ah's pi bridge (server/pi/bridge.ts); unset, config.json decides. */
type Saved = { probes: Record<string, Probe>; hidden: string[]; custom: CustomAgent[]; piBridge?: boolean };

// ---------- reading --help

/** The lines of `help` that describe `flag`: its option line and the description under it. */
export function flagBlock(help: string, flag: string): string | null {
  const lines = help.replace(/\r/g, '').split('\n');
  const at = new RegExp(`(^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,=<\\[]|$)`);
  const start = lines.findIndex((l) => l.trimStart().startsWith('-') && at.test(l));
  if (start < 0) return null;
  const indent = lines[start].length - lines[start].trimStart().length;
  const out = [lines[start]];
  for (const l of lines.slice(start + 1, start + 14)) {
    const t = l.trimStart();
    const lead = l.length - t.length;
    // The next option at this depth, or a section heading, ends the block.
    if (t && ((t.startsWith('-') && lead <= indent) || lead === 0)) break;
    out.push(l);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

const TOKEN = /^[A-Za-z][\w-]{0,30}$/;

/** The values a block offers, in the order the CLI lists them, or null when it lists none. */
export function choicesIn(block: string): string[] | null {
  const text = block.replace(/\(default:[^)]*\)/gi, '').replace(/\[default:[^\]]*\]/gi, '');
  let found: string[] | null = null;
  const quoted = text.match(/choices:\s*((?:"[^"]+"(?:,\s*)?)+)/i);
  const possible = text.match(/possible values:\s*([^\]]+)\]/i);
  const piped = text.match(/(?:^|[\s:(])([A-Za-z][\w-]*(?:\|[A-Za-z][\w-]*){2,})/);
  const listed = text.match(/[(:]\s*((?:[A-Za-z][\w-]*,\s*){2,}(?:or\s+)?[A-Za-z][\w-]*)/);
  if (quoted) found = [...quoted[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  else if (possible) found = possible[1].split(',');
  else if (piped) found = piped[1].split('|');
  else if (listed) found = listed[1].split(',').map((s) => s.replace(/^\s*or\s+/, ''));
  if (!found) return null;
  const values = [...new Set(found.map((s) => s.trim()).filter(Boolean))];
  return values.length >= 2 && values.length <= 12 && values.every((v) => TOKEN.test(v)) ? values : null;
}

/** The flag a preset's modes set a value on ("--permission-mode"), if they share one. */
export function modeFlag(p: Preset): string | null {
  const flags = (p.modes ?? []).filter((m) => m.args?.length === 2 && m.args[0].startsWith('--')).map((m) => m.args![0]);
  if (!flags.length) return null;
  const counts = new Map<string, number>();
  for (const f of flags) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const effortFlag = (p: Preset) => (p.effort?.args[0]?.startsWith('-') ? p.effort.args[0] : null);

// ---------- applying what --help says

/** Values that name the CLI's own default: the preset's argument-less mode already stands for them. */
const DEFAULTISH = /^(default|manual|normal|ask|on-request|suggest)$/i;
/** Values that turn approvals off. */
const RISKY = /bypass|yolo|danger|skip|full[-_]?access|never|allow[-_]?all/i;

const WORDS: Record<string, string> = { dont: "Don't", cant: "Can't", wont: "Won't" };

/** "dontAsk" → "Don't ask", "auto_edit" → "Auto edit", "accept-edits" → "Accept edits". */
export function choiceName(value: string): string {
  const words = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.map((w, i) => WORDS[w] ?? (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

const slug = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

/** The preset as this version of its CLI describes it. Unchanged when the probe says nothing usable. */
export function adjust(preset: Preset, probe: Probe | undefined): Preset {
  if (!probe) return preset;
  let out = preset;
  const levels = probe.effortChoices;
  // An effort list shares at least two levels with the one it replaces: the same kind of list.
  if (out.effort && levels && levels.filter((l) => out.effort!.levels.includes(l)).length >= 2) {
    out = { ...out, effort: { ...out.effort, levels } };
  }
  const flag = modeFlag(out);
  const values = probe.modeChoices;
  if (flag && values && out.modes) {
    const valueOf = (m: PresetChoice) => (m.args?.length === 2 && m.args[0] === flag ? m.args[1] : null);
    const known = out.modes.map(valueOf).filter((v): v is string => v !== null);
    // Only when it is recognizably the same list: at least one value the preset already uses.
    if (known.some((v) => values.includes(v))) {
      const kept = out.modes.filter((m) => valueOf(m) === null || values.includes(valueOf(m)!));
      let risky = kept.some((m) => m.dangerous);
      const added: PresetChoice[] = [];
      for (const v of values) {
        if (known.includes(v) || DEFAULTISH.test(v)) continue;
        const dangerous = RISKY.test(v);
        // One way to turn approvals off is enough: a second would only be a second warning.
        if (dangerous && risky) continue;
        risky ||= dangerous;
        let id = slug(v);
        while (kept.some((m) => m.id === id) || added.some((m) => m.id === id)) id += '-2';
        added.push({ id, name: choiceName(v), args: [flag, v], ...(dangerous ? { dangerous: true } : {}), description: `Listed by ${preset.command} --help.` });
      }
      if (added.length || kept.length !== out.modes.length) out = { ...out, modes: [...kept, ...added] };
    }
  }
  return out;
}

/** In words, what `after` offers that `before` didn't, and what it no longer does. */
export function describeChanges(before: Preset, after: Preset): string[] {
  const out: string[] = [];
  const ids = (p: Preset) => new Map((p.modes ?? []).map((m) => [m.id, m.name]));
  const [a, b] = [ids(before), ids(after)];
  for (const [id, name] of b) if (!a.has(id)) out.push(`New mode: ${name}`);
  for (const [id, name] of a) if (!b.has(id)) out.push(`Mode gone: ${name}`);
  const [la, lb] = [before.effort?.levels ?? [], after.effort?.levels ?? []];
  const more = lb.filter((l) => !la.includes(l));
  const fewer = la.filter((l) => !lb.includes(l));
  if (more.length) out.push(`New effort level${more.length === 1 ? '' : 's'}: ${more.join(', ')}`);
  if (fewer.length) out.push(`Effort level${fewer.length === 1 ? '' : 's'} gone: ${fewer.join(', ')}`);
  return out;
}

// ---------- agents found on this host that ah has no preset for

/** Agent CLIs worth offering when they're on PATH: a command and the name it goes by. */
const CANDIDATES: Array<{ command: string; name: string }> = [
  { command: 'aider', name: 'Aider' },
  { command: 'amp', name: 'Amp' },
  { command: 'auggie', name: 'Auggie' },
  { command: 'cline', name: 'Cline' },
  { command: 'codebuff', name: 'Codebuff' },
  { command: 'droid', name: 'Droid' },
  { command: 'goose', name: 'Goose' },
  { command: 'jules', name: 'Jules' },
  { command: 'kilocode', name: 'Kilo Code' },
  { command: 'kimi', name: 'Kimi' },
  { command: 'kiro-cli', name: 'Kiro' },
  { command: 'openhands', name: 'OpenHands' },
  { command: 'plandex', name: 'Plandex' },
  { command: 'qwen', name: 'Qwen Code' },
];

/** The candidates installed here (by `onPath`) that no preset already runs. */
export function suggestions(presets: Preset[], onPath: (command: string) => boolean): Array<{ command: string; name: string }> {
  const taken = new Set(presets.map((p) => p.command.trim().split(/\s+/)[0]));
  return CANDIDATES.filter((c) => !taken.has(c.command) && onPath(c.command));
}

// ---------- the host's list, kept in the state dir

const FILE = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'harnesses.json');

/** How often an unchanged CLI is asked its version again. */
const RECHECK_MS = 6 * 3600_000;

export class Harnesses {
  private saved: Saved;
  private running: Promise<void> | null = null;
  private file: string;

  constructor(file = FILE()) {
    this.file = file;
    this.saved = { probes: {}, hidden: [], custom: [] };
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      this.saved = {
        probes: raw.probes ?? {},
        hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
        custom: Array.isArray(raw.custom) ? raw.custom : [],
        ...(typeof raw.piBridge === 'boolean' ? { piBridge: raw.piBridge } : {}),
      };
    } catch {}
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** What `command`'s CLI said last for preset `id`; nothing when the probe was of another program. */
  probe(id: string, command?: string): Probe | undefined {
    const saved = this.saved.probes[id];
    const bin = command?.trim().split(/\s+/)[0];
    return saved && bin && saved.command && saved.command !== bin ? undefined : saved;
  }

  hidden(id: string): boolean {
    return this.saved.hidden.includes(id);
  }

  setHidden(id: string, hidden: boolean) {
    const rest = this.saved.hidden.filter((h) => h !== id);
    this.saved.hidden = hidden ? [...rest, id] : rest;
    this.save();
  }

  /** The pi bridge as switched in Settings, or undefined when it never was. */
  piBridge(): boolean | undefined {
    return this.saved.piBridge;
  }

  setPiBridge(on: boolean) {
    this.saved.piBridge = on;
    this.save();
  }

  custom(): CustomAgent[] {
    return this.saved.custom;
  }

  /** A custom agent as a preset: launched by its command, detected by its name, terminal-only. */
  static preset(c: CustomAgent): Preset {
    return { id: c.id, name: c.name, command: c.command, ...(c.resume ? { resume: c.resume } : {}), interruptKeys: ['Escape'] };
  }

  addCustom(input: { name?: unknown; command?: unknown; resume?: unknown }, taken: string[]): CustomAgent {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    const resume = typeof input.resume === 'string' ? input.resume.trim() : '';
    if (!name || name.length > 40) throw new Error('a name of up to 40 characters');
    if (!command || command.length > 200 || /[\n\r]/.test(command)) throw new Error('a one-line command of up to 200 characters');
    if (resume.length > 200 || /[\n\r]/.test(resume)) throw new Error('a one-line resume command of up to 200 characters');
    let id = `custom-${slug(name).replace(/^-+|-+$/g, '') || 'agent'}`.slice(0, 40);
    while (taken.includes(id) || this.saved.custom.some((c) => c.id === id)) id += '-2';
    const agent: CustomAgent = { id, name, command, ...(resume ? { resume } : {}) };
    this.saved.custom = [...this.saved.custom, agent];
    this.save();
    return agent;
  }

  removeCustom(id: string): boolean {
    const before = this.saved.custom.length;
    this.saved.custom = this.saved.custom.filter((c) => c.id !== id);
    this.saved.hidden = this.saved.hidden.filter((h) => h !== id);
    if (this.saved.custom.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Asks each preset's CLI its version; a new one (or `force`) has its --help read and
   * applied. `available` says which CLIs are installed; the rest are skipped. One run
   * at a time: a second call waits for the first.
   */
  check(presets: Preset[], env: NodeJS.ProcessEnv, available: (p: Preset) => boolean, force = false): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      let dirty = false;
      for (const p of presets) {
        const bin = p.command.trim().split(/\s+/)[0];
        if (!bin || !available(p)) continue;
        // A probe of another program (the preset's command changed) counts as none.
        const kept = this.saved.probes[p.id];
        const old = kept && kept.command && kept.command !== bin ? undefined : kept;
        // One saved before probes named their program is asked again, once, to learn it.
        if (!force && old?.command && Date.now() - old.checkedAt < RECHECK_MS) continue;
        const version = await run(bin, ['--version'], env).then((o) => o.split('\n').map((l) => l.trim()).find(Boolean) ?? null);
        if (!force && old && old.version === version) {
          this.saved.probes[p.id] = { ...old, command: bin, checkedAt: Date.now() };
          dirty = true;
          continue;
        }
        const next: Probe = { command: bin, version, checkedAt: Date.now(), changes: old?.changes ?? [] };
        const mf = modeFlag(p);
        const ef = effortFlag(p);
        if (mf || ef) {
          const help = await run(bin, ['--help'], env);
          if (mf) next.modeChoices = choicesIn(flagBlock(help, mf) ?? '') ?? undefined;
          if (ef) next.effortChoices = choicesIn(flagBlock(help, ef) ?? '') ?? undefined;
        }
        // What this version changed, against what ah offered before it (at first, its own list).
        const diff = describeChanges(adjust(p, old), adjust(p, next));
        if (diff.length || old?.version !== version) next.changes = diff;
        this.saved.probes[p.id] = next;
        dirty = true;
      }
      if (dirty) this.save();
    })().finally(() => (this.running = null));
    return this.running;
  }
}

/** A CLI's output for fixed arguments: no shell, a time limit, and nothing on failure. */
async function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout, stderr } = await exec(bin, args, { env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout || stderr;
  } catch (e) {
    // Some CLIs print their help and exit non-zero.
    const out = (e as { stdout?: string }).stdout;
    return typeof out === 'string' ? out : '';
  }
}
