// Fleet recipes (issue #6): named launch templates that start a small team of
// sessions at once and wire them together with declarative handoffs, so a
// pattern like "one implements, one reviews" is one launch instead of a
// hand-assembled set of windows, prompts and reminders.
//
// This module owns the recipe definitions (validation, template variables,
// the built-ins), the durable record of runs and handoffs, and the handoff
// engine. Core owns launching and sending; the engine only decides when a
// handoff fires and asks Core to deliver it through the normal send path.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { CONFIG_PATH, type Config, type Preset, type Recipe, type RecipeMember } from './config.ts';
import { defaultDbPath, getDb } from './db.ts';

const now = () => Math.floor(Date.now() / 1000);

// ---------- built-in recipes

export const BUILT_IN_RECIPES: Recipe[] = [
  {
    id: 'build-and-review',
    name: 'Build and review',
    description: 'One implements in a worktree, one reviews the diff with fresh context.',
    members: [
      { key: 'builder', preset: 'claude', title: 'Builder', worktree: true, prompt: '{brief}' },
      {
        key: 'reviewer',
        preset: 'codex',
        title: 'Reviewer',
        cwdFrom: 'builder',
        prompt: 'You are reviewing work in {builder.worktree} on branch {builder.branch}. Wait for the handoff message before starting your review.',
      },
    ],
    handoffs: [
      {
        when: { session: 'builder', event: 'turn-end' },
        sendTo: 'reviewer',
        template:
          'The builder finished a turn in {builder.worktree} on branch {builder.branch}. Review the uncommitted diff (git diff) plus the last summary from the builder. List concrete problems with file and line, then say what is fine. Do not edit files.',
      },
    ],
  },
  {
    id: 'research-pair',
    name: 'Research pair',
    description: 'Two sessions take the same brief in parallel, for comparing answers.',
    members: [
      { key: 'first', preset: 'claude', title: 'Researcher A', prompt: '{brief}' },
      { key: 'second', preset: 'codex', title: 'Researcher B', prompt: '{brief}' },
    ],
  },
];

/** The recipes in effect: the config list when one is saved, else the built-ins. */
export function effectiveRecipes(config: Config): unknown[] {
  return (config.recipes ?? BUILT_IN_RECIPES) as unknown[];
}

// ---------- template variables

const VAR_RE = /\{([^{}]+)\}/g;
const MEMBER_VAR = /^([a-z][a-z0-9-]*)\.(worktree|branch|cwd|title)$/;

export function templateVars(text: string): string[] {
  return [...text.matchAll(VAR_RE)].map((m) => m[1].trim());
}

function varKnown(v: string, keys: Set<string>): boolean {
  if (v === 'brief') return true;
  const m = v.match(MEMBER_VAR);
  return !!m && keys.has(m[1]);
}

/** Replace {brief} and {<key>.field} from a flat map. Unknown names are left as-is. */
export function resolveTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_RE, (whole, name: string) => vars[name.trim()] ?? whole);
}

// ---------- validation

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function checkVars(text: string, where: string, keys: Set<string>, errors: string[]) {
  for (const v of templateVars(text)) {
    if (!varKnown(v, keys)) errors.push(`${where}: unknown template variable {${v}} (allowed: {brief}, {<member>.cwd}, {<member>.worktree}, {<member>.branch}, {<member>.title})`);
  }
}

/**
 * Validate one raw recipe against the known presets. Returns the normalized
 * recipe (unknown fields dropped) or null, plus every specific problem found.
 * Validation happens at save time and again at launch, never silently.
 */
