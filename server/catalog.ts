// Live model catalogs: each agent's own list of models and its configured
// defaults, read from the files and commands the CLIs themselves use. Presets
// keep the argv shapes; this only fills in *which* models exist and which one
// (and which effort) the harness will use if you don't choose.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelChoice, Preset } from './config.ts';

const exec = promisify(execFile);
const TTL_MS = 5 * 60_000;

export type Catalog = { models: ModelChoice[]; defaultModel?: string; defaultEffort?: string };

async function json(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Minimal `key = "value"` reader for the top level of a TOML file. */
async function tomlTop(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const text = await readFile(path, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) break;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** "muse-spark-1.3-contributor" → "Muse Spark 1.3 Contributor"; "gpt-6.1-sol" → "GPT-6.1 Sol". */
export function prettyModel(id: string): string {
  return id
    .split('-')
    .map((w) => (/^gpt$/i.test(w) ? 'GPT' : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/^GPT (\d)/, 'GPT-$1');
}

const readers: Record<string, (preset: Preset) => Promise<Catalog>> = {
  // Claude: aliases from the preset; your default from ~/.claude/settings.json.
  async claude(preset) {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const settings = await json(join(dir, 'settings.json'));
    const models = [...(preset.models ?? [])];
    const def = typeof settings?.model === 'string' ? settings.model : undefined;
    if (def && !models.some((m) => m.id === def)) models.push({ id: def, name: prettyModel(def), args: ['--model', def] });
    // Effort is stored per full model id: modelSettings["claude-opus-5-5"].effortLevel.
    const perModel = Object.entries<any>(settings?.modelSettings ?? {}).find(([id]) => def && id.includes(def));
    return { models, defaultModel: def, defaultEffort: perModel?.[1]?.effortLevel ?? settings?.effortLevel };
  },

  // Codex publishes its catalog (with each model's effort levels) in models_cache.json.
  async codex() {
    const dir = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const [cache, cfg] = await Promise.all([json(join(dir, 'models_cache.json')), tomlTop(join(dir, 'config.toml'))]);
    const models: ModelChoice[] = (cache?.models ?? [])
      .filter((m: any) => m.visibility !== 'hide' && typeof m.slug === 'string')
      .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m: any) => ({
        id: m.slug,
        name: String(m.display_name ?? m.slug).replace(/-(?=[A-Z][a-z])/g, ' '),
        description: m.description,
        args: ['--model', m.slug],
        efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter((e: unknown) => typeof e === 'string'),
      }));
    if (cfg.model && !models.some((m) => m.id === cfg.model)) models.unshift({ id: cfg.model, name: prettyModel(cfg.model), args: ['--model', cfg.model] });
    return { models, defaultModel: cfg.model, defaultEffort: cfg.model_reasoning_effort };
  },

  // Muse: the configured model (and the base model if that's a variant).
  async muse() {
    const settings = await json(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'muse', 'settings.json'));
    const def: string | undefined = settings?.model;
    const ids = [...new Set([def, def?.replace(/-(contributor|preview)$/, '')].filter((x): x is string => !!x))];
    return {
      models: ids.map((id) => ({ id, name: prettyModel(id), args: ['--model', id] })),
      defaultModel: def,
      defaultEffort: settings?.reasoning_effort,
    };
  },

  // Grok prints its list: "* grok-4.7 (default)" / "- grok-4.6".
  async grok() {
    const { stdout } = await exec('grok', ['models'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
    let defaultModel: string | undefined;
    const models: ModelChoice[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*[*-]\s+([\w.:-]+)(\s+\(default\))?/);
      if (!m) continue;
      if (m[2] || line.trim().startsWith('*')) defaultModel ??= m[1];
      models.push({ id: m[1], name: prettyModel(m[1]), args: ['-m', m[1]] });
    }
    return { models, defaultModel };
  },
};

const cache = new Map<string, { at: number; value: Promise<Catalog> }>();

/** The preset with its live model list, default model and default effort filled in. */
export async function withCatalog(preset: Preset): Promise<Preset & { defaultModel?: string; defaultEffort?: string }> {
  const reader = preset.catalog && readers[preset.catalog];
  if (!reader) return preset;
  let hit = cache.get(preset.id);
  if (!hit || Date.now() - hit.at > TTL_MS) {
    hit = { at: Date.now(), value: reader(preset).catch(() => ({ models: preset.models ?? [] })) };
    cache.set(preset.id, hit);
  }
  const cat = await hit.value;
  const models = (cat.models.length ? cat.models : (preset.models ?? [])).map((m) => ({ ...m, isDefault: m.id === cat.defaultModel }));
  return { ...preset, models, defaultModel: cat.defaultModel, defaultEffort: cat.defaultEffort };
}
