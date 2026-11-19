// Structured launch-command construction (F42).
//
// Presets declare modes/models as argv fragments; the dialog sends ids plus an
// optional free-form tail. Everything is kept as executable+args (never a
// concatenated shell string) until the final quoting step, so a model name or
// custom flag can't break out into a second command.
import type { ModelChoice, Preset } from './config.ts';
import { DomainError } from './errors.ts';

export type LaunchSelection = {
  mode?: string;
  model?: string;
  /** Reasoning effort level, if the preset supports one. */
  effort?: string;
  /** Free-form tail from the "Additional arguments" field, split on whitespace. */
  extraArgs?: string[] | string;
  /** Resume target: conversation id, or true for "most recent here". */
  resume?: string | true;
};

export type LaunchPlan = {
  executable: string;
  args: string[];
  /** Shell-quoted single line, safe to type into a fresh shell. Empty for a plain shell. */
  command: string;
  meta: { 'ah.launch.mode'?: string; 'ah.launch.model'?: string; 'ah.launch.effort'?: string; 'ah.launch.args': string[] };
  /** "Claude · Sonnet · Skip permissions" for the session header. */
  summary: string | null;
};

export class LaunchError extends DomainError {
  constructor(message: string) {
    super(400, message);
  }
}

function applies(choice: { appliesTo?: string }, resuming: boolean): boolean {
  const a = choice.appliesTo ?? 'both';
  if (a === 'both') return true;
  return resuming ? a === 'resume' : a === 'launch';
}

/** Tokenizer for the free-form tail: whitespace split with single/double-quote support. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '\\' && quote !== "'") {
      if (i + 1 === input.length) throw new LaunchError('unfinished escape in additional arguments');
      word += input[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new LaunchError('unbalanced quote in additional arguments');
  if (started) out.push(word);
  return out;
}

// Shell metacharacters are never valid inside one argv element typed this way.
const UNSAFE = /[;&|`$(){}!#~*?<>\n\r]/;
const FLAG = /^-{1,2}[\w][\w.:=,-]*$/;

function checkExtra(args: string[]): void {
  for (const a of args) {
    if (!a) throw new LaunchError('empty argument');
    if (a.length > 256) throw new LaunchError(`argument too long: ${a.slice(0, 40)}…`);
    if (UNSAFE.test(a)) throw new LaunchError(`rejected unsafe argument: ${a}`);
    if (a.startsWith('-') && !FLAG.test(a)) throw new LaunchError(`rejected malformed flag: ${a}`);
  }
  if (args.length > 32) throw new LaunchError('too many additional arguments (max 32)');
}

/** Quote one argv element for POSIX shells. */
export function quoteArg(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function buildLaunch(preset: Preset, sel: LaunchSelection = {}): LaunchPlan {
  const resuming = sel.resume !== undefined;
  const base = splitArgs(preset.command ?? '');
  const executable = base[0] ?? '';

  // Shell preset: modes select the shell binary; anything else is a plain shell.
  if (preset.id === 'shell' || !executable) {
    const mode = (preset.modes ?? []).find((m) => m.id === (sel.mode ?? 'default'));
    if (sel.mode && sel.mode !== 'default' && !mode) throw new LaunchError(`unknown mode: ${sel.mode}`);
    const extra = normalizeExtra(sel.extraArgs);
    const words = mode?.args?.length ? [...mode.args!] : [];
    words.push(...extra);
    return {
      executable: words[0] ?? '',
      args: words.slice(1),
      command: words.map(quoteArg).join(' '),
      meta: {
        ...(mode && mode.id !== 'default' ? { 'ah.launch.mode': mode.id } : {}),
        'ah.launch.args': words,
      },
      summary: mode && mode.id !== 'default' ? mode.name : null,
    };
  }

  // On resume, a stored choice the preset no longer offers is dropped, not fatal:
  // the conversation matters more than a flag that went away.
  const mode = (preset.modes ?? []).find((m) => m.id === (sel.mode ?? 'default'));
  if (sel.mode && sel.mode !== 'default' && !mode && !resuming) throw new LaunchError(`unknown mode: ${sel.mode}`);
  // A model id outside the list ("Other model…") is allowed when the preset says how to pass one.
  const model = (preset.models ?? []).find((m) => m.id === (sel.model ?? 'default')) ?? customModel(preset, sel.model);
  if (sel.model && sel.model !== 'default' && !model && !resuming) throw new LaunchError(`unknown model: ${sel.model}`);
  let effort: string | undefined;
  if (sel.effort && sel.effort !== 'default') {
    const effective = model ?? preset.models?.find((m) => m.isDefault);
    const levels = effective?.efforts ?? preset.effort?.levels ?? [];
    if (preset.effort && levels.includes(sel.effort)) effort = sel.effort;
    else if (!resuming) throw new LaunchError(preset.effort ? `${model?.name ?? 'this model'} doesn't support effort "${sel.effort}"` : `${preset.name} has no effort setting`);
  }

  // Resume base: exact conversation when we know its id, else "most recent here".
  let words: string[];
  if (typeof sel.resume === 'string' && preset.resumeId) {
    if (!/^[\w:.-]{1,80}$/.test(sel.resume)) throw new LaunchError('invalid resume id');
    words = splitArgs(preset.resumeId.replace('{id}', sel.resume));
  } else if (resuming && preset.resume) {
    words = splitArgs(preset.resume);
  } else {
    words = [...base];
  }

  if (mode && applies(mode, resuming)) words.push(...(mode.args ?? []));
  if (model && applies(model, resuming)) words.push(...model.args);
  if (effort && preset.effort && applies(preset.effort, resuming)) words.push(...preset.effort.args.map((a) => a.replace('{level}', effort!)));
  const extra = normalizeExtra(sel.extraArgs);
  words.push(...extra);

  const summaryParts = [
    model && model.id !== 'default' ? model.name : null,
    effort ?? null,
    mode && mode.id !== 'default' ? mode.name : null,
  ].filter(Boolean);

  return {
    executable: words[0] ?? '',
    args: words.slice(1),
    command: words.map(quoteArg).join(' '),
    meta: {
      ...(mode && mode.id !== 'default' ? { 'ah.launch.mode': mode.id } : {}),
      ...(model && model.id !== 'default' ? { 'ah.launch.model': model.id } : {}),
      ...(effort ? { 'ah.launch.effort': effort } : {}),
      'ah.launch.args': words.slice(1),
    },
    summary: summaryParts.length ? summaryParts.join(' · ') : null,
  };
}

/** A free-form model id, validated and turned into argv via the preset's template. */
export function customModel(preset: Preset, id: string | undefined): ModelChoice | undefined {
  if (!id || id === 'default' || !preset.modelArgs) return undefined;
  if (!/^[A-Za-z0-9][\w.:/@-]{0,79}$/.test(id)) throw new LaunchError(`invalid model id: ${id}`);
  return { id, name: id, args: preset.modelArgs.map((a) => a.replace('{model}', id)) };
}

function normalizeExtra(extra: LaunchSelection['extraArgs']): string[] {
  const list = Array.isArray(extra) ? extra : extra ? splitArgs(extra) : [];
  checkExtra(list);
  return list;
}

/** Rebuild the launch flags for resume from stored registry meta (F42). */
export function resumeSelection(meta: Record<string, unknown>): Pick<LaunchSelection, 'mode' | 'model' | 'effort'> {
  const mode = meta['ah.launch.mode'];
  const model = meta['ah.launch.model'];
  const effort = meta['ah.launch.effort'];
  return {
    ...(typeof mode === 'string' ? { mode } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof effort === 'string' ? { effort } : {}),
  };
}