export function validateRecipe(raw: unknown, presets: Preset[]): { recipe: Recipe | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { recipe: null, errors: ['recipe must be an object'] };
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id)) errors.push('recipe id must be lowercase letters, digits and dashes (max 40)');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80) errors.push('recipe name is required (max 80 chars)');
  const description = typeof raw.description === 'string' ? raw.description : undefined;

  const presetIds = new Set(presets.map((p) => p.id));
  const rawMembers = Array.isArray(raw.members) ? raw.members : [];
  if (rawMembers.length < 2) errors.push('a recipe needs at least two members');
  if (rawMembers.length > 6) errors.push('a recipe can have at most six members');
  const members: RecipeMember[] = [];
  const keys = new Set<string>();
  rawMembers.forEach((rm, i) => {
    const where = `member ${i + 1}`;
    if (!isObj(rm)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const key = typeof rm.key === 'string' ? rm.key : '';
    if (!KEY_RE.test(key)) errors.push(`${where}: key must start with a letter and use lowercase letters, digits and dashes`);
    if (keys.has(key)) errors.push(`${where}: duplicate member key "${key}"`);
    keys.add(key);
    const preset = typeof rm.preset === 'string' ? rm.preset : '';
    if (!presetIds.has(preset)) errors.push(`${where} (${key || '?'}): unknown preset "${preset}"`);
    const member: RecipeMember = { key, preset };
    if (typeof rm.title === 'string' && rm.title) member.title = rm.title.slice(0, 80);
    if (rm.worktree !== undefined) member.worktree = rm.worktree === true;
    if (typeof rm.cwdFrom === 'string' && rm.cwdFrom) member.cwdFrom = rm.cwdFrom;
    for (const f of ['model', 'effort', 'mode'] as const) {
      const v = rm[f];
      if (typeof v === 'string' && v) member[f] = v;
      else if (v === null) member[f] = null;
    }
    if (typeof rm.prompt === 'string') {
      if (rm.prompt.length > 32 * 1024) errors.push(`${where} (${key}): prompt is too long`);
      member.prompt = rm.prompt;
    }
    members.push(member);
  });
  for (const member of members) {
    if (member.cwdFrom !== undefined) {
      if (member.cwdFrom === member.key) errors.push(`member ${member.key}: cwdFrom cannot point at itself`);
      else if (!keys.has(member.cwdFrom)) errors.push(`member ${member.key}: cwdFrom points at unknown member "${member.cwdFrom}"`);
    }
    if (member.prompt) checkVars(member.prompt, `member ${member.key} prompt`, keys, errors);
    if (member.title) checkVars(member.title, `member ${member.key} title`, keys, errors);
  }

  const handoffs: Recipe['handoffs'] = [];
  const rawHandoffs = raw.handoffs === undefined ? [] : raw.handoffs;
  if (!Array.isArray(rawHandoffs)) errors.push('handoffs must be a list');
  (Array.isArray(rawHandoffs) ? rawHandoffs : []).forEach((rh, i) => {
    const where = `handoff ${i + 1}`;
    if (!isObj(rh) || !isObj(rh.when)) {
      errors.push(`${where}: must have a "when" object`);
      return;
    }
    const session = typeof rh.when.session === 'string' ? rh.when.session : '';
    const event = rh.when.event;
    if (!keys.has(session)) errors.push(`${where}: "when.session" is not a member key: "${session}"`);
    if (event !== 'turn-end' && event !== 'needs-you') errors.push(`${where}: event must be "turn-end" or "needs-you"`);
    const sendTo = typeof rh.sendTo === 'string' ? rh.sendTo : '';
    if (!keys.has(sendTo)) errors.push(`${where}: "sendTo" is not a member key: "${sendTo}"`);
    if (session && session === sendTo) errors.push(`${where}: a member cannot hand off to itself`);
    const template = typeof rh.template === 'string' ? rh.template : '';
    if (!template.trim()) errors.push(`${where}: template is required`);
    if (template.length > 32 * 1024) errors.push(`${where}: template is too long`);
    if (template) checkVars(template, where, keys, errors);
    handoffs.push({ when: { session, event: event as 'turn-end' | 'needs-you' }, sendTo, template, ...(rh.repeat === true ? { repeat: true } : {}) });
  });

  if (errors.length) return { recipe: null, errors };
  return { recipe: { id, name, ...(description ? { description } : {}), members, ...(handoffs.length ? { handoffs } : {}) }, errors };
}

/** Validate a whole list (Settings save, config load). Duplicate ids are list-level errors. */
export function validateRecipes(raw: unknown, presets: Preset[]): { recipes: Recipe[]; errors: string[] } {
  if (!Array.isArray(raw)) return { recipes: [], errors: ['recipes must be a list'] };
  const errors: string[] = [];
  const recipes: Recipe[] = [];
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    const v = validateRecipe(r, presets);
    if (v.errors.length) errors.push(...v.errors.map((e) => `recipe ${i + 1}: ${e}`));
    else if (v.recipe) {
      if (seen.has(v.recipe.id)) errors.push(`duplicate recipe id "${v.recipe.id}"`);
      seen.add(v.recipe.id);
      recipes.push(v.recipe);
    }
  });
  return { recipes, errors };
}

/** Persist a validated list into config.json, beside the presets it sits next to. */
export function saveRecipesToConfigFile(recipes: Recipe[]): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      throw new Error(`${CONFIG_PATH} is not valid JSON. Fix it on the host before saving recipes.`);
    }
  }
  existing.recipes = recipes;
  writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
}

// ---------- runs and handoffs (durable)

export type RunState = 'running' | 'stopped' | 'archived' | 'failed';

export type RunMember = {
  key: string;
  uid: string;
  title: string;
  preset: string;
  cwd: string;
  branch: string | null;
  worktree: string | null;
};

export type RunRecord = {
  runId: string;
  recipeId: string;
  name: string;
  host: string;
  cwd: string;
  brief: string;
  state: RunState;
  reason?: string;
  createdAt: number;
  members: RunMember[];
  snapshot: Recipe;
};

export type HandoffState = 'pending' | 'delivered' | 'cancelled' | 'skipped';

export type HandoffRecord = {
  id: string;
  runId: string;
  sourceUid: string;
  targetUid: string;
  sourceKey: string;
  targetKey: string;
  event: 'turn-end' | 'needs-you';
  template: string;
  repeat: boolean;
  state: HandoffState;
  armed: boolean;
  queueId?: string;
  deliveredAt?: number;
  fires: number;
  reason?: string;
};

type RunRow = {
  runId: string; recipeId: string; name: string; host: string; cwd: string; brief: string;
  state: string; reason: string | null; createdAt: number; membersJson: string; snapshotJson: string;
};
type HandoffRow = {
  id: string; runId: string; sourceUid: string; targetUid: string; sourceKey: string; targetKey: string;
  event: string; template: string; repeat: boolean; state: string; armed: boolean;
  queueId: string | null; deliveredAt: number | null; fires: number; reason: string | null;
};

function runToRow(r: RunRecord): RunRow {
  return {
    runId: r.runId, recipeId: r.recipeId, name: r.name, host: r.host, cwd: r.cwd, brief: r.brief,
    state: r.state, reason: r.reason ?? null, createdAt: r.createdAt,
    membersJson: JSON.stringify(r.members), snapshotJson: JSON.stringify(r.snapshot),
  };
}
function runFromRow(row: RunRow): RunRecord {
  let members: RunMember[] = [];
  let snapshot: Recipe = { id: row.recipeId, name: row.name, members: [] };
  try { members = JSON.parse(row.membersJson); } catch {}
  try { snapshot = JSON.parse(row.snapshotJson); } catch {}
  return {
    runId: row.runId, recipeId: row.recipeId, name: row.name, host: row.host, cwd: row.cwd, brief: row.brief,
    state: row.state as RunState, reason: row.reason ?? undefined, createdAt: row.createdAt, members, snapshot,
  };
}
function handoffToRow(h: HandoffRecord): HandoffRow {
  return {
    id: h.id, runId: h.runId, sourceUid: h.sourceUid, targetUid: h.targetUid, sourceKey: h.sourceKey, targetKey: h.targetKey,
    event: h.event, template: h.template, repeat: h.repeat, state: h.state, armed: h.armed,
    queueId: h.queueId ?? null, deliveredAt: h.deliveredAt ?? null, fires: h.fires, reason: h.reason ?? null,
  };
}
function handoffFromRow(row: HandoffRow): HandoffRecord {
  return {
    id: row.id, runId: row.runId, sourceUid: row.sourceUid, targetUid: row.targetUid, sourceKey: row.sourceKey, targetKey: row.targetKey,
    event: row.event as HandoffRecord['event'], template: row.template, repeat: row.repeat, state: row.state as HandoffState,
    armed: row.armed, queueId: row.queueId ?? undefined, deliveredAt: row.deliveredAt ?? undefined, fires: row.fires, reason: row.reason ?? undefined,
  };
}

/**
 * Durable runs and handoffs. Same shape as the Registry: a synchronous
 * in-memory API the tick can read every pass, with SQLite written behind it.
 */
export class RecipeStore {
  private runs = new Map<string, RunRecord>();
  private handoffs = new Map<string, HandoffRecord>();
  private dirtyRuns = new Set<string>();
  private dirtyHandoffs = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private loaded: Promise<void>;
  private db: PrismaClient;
  private dbPath: string;

  constructor(dbPath = defaultDbPath()) {
    this.dbPath = dbPath;
    this.db = getDb(dbPath);
    this.loaded = Promise.all([this.db.recipeRun.findMany(), this.db.handoff.findMany()])
      .then(([runs, handoffs]) => {
        for (const row of runs) if (!this.runs.has(row.runId)) this.runs.set(row.runId, runFromRow(row));
        for (const row of handoffs) if (!this.handoffs.has(row.id)) this.handoffs.set(row.id, handoffFromRow(row));
      })
      .catch((err) => console.error(`recipe store load failed (${dbPath}):`, err));
  }

  ready(): Promise<void> {
    return this.loaded.then(() => {});
  }

  settled(): Promise<void> {
    return this.writing.then(() => {});
  }

  createRun(run: RunRecord) {
    this.runs.set(run.runId, run);
    this.dirtyRuns.add(run.runId);
    this.flush();
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  allRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  setRunState(runId: string, state: RunState, reason?: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.state = state;
    run.reason = reason;
    this.dirtyRuns.add(runId);
    this.flush();
  }

  addHandoff(h: HandoffRecord) {
    this.handoffs.set(h.id, h);
    this.dirtyHandoffs.add(h.id);
    this.flush();
  }

  getHandoff(id: string): HandoffRecord | undefined {
    return this.handoffs.get(id);
  }

  handoffsForRun(runId: string): HandoffRecord[] {
    return [...this.handoffs.values()].filter((h) => h.runId === runId);
  }

  pendingHandoffs(): HandoffRecord[] {
    return [...this.handoffs.values()].filter((h) => h.state === 'pending');
  }

  handoffByQueueId(queueId: string): HandoffRecord | undefined {
    return [...this.handoffs.values()].find((h) => h.queueId === queueId);
  }

  updateHandoff(id: string, patch: Partial<HandoffRecord>) {
    const h = this.handoffs.get(id);
    if (!h) return;
    Object.assign(h, patch);
    this.dirtyHandoffs.add(id);
    this.flush();
  }

  flush() {
    if (!this.dirtyRuns.size && !this.dirtyHandoffs.size) return;
    const runs = [...this.dirtyRuns].map((id) => this.runs.get(id)).filter(Boolean).map((r) => runToRow(r!));
    const handoffs = [...this.dirtyHandoffs].map((id) => this.handoffs.get(id)).filter(Boolean).map((h) => handoffToRow(h!));
    this.dirtyRuns.clear();
    this.dirtyHandoffs.clear();
    const prev = this.writing;
    this.writing = this.loaded
      .catch(() => {})
      .then(() => prev.catch(() => {}))
      .then(async () => {
        if (runs.length) await this.db.$transaction(runs.map((r) => this.db.recipeRun.upsert({ where: { runId: r.runId }, create: r, update: r })));
        if (handoffs.length) await this.db.$transaction(handoffs.map((h) => this.db.handoff.upsert({ where: { id: h.id }, create: h, update: h })));
      })
      .catch((err) => console.error('recipe store write failed:', err));
  }
}

/** Template variables for a run, from its launch-time member snapshot. */
export function runVars(run: RunRecord): Record<string, string> {
  const vars: Record<string, string> = { brief: run.brief };
  for (const m of run.members) {
    vars[`${m.key}.cwd`] = m.cwd;
    vars[`${m.key}.worktree`] = m.worktree ?? m.cwd;
    vars[`${m.key}.branch`] = m.branch ?? '';
    vars[`${m.key}.title`] = m.title;
  }
  return vars;
}

// ---------- handoff engine

export type HandoffSend = (uid: string, text: string, source: { label: string; handoffId: string }) => Promise<{ outcome: 'delivered' | 'queued'; queueId?: string }>;

/**
 * Watches session status transitions and fires due handoffs. The armed flag
 * does the turn-end work: a handoff arms when its source is seen working and
 * fires when the source next goes quiet (idle or attention). Because armed is
 * persisted, a turn that ends while ah is down still fires once on return.
 * Observations are serialized: sends are slow, ticks are frequent.
 */
export class HandoffEngine {
  private last = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private store: RecipeStore;
  private send: HandoffSend;

  constructor(store: RecipeStore, send: HandoffSend) {
    this.store = store;
    this.send = send;
  }

  observe(statuses: Map<string, string>, alive: Set<string>): Promise<void> {
    this.chain = this.chain.then(() => this.observeNow(statuses, alive)).catch((err) => console.error('handoff observation failed:', err));
    return this.chain;
  }

  private async observeNow(statuses: Map<string, string>, alive: Set<string>) {
    for (const h of this.store.pendingHandoffs()) {
      const run = this.store.getRun(h.runId);
      if (!run || run.state !== 'running') {
        this.store.updateHandoff(h.id, { state: 'skipped', reason: 'run is no longer running' });
        continue;
      }
      if (!alive.has(h.sourceUid)) {
        this.store.updateHandoff(h.id, { state: 'skipped', reason: 'source session ended' });
        continue;
      }
      const cur = statuses.get(h.sourceUid);
      if (cur === undefined) continue;
      const prev = this.last.get(h.sourceUid);
      if (h.event === 'turn-end') {
        if (cur === 'busy' && !h.armed) this.store.updateHandoff(h.id, { armed: true });
        else if (h.armed && (cur === 'idle' || cur === 'attention')) await this.fire(h, run, alive);
      } else {
        // needs-you: firing on first sight is right; the session is waiting now.
        if (cur === 'waiting' && prev !== 'waiting') await this.fire(h, run, alive);
      }
    }
    for (const [uid, status] of statuses) this.last.set(uid, status);
    for (const uid of [...this.last.keys()]) if (!alive.has(uid)) this.last.delete(uid);
  }

  private async fire(h: HandoffRecord, run: RunRecord, alive: Set<string>) {
    if (!alive.has(h.targetUid)) {
      this.store.updateHandoff(h.id, { state: 'skipped', reason: 'target session ended' });
      return;
    }
    const source = run.members.find((m) => m.key === h.sourceKey);
    const label = `Recipe handoff from ${source?.title ?? h.sourceKey}`;
    const text = resolveTemplate(h.template, runVars(run));
    try {
      const out = await this.send(h.targetUid, text, { label, handoffId: h.id });
      if (out.outcome === 'queued') {
        // Still pending: the queue owns delivery now, and its outcome decides
        // the final state (delivered via the queue, or cancelled by the user).
        this.store.updateHandoff(h.id, { queueId: out.queueId, armed: false, fires: h.fires + 1 });
      } else {
        this.store.updateHandoff(h.id, {
          state: h.repeat ? 'pending' : 'delivered',
          queueId: undefined,
          armed: false,
          deliveredAt: now(),
          fires: h.fires + 1,
        });
      }
    } catch (err) {
      this.store.updateHandoff(h.id, { state: 'skipped', reason: `delivery failed: ${(err as Error).message}` });
    }
  }

  /** A queue item carrying a handoff was delivered (queue drain or send-now). */
  queueItemDelivered(queueId: string) {
    const h = this.store.handoffByQueueId(queueId);
    if (!h || h.state !== 'pending') return;
    this.store.updateHandoff(h.id, {
      state: h.repeat ? 'pending' : 'delivered',
      queueId: undefined,
      deliveredAt: now(),
    });
  }

  /** A queue item carrying a handoff was cancelled by the user. */
  queueItemCancelled(queueId: string) {
    const h = this.store.handoffByQueueId(queueId);
    if (!h || h.state !== 'pending') return;
    this.store.updateHandoff(h.id, { state: 'cancelled', queueId: undefined, reason: 'cancelled from the queue' });
  }

  /** A queue item carrying a handoff was lost during delivery. */
  queueItemFailed(queueId: string, message: string) {
    const h = this.store.handoffByQueueId(queueId);
    if (!h || h.state !== 'pending') return;
    this.store.updateHandoff(h.id, { state: 'skipped', queueId: undefined, reason: `delivery failed: ${message}` });
  }
}

export function newRunId(): string {
  return randomUUID().slice(0, 8);
}

export function newHandoffId(): string {
  return randomUUID().slice(0, 8);
}

export function hostName(): string {
  return hostname();
}

export type { Recipe, RecipeMember };
