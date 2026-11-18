// ah's HTTP/WebSocket front door.
//
// Invariants, in the order a request meets them:
//   1. ah only listens on loopback. Remote access is Tailscale's job (`tailscale serve`).
//   2. Host must be loopback or this node's ts.net name; via Serve, the caller must be
//      the machine owner's Tailscale identity (gate.ts).
//   3. Writes and WebSockets need a same-site Origin and, for writes, the X-AH header.
//   4. Default deny: every route needs a signed-in device or machine token, except the
//      short PUBLIC list below (sign-in itself).
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { hostName } from './host.ts';
import { basename, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, expandHome, CONFIG_PATH, type Config } from './config.ts';
import { shortPath } from './sessions.ts';
import { AttachedTerminals } from './attachedTerminal.ts';
import { compressible, encoded } from './compress.ts';
import { Core, CoreError, resolveDir, defaultName, API_VERSION } from './core.ts';
import { features } from './features.ts';
import { buildLaunch, LaunchError, resumeSelection } from './launch.ts';
import { withCatalog } from './catalog.ts';
import { addViewer, attach, clientId, viewers } from './terminal.ts';
import { desktopStatus, installDesktop, removeDesktop } from './desktop.ts';
import { Drafts } from './drafts.ts';
import { feedPage, feedPrompts, streamFeed, SNAPSHOT } from './feed/stream.ts';
import type { Part } from './feed/schema.ts';
import { Previews, removeStaleMappings, tailscalePublish } from './preview.ts';
import { listeningPorts } from './procs.ts';
import * as t from './tmux.ts';
import { createWorktree, initRepo, changes, listBranches, switchBranch, pullRequest, GitError } from './git.ts';
import { SideChatStore, SideChatError, changeContext } from './sidechat.ts';
import { VoiceService, MAX_AUDIO_BYTES, AUDIO_UPLOAD_MS, MAX_DICTATING } from './voice.ts';
import { ensureClient, ensureMigrated, getDb } from './db.ts';
import { importLegacyJson } from './migrate.ts';
import { FsError, dirStatus, list, makeDir, receive, sendFile, setRoots, roots, clearUploadDir, safePath } from './files.ts';
import { Peers, proxyHttp, proxyWs, peerUrlAllowed } from './peers.ts';
import { SearchIndexer, combineResponses, type SearchParams } from './search.ts';
import { Auth, AuthError, clearCookies, type Caller } from './auth.ts';
import { Gate, LOOPBACK_BIND, servedAt } from './gate.ts';
import { Apns, ApnsError } from './apns.ts';
import { HttpError, send, readBody, readJson, str, safeDecode } from './http.ts';
import { admit, declaredLength, streamToFile, sweepParts, UploadError } from './uploads.ts';
import { rebuildFailure, rebuildWeb } from './rebuild.ts';
import { slashCommands, projectFiles } from './complete.ts';
import { omarchyTheme } from './omarchy.ts';
import { screenAudit } from './audit.ts';
import { EnvStore } from './env.ts';
import { Harnesses } from './harnesses.ts';
import { hooksStatus, installClaude, installCodex, uninstallClaude, uninstallCodex } from './hooks.ts';
import { ReviewService, readTextFile, type SessionLite } from './review/service.ts';
import { reviewApi } from './review/api.ts';
import { conversationKey } from './registry.ts';
import { PortableService, type Resolved } from './portable/service.ts';
import { PortableStore } from './portable/store.ts';
import { portableApi } from './portable/api.ts';
import { MigrationService } from './migrate/service.ts';
import { migrateApi } from './migrate/api.ts';
import { Scheduler } from './jobs/scheduler.ts';
import { jobsApi } from './jobs/api.ts';
import { NotesStore } from './notes/store.ts';
import { Handoffs, MaybeArrived } from './notes/handoff.ts';
import { notesApi } from './notes/api.ts';
import { linesAfter, readAfter } from './jobs/transcript.ts';
import { RecoveryEngine, RecoveryError } from './recovery/engine.ts';
import { InterruptionError, Interruptions, interruptedOf, shortWhy } from './interruptions.ts';
import { UsageService } from './usage/service.ts';
import { fileContains } from './portable/extract.ts';
import { discover } from './discovery.ts';
import { copyTranscript, removeCopiedTranscript } from './fork.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(flag('port') ?? process.env.AH_PORT ?? config.port);
const HOST = String(flag('host') ?? process.env.AH_HOST ?? config.host);
// AH_DIST: serve another build of the page (the browser tests build their own, never touching dist/).
const DIST = process.env.AH_DIST ? resolve(process.env.AH_DIST) : fileURLToPath(new URL('../dist', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UPLOAD_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ah', 'uploads');

// Invariant 1. No flag turns this off: exposure belongs to Tailscale, not to ah.
if (!LOOPBACK_BIND.has(HOST)) {
  console.error(`Refusing to listen on ${HOST}: ah only listens on loopback (127.0.0.1 or ::1).`);
  console.error('Reach it from other devices with `tailscale serve` — run `node bin/ah.js setup tailscale` once.');
  process.exit(1);
}

let auth: Auth;
try {
  auth = new Auth(config.auth);
} catch (err) {
  // Fail closed: never start without the sign-in data we're supposed to enforce.
  console.error(`Can't read ah's auth state: ${(err as Error).message}`);
  process.exit(1);
}
const core = new Core(config, viewers);
// Native app push: delivered beside Web Push; a sign-in that ends stops its alerts.
const apns = new Apns(config.apns);
core.push.apns = apns;
auth.onSessionEnd = (id) => apns.forgetSession(id);
// A sign-in left unused past its idle limit ends on its own (and its push registration with it).
auth.prune();
apns.retain(auth.sessionIds());
setInterval(() => auth.prune(), 3600_000).unref();
// Each agent CLI's current modes and efforts, and the host's hidden and added agents.
core.harnesses = new Harnesses();
core.applyHarnesses();
const drafts = new Drafts();
const sidechat = new SideChatStore();
const voice = new VoiceService(sidechat);
/** Dictations being read or heard now (each holds its recording in memory). */
let dictating = 0;
const envStore = new EnvStore();
core.launchEnv = () => envStore.forLaunch();
const terminals = new AttachedTerminals(core.registry, () => core.launchEnv());
const search = new SearchIndexer(getDb(), () => core.searchSources());
// Stack review (docs/stack-review.md): sessions it can send findings to are the live
// windows plus ended conversations that resume.
const review = new ReviewService(getDb(), sidechat, {
  sessions: async () => {
    const windows = (await core.current()).windows;
    const live = new Set(windows.map((w) => w.uid));
    const out: SessionLite[] = windows.map((w) => ({ uid: w.uid, key: sidechat.chatKey(w.agent, w.harnessId, w.uid), title: w.title, agent: w.agent, status: w.status, cwd: expandHome(w.cwd), branch: w.branch, live: true }));
    for (const r of core.registry.all()) {
      if (live.has(r.id) || !r.harnessId || r.harness === 'shell') continue;
      out.push({ uid: r.id, key: conversationKey(r.harness, r.harnessId, r.id), title: r.title || r.harness, agent: r.harness, status: 'ended', cwd: expandHome(r.cwd), branch: null, live: false });
    }
    return out;
  },
  send: (uid, text) => core.send(uid, text),
  alert: (p) => core.push.alert(p),
  changed: () => void core.tick().catch(() => {}),
  readPlan: async (path) => readTextFile(await safePath(expandHome(path))),
  launch: async ({ preset: id, root, label, fromRef }) => {
    const preset = await withCatalog(core.preset(id));
    const plan = buildLaunch(preset, {});
    const wt = await createWorktree(root, label, fromRef);
    const out = await core.launch({ preset, cwd: wt.path, session: config.defaultSession, name: label, command: plan.command, meta: { ...plan.meta, 'ah.worktree': wt, 'ah.order': core.nextOrder() } });
    await core.refreshTmuxPath();
    await core.tick();
    return { uid: out.uid, key: sidechat.chatKey(preset.id, null, out.uid), title: label, agent: preset.id, status: 'idle', cwd: wt.path, branch: wt.branch, live: true };
  },
  // The reviewer's origin tool: the session's own transcript, as text (latest 1000 entries).
  transcript: async (uid) => {
    const resolve = () => core.feedSource(uid);
    const [prompts, page] = await Promise.all([feedPrompts(resolve), feedPage(resolve, Infinity, 1000)]);
    if (!prompts || !page) return null;
    const text = (p: Part) => (p.type === 'text' || p.type === 'reasoning' ? p.text : p.type === 'tool_call' ? `${p.call.name} ${JSON.stringify(p.call.args).slice(0, 400)}` : p.type === 'tool_result' ? p.result.text.slice(0, 800) : '');
    return { prompts, entries: page.entries.map((e) => ({ role: e.role, at: e.at, text: e.parts.map(text).filter(Boolean).join('\n') })).filter((e) => e.text) };
  },
});
core.reviewState = () => review.state();

// Portable conversations (server/portable): continuing a conversation in another agent,
// with its lineage. Sessions start only from configured agents, through core.launch.
const findTranscript = async (harness: string, harnessId: string) => {
  const adapter = core.presets().find((p) => p.id === harness)?.feed ?? harness;
  const pick = (list: Awaited<ReturnType<typeof discover>>) => list.find((x) => x.harness === adapter && x.harnessId === harnessId) ?? null;
  // The cached scan first; a conversation that started since it was taken needs a fresh one.
  return pick(await discover()) ?? pick(await discover(0));
};
/** A session uid or `harness:harnessId`, as the portable layer needs it. */
async function resolveConversation(ref: string): Promise<Resolved | null> {
  const state = await core.current();
  const live = state.windows.find((w) => w.uid === ref);
  const rec = core.registry.get(ref);
  let harness: string | null;
  let harnessId: string | null;
  let cwd: string;
  let title: string;
  let model: string | null;
  if (live || rec) {
    harness = live?.agent ?? rec?.harness ?? null;
    harnessId = live?.harnessId ?? rec?.harnessId ?? null;
    cwd = expandHome(rec?.cwd ?? live!.cwd);
    title = live?.title || rec?.title || '';
    model = live?.model ?? rec?.model ?? null;
  } else {
    const i = ref.indexOf(':');
    if (i <= 0) return null;
    const found = await findTranscript(ref.slice(0, i), ref.slice(i + 1));
    if (!found) return null;
    const known = core.registry.all().find((r) => r.harness === ref.slice(0, i) && r.harnessId === found.harnessId);
    if (known) return resolveConversation(known.id);
    [harness, harnessId, cwd, title, model] = [ref.slice(0, i), found.harnessId, found.cwd, found.title, found.model ?? null];
  }
  if (!harness) return null;
  const file = harnessId ? (await findTranscript(harness, harnessId))?.file ?? null : null;
  // Busy by the agent's own hooks only: output alone (a terminal attaching redraws the
  // screen) is a guess, and a guess shouldn't refuse a continuation.
  return { uid: live?.uid ?? rec?.id ?? null, harness, harnessId, cwd, title, file, model, live: !!live, busy: live?.status === 'busy' && live.statusSource === 'hook', session: rec?.tmux?.session ?? null };
}

const portable = new PortableService(new PortableStore(getDb()), {
  host: hostName,
  presets: () => core.presets(),
  available: (id) => core.presetAvailable(id),
  resolve: resolveConversation,
  transcripts: () => discover(1000),
  record: (uid) => core.registry.get(uid),
  freshUid: () => core.registry.freshId(),
  launch: async (o) => {
    const preset = await withCatalog(core.preset(o.preset));
    const plan = buildLaunch(preset, { ...o.sel, ...(o.resume ? { resume: o.resume } : {}) });
    const session = o.session && (await t.hasSession(o.session)) ? o.session : config.defaultSession;
    const out = await core.launch({ preset, cwd: o.cwd, session, name: o.name, command: plan.command, uid: o.uid, harnessId: o.resume, pendingResume: !!o.resume, meta: { ...plan.meta, ...o.meta, 'ah.order': core.nextOrder() } });
    await core.refreshTmuxPath();
    return out;
  },
  send: (uid, text, id) => core.send(uid, text, true, undefined, { id, remember: false }),
  transcriptHas: async (uid, needle, from) => {
    const rec = core.registry.get(uid);
    const found = rec?.harnessId ? await findTranscript(rec.harness, rec.harnessId) : null;
    return found ? fileContains(found.file, needle, from) : false;
  },
  copyTranscript: async (harness, file, cwd, upto) => {
    const out = await copyTranscript(harness, file, cwd, upto);
    await usage.copied(out.file).catch(() => {});
    return out;
  },
  removeCopy: (file) => removeCopiedTranscript(file),
  worktree: (cwd, name) => createWorktree(cwd, name),
  checkLaunch: async (id, sel) => {
    buildLaunch(await withCatalog(core.preset(id)), sel);
  },
  fork: async (ref, o) => {
    const out = await core.fork(ref, { name: o.name, model: o.model, effort: o.effort, mode: o.mode });
    return { uid: out.uid, harnessId: out.harnessId };
  },
  isDir: async (p) => !!(await stat(p).catch(() => null))?.isDirectory(),
  uploadDirs: () => [UPLOAD_DIR],
  changed: () => void core.tick().catch(() => {}),
});
core.afterTick.add(() => portable.reconcile());

// Scheduled and conditional work (server/jobs): runs from the core tick, launches only
// configured agents through core.launch, speaks through core.send (queue ids = run ids).
const transcriptOf = async (uid: string) => {
  const rec = core.registry.get(uid);
  if (!rec?.harnessId) return null;
  const adapter = core.presets().find((p) => p.id === rec.harness)?.feed;
  const found = adapter ? await findTranscript(rec.harness, rec.harnessId) : null;
  return found && adapter ? { file: found.file, adapter } : null;
};
const scheduler = new Scheduler(getDb(), {
  launch: async (o) => {
    const preset = await withCatalog(core.preset(o.preset));
    const plan = buildLaunch(preset, { model: o.model, effort: o.effort, mode: o.mode });
    const cwd = await resolveDir(o.cwd);
    const wt = o.worktree ? await createWorktree(cwd, o.name) : null;
    const session = config.defaultSession;
    await core.launch({ preset, cwd: wt?.path ?? cwd, session, name: o.name, command: plan.command, uid: o.uid, meta: { ...plan.meta, ...o.meta, ...(wt ? { 'ah.worktree': wt } : {}), 'ah.order': core.nextOrder() } });
    await core.refreshTmuxPath();
    await core.send(o.uid, o.prompt, true, undefined, { id: o.id, remember: false });
  },
  send: async (target, text, id) => {
    const out = await core.send(target, text, true, undefined, { id, remember: false });
    return { outcome: out.outcome, uid: target };
  },
  resolveTarget: async (ref) => {
    if (core.registry.get(ref)) return ref;
    const i = ref.indexOf(':');
    if (i <= 0) return null;
    return core.registry.all().find((r) => r.harness === ref.slice(0, i) && r.harnessId === ref.slice(i + 1))?.id ?? null;
  },
  checkLaunch: async (id, sel) => {
    const preset = await withCatalog(core.preset(id));
    buildLaunch(preset, sel);
    return { dangerous: !!preset.modes?.find((m) => m.id === sel.mode)?.dangerous };
  },
  record: (uid) => core.registry.get(uid),
  freshUid: () => core.registry.freshId(),
  queueIds: (uid) => core.queue(uid).map((q) => q.id),
  readTranscript: async (uid, from) => {
    const t = await transcriptOf(uid);
    return t ? readAfter(t.file, t.adapter, from) : null;
  },
  inputBox: async (uid) => {
    const w = (await core.current()).windows.find((x) => x.uid === uid);
    return w ? t.inputBox(w.id) : null;
  },
  alert: (p) => core.push.alert(p),
  changed: () => void core.tick().catch(() => {}),
  limits: () => config.jobs,
  capacity: (harness) => usage.knownLimit(harness),
  harnessOf: (uid) => core.registry.get(uid)?.harness ?? null,
});
core.jobsState = () => scheduler.state();

// Scratchpads (server/notes): notes the devices write, offline or not, and meet here.
// Handed to an agent through core.send like a typed message (queue ids = hand-off ids).
const notes = new NotesStore(getDb(), () => void core.tick().catch(() => {}));
const handoffs = new Handoffs(getDb(), {
  send: async (target, text, id) => {
    const out = await core.send(target, text, true, undefined, { id });
    if (out.outcome === 'queued') {
      // "Queued" only once the queue is on disk: a restart before that would lose it while
      // every retry answered "queued". Already taken from the queue (being typed) is fine.
      const holder = core.registry.all().find((r) => core.queue(r.id).some((q) => q.id === id));
      if (holder) await core.registry.written(holder.id).catch((err) => {
        throw new MaybeArrived(`queued, but not yet saved: ${(err as Error).message}`);
      });
    }
    return { outcome: out.outcome, resumed: out.resumed, queueId: out.queueId };
  },
  resolve: async (ref) => {
    if (core.registry.get(ref)) return ref;
    const i = ref.indexOf(':');
    if (i <= 0) return null;
    return core.registry.all().find((r) => r.harness === ref.slice(0, i) && r.harnessId === ref.slice(i + 1))?.id ?? null;
  },
  queueIds: (uid) => core.queue(uid).map((q) => q.id),
});
core.notesState = () => notes.state();

// Sessions cut off by a tmux server stop, a host restart or a closed window
// (server/interruptions): noticed, said where you'll see it, restored in one step.
const interruptions = new Interruptions({
  record: (uid) => core.registry.get(uid),
  records: () => core.registry.all(),
  setMeta: (uid, key, value) => core.registry.setMeta(uid, key, value),
  server: () => t.serverSeen(),
  file: join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'tmux-server.json'),
  queue: { items: (uid) => core.queue(uid), first: (uid, item) => core.queueFirst(uid, item), clear: (uid, id) => core.clearQueue(uid, id) },
  resume: (uid) => core.resume(uid),
  transcript: (uid) => transcriptOf(uid),
  settle: (uid, why) => recovery.settle(uid, why),
  alert: (p) => core.push.alert(p),
  changed: () => void core.tick().catch(() => {}),
});
core.interruptionsState = () => interruptions.state();
apns.goneAs = (uid) => {
  const r = core.registry.get(uid);
  const i = r ? interruptedOf(r) : null;
  return i ? { phase: 'interrupted', detail: shortWhy(i) } : null;
};

// Keeping agents going through temporary failures (server/recovery): evidence from
// transcripts, screens and sessions that died mid-turn; actions only when it's on.
const recovery = new RecoveryEngine(getDb(), {
  config: () => config.recovery,
  record: (uid) => core.registry.get(uid),
  transcript: (uid) => transcriptOf(uid),
  readLines: (file, from) => linesAfter(file, from),
  fresh: async (file, seconds) => {
    const s = await stat(file).catch(() => null);
    return !!s && Date.now() - s.mtimeMs < seconds * 1000;
  },
  // An interrupted session (server/interruptions) comes back through its restore: told first
  // what happened (under the attempt's id), its queued prompts after.
  send: async (uid, text, id) => (interruptions.pending(uid) ? { outcome: (await interruptions.restore(uid, { id, by: 'recovery' })).noted ? 'queued' : 'resumed' } : core.send(uid, text, true, undefined, { id, remember: false })),
  resume: async (uid) => void (interruptions.pending(uid) ? await interruptions.restore(uid, { by: 'recovery' }) : await core.resume(uid)),
  restartInPlace: async (uid) => {
    const rec = core.registry.get(uid);
    const w = (await core.tick()).windows.find((x) => x.uid === uid);
    // Only into a shell at its prompt, and only the agent's own resume of this conversation.
    if (!rec?.harnessId || !w || w.agent || !/^(ba|z|fi|da|k)?sh$/.test(basename(w.command))) return false;
    const preset = await withCatalog(core.preset(rec.harness));
    const plan = buildLaunch(preset, { ...resumeSelection(rec.meta as Record<string, unknown>), resume: rec.harnessId });
    await t.sendLine(w.id, plan.command);
    return true;
  },
  queueIds: (uid) => core.queue(uid).map((q) => q.id),
  alert: (p) => core.push.alert(p),
  changed: () => void core.tick().catch(() => {}),
});
core.recoveryOf = (s) => recovery.viewOf(s);

// Usage (server/usage): tokens from the agents' own transcripts, limits they reported.
const usage = new UsageService(getDb(), {
  host: hostName,
  transcripts: async () => (await discover()).map((x) => ({ harness: x.harness, harnessId: x.harnessId, file: x.file, updatedAt: x.updatedAt })),
  uidOf: (harness, harnessId) => core.registry.all().find((r) => r.harness === harness && r.harnessId === harnessId)?.id ?? null,
  config: () => config.usage,
  liveLimits: () => {
    const out: Array<{ harness: string; uid: string; resetsAt: number | null; source: 'screen' | 'transcript'; text: string }> = [];
    for (const r of recovery.listNow()) if (r.reason === 'rate_limit' && r.harness) out.push({ harness: r.harness, uid: r.uid, resetsAt: r.resetsAt, source: r.source === 'screen' ? 'screen' : 'transcript', text: r.evidence });
    return out;
  },
});
core.onCopy = (file) => void usage.copied(file).catch(() => {});
core.registry.onEnd = (r, last) => {
  interruptions.ended(r, last);
  recovery.sessionEnded(r, last);
};
core.afterTick.add(() => interruptions.tick());
core.afterTick.add((state) => recovery.tick(state.windows));
core.afterTick.add((state) => scheduler.tick(state.windows));

// Moving stopped sessions between hosts (server/migrate): the source pushes to a peer with
// the token that peer issued it; the destination restores into its own stores.
const migrations = new MigrationService(getDb(), {
  host: hostName,
  home: () => homedir(),
  stateDir: join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah'),
  uploadsDir: UPLOAD_DIR,
  limits: () => config.uploads,
  peer: (name) => peers.get(name),
  resolve: resolveConversation,
  record: (uid) => core.registry.get(uid),
  restoreRecord: (r) => core.registry.restore(r),
  removeRecord: (uid) => core.registry.remove(uid),
  setMeta: (uid, k, v) => core.registry.setMeta(uid, k, v),
  freshUid: () => core.registry.freshId(),
  presets: () => core.presets(),
  available: (id) => core.presetAvailable(id),
  exportDoc: (ref) => portable.export(ref),
  portable: portable.store,
  envNames: async () => (await envStore.list()).vars.map((v) => v.name),
  findTranscript: async (harness, harnessId) => {
    const adapter = core.presets().find((p) => p.id === harness)?.feed ?? harness;
    return (await discover(0)).find((x) => x.harness === adapter && x.harnessId === harnessId) ?? null;
  },
  isLive: (uid) => !!core.registry.get(uid) && (core.registry.get(uid)!.lifecycle === 'live' || core.registry.get(uid)!.lifecycle === 'starting'),
  rules: () => config.migration.pathMap,
  copied: (file) => void usage.copied(file).catch(() => {}),
  roots: () => [...new Set([...config.projectRoots, ...config.files.roots].map(expandHome))],
  changed: () => void core.tick().catch(() => {}),
});
const gate = new Gate();

// Browser previews (server/preview.ts): a session's dev server behind ah's own
// sign-in, each on a port of its own. Tests and setups without Tailscale skip
// publishing (AH_PREVIEW_PUBLISH=0); the loopback port still works locally.
const ahPort = () => (server?.address() as AddressInfo | null)?.port ?? PORT;
const previews = new Previews({
  authorize: (req) => {
    const verdict = gate.check(req);
    if (!verdict.ok) return { status: verdict.status, reason: verdict.reason };
    return auth.identify(req) ? null : { status: 401, reason: 'sign in required' };
  },
  frameAncestors: () => [...(gate.tailnet ? [`https://${gate.tailnet.dnsName}`] : []), `http://localhost:${ahPort()}`, `http://127.0.0.1:${ahPort()}`],
  publish: process.env.AH_PREVIEW_PUBLISH === '0' ? null : { add: (p) => (gate.tailnet ? tailscalePublish.add(p) : Promise.reject(new Error('no tailnet'))), remove: tailscalePublish.remove },
  range: config.preview.ports,
});
const isPreviewPort = (p: number) => p === ahPort() || (p >= config.preview.ports[0] && p <= config.preview.ports[1]);

/** Keeps previews in step with sessions: back after a restart or a resume, gone with the session. */
async function syncPreviews() {
  const running = new Set(previews.list().map((p) => p.uid));
  for (const rec of core.registry.all()) {
    const want = (rec.meta['ah.preview'] as { target?: number } | undefined)?.target;
    const live = running.has(rec.id) || want ? await core.sessionPids(rec.id) : null;
    if (want && live && !running.has(rec.id)) await previews.start(rec.id, want).catch((err) => console.warn(`preview for ${rec.id}: ${(err as Error).message}`));
    if (running.has(rec.id) && !live) await previews.stop(rec.id);
  }
}
const peers = new Peers(config.peers, PORT);
core.peers = peers;
setRoots(config.files.roots.map(expandHome));


/** Routes reachable without signing in: only what's needed to sign in. Everything else is denied. */
export const PUBLIC_ROUTES = new Set([
  'GET /api/hello',
  'GET /api/auth/status',
  'POST /api/auth/register/options', // needs a host-issued setup code (or a session) inside
  'POST /api/auth/register/verify',
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  'POST /api/auth/password/login',
  'POST /api/auth/logout',
  // The native app's sign-in: enrollment still needs a host-issued code (or a session) inside.
  'POST /api/auth/native/enroll/options',
  'POST /api/auth/native/enroll/verify',
  'POST /api/auth/native/login/options',
  'POST /api/auth/native/login/verify',
]);

/** Native sign-in routes: writes before there is a caller, so they can't carry a bearer yet. */
const NATIVE_SIGN_IN = /^(?:\/h\/[\w.-]{1,64})?\/api\/auth\/native\/(?:enroll|login)\/(?:options|verify)$/;

/**
 * The native app has no Origin: it isn't a web page. Its writes and terminals skip the
 * same-Origin check only when nothing ambient rides along: no Origin and no cookie, and
 * either a native bearer sign-in or the native sign-in routes themselves. A browser always
 * sends Origin on writes and WebSockets, can't attach Authorization or X-AH cross-site
 * without a preflight ah never grants, and never sees a native bearer secret, so the
 * browser's CSRF defenses are unchanged.
 */
function nativeWithoutOrigin(req: IncomingMessage, caller: Caller | null, path: string): boolean {
  if (req.headers.origin !== undefined || req.headers.cookie !== undefined) return false;
  return auth.isNative(caller) || NATIVE_SIGN_IN.test(path);
}

function recoveryError(err: unknown): never {
  if (err instanceof RecoveryError) throw new HttpError(err.status, err.message, err.code);
  throw err;
}

function audit(req: IncomingMessage, event: string, detail: Record<string, unknown> = {}) {
  auth.audit(event, { ...detail, from: String(req.headers['tailscale-user-login'] ?? 'local') });
}

async function projectSuggestions(windowPaths: string[]): Promise<string[]> {
  const out = new Set<string>(windowPaths);
  for (const root of config.projectRoots) {
    const dir = expandHome(root);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) out.add(shortPath(join(dir, e.name)));
    }
  }
  out.add('~');
  return [...out];
}

/** Query params for /api/search and /api/search/all. Values are only ever bound parameters downstream. */
function searchParams(url: URL): SearchParams {
  const scope = url.searchParams.get('in');
  const num = (k: string) => {
    const n = Number(url.searchParams.get(k));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    q: (url.searchParams.get('q') ?? '').slice(0, 500),
    scope: scope === 'transcripts' || scope === 'chats' ? scope : 'all',
    role: url.searchParams.get('role') ?? undefined,
    project: url.searchParams.get('p') ?? undefined,
    host: url.searchParams.get('h') ?? undefined,
    model: url.searchParams.get('m') ?? undefined,
    limit: num('limit'),
    offset: num('offset'),
    from: num('from'),
    to: num('to'),
    order: url.searchParams.get('sort') === 'recent' ? 'recent' : undefined,
  };
}

/**
 * What "restart the server" runs. AH_RESTART_CMD overrides the unit restart,
 * so tests can stub the side effect (e.g. `touch flagfile`) instead of
 * bouncing a real systemd unit.
 */
function restartCommand(): string[] {
  const override = process.env.AH_RESTART_CMD?.trim();
  if (override) return ['/bin/sh', '-c', override];
  return ['systemctl', '--user', 'restart', 'ah'];
}

/** One rebuild at a time. A second click while a build is running is refused. */
let rebuilding = false;

// Answer first, then bounce. The restart stops this process; systemd brings it back.
function scheduleRestart() {
  setTimeout(() => {
    const [cmd, ...args] = restartCommand();
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`restart failed: ${err.message}`));
    child.unref();
  }, 100);
}

// ---------- API (reached only after the gate in handle())

async function api(req: IncomingMessage, res: ServerResponse, url: URL, path: string, caller: Caller | null) {
  let method = req.method ?? 'GET';
  const route = (verb: string, re: RegExp) => (method === verb ? path.match(re) : null);
  let m: RegExpMatchArray | null;

  if (route('GET', /^\/api\/hello$/)) return send(res, 200, { ah: true, hostname: hostName(), auth: auth.enabled, features: features() });
  if (path.startsWith('/api/auth/')) return authApi(req, res, path, method, caller);
  if (!caller) throw new HttpError(401, 'sign in required'); // belt and braces; handle() already denied

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/terminal$/))) {
    return send(res, 200, { terminal: await terminals.get(m[1]) });
  }
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/terminal$/))) {
    const uid = m[1];
    const body = await readJson(req);
    const command = body.command === undefined ? undefined : str(body.command, 'command', 60_000);
    if (command !== undefined && !command.trim()) throw new HttpError(400, 'command required');
    const terminal = await terminals.open(uid, command);
    audit(req, command === undefined ? 'terminal.open' : 'terminal.run', { uid });
    await core.tick();
    return send(res, 200, { terminal });
  }
  if ((m = route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/terminal$/))) {
    await terminals.close(m[1]);
    audit(req, 'terminal.close', { uid: m[1] });
    await core.tick();
    return send(res, 200, { ok: true });
  }

  // A session by its uid, which outlives tmux windows (resume, relaunch, a tmux restart): the
  // window routes below, resolved to the window the session has now. Naming the session means a
  // request can't land in a different window that took its place.
  const bySession = path.match(/^\/api\/sessions\/([\w-]{1,40})\/(changes|branches|pull|chat|chat\/subscription|capture|name|terminate)$/);
  if (bySession) {
    const [, uid, what] = bySession;
    const verb = what === 'name' ? 'PUT' : what === 'terminate' ? 'POST' : null;
    if (verb && method !== verb) throw new HttpError(405, 'method not allowed');
    const win = (await core.current()).windows.find((w) => w.uid === uid);
    if (!win) throw new HttpError(404, "the session isn't running");
    path = `/api/windows/${win.id}${verb ? '' : `/${what}`}`;
    if (what === 'name') method = 'PATCH';
    if (what === 'terminate') method = 'DELETE';
  }
  if (path.startsWith('/api/review/')) return reviewApi(req, res, url, path, review, audit);
  if (path.startsWith('/api/portable/')) return portableApi(req, res, url, path, portable, audit);
  if (path === '/api/migrations' || path.startsWith('/api/migrations/')) return migrateApi(req, res, path, caller, migrations, audit);
  if (path === '/api/jobs' || path.startsWith('/api/jobs/')) return jobsApi(req, res, path, caller, scheduler, audit);
  if (path === '/api/notes' || path.startsWith('/api/notes/')) return notesApi(req, res, url, path, caller, { store: notes, handoffs, host: hostName, audit });

  // Usage (server/usage): tokens, limits and estimates, each with where it came from.
  if (route('GET', /^\/api\/usage$/)) {
    const by = url.searchParams.get('by') ?? 'model';
    if (!['day', 'model', 'provider', 'harness', 'session'].includes(by)) throw new HttpError(400, 'by is day, model, provider, harness or session', 'invalid_group');
    const day = (k: string) => {
      const v = url.searchParams.get(k);
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${k} is a date (YYYY-MM-DD)`, 'invalid_date');
      return v ?? undefined;
    };
    return send(res, 200, await usage.report({ from: day('from'), to: day('to'), by: by as 'model' }));
  }
  if (route('GET', /^\/api\/usage\/limits$/)) return send(res, 200, await usage.limits());
  if (route('POST', /^\/api\/usage\/refresh$/)) return send(res, 200, await usage.ingest());
  if (route('GET', /^\/api\/usage\/export$/)) {
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
    const body = await usage.export(format);
    res.writeHead(200, { 'content-type': format === 'json' ? 'application/json' : 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ah-usage-${hostName()}.${format}"`, 'cache-control': 'no-store' });
    return void res.end(body);
  }
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/usage$/))) {
    const rec = core.registry.get(m[1]);
    if (!rec?.harnessId) throw new HttpError(404, 'no conversation for that session', 'not_found');
    return send(res, 200, await usage.session(rec.harness, rec.harnessId));
  }

  // Recovery (server/recovery): what went wrong in a session, what ah will do, and your controls.
  // Interrupted sessions (server/interruptions): the list, restore one or all, dismiss.
  if (route('GET', /^\/api\/interruptions$/)) return send(res, 200, { interruptions: interruptions.list(), ...interruptions.state() });
  if ((m = route('POST', /^\/api\/interruptions\/(restore|dismiss)$/))) {
    const body = await readJson(req);
    const action = m[1];
    const uids = body.uids === undefined ? undefined : Array.isArray(body.uids) && body.uids.length <= 200 && body.uids.every((u: unknown) => typeof u === 'string' && /^[\w-]{1,40}$/.test(u)) ? (body.uids as string[]) : null;
    if (uids === null) throw new HttpError(400, 'uids must be a list of session ids', 'invalid_uids');
    const incident = body.incident === undefined ? undefined : typeof body.incident === 'string' && /^[\w-]{1,80}$/.test(body.incident) ? body.incident : null;
    if (incident === null) throw new HttpError(400, 'incident must be an incident id', 'invalid_incident');
    // Everything at once only when you say so: no filter and no `all` is a mistake, not "all".
    if (!uids && !incident && body.all !== true) throw new HttpError(400, 'name uids, an incident, or all: true', 'invalid_target');
    if (action === 'dismiss') {
      const dismissed = interruptions.dismiss({ uids, incident });
      audit(req, 'interruptions.dismiss', { uids: uids?.length ?? null, incident: incident ?? null, dismissed });
      return send(res, 200, { dismissed });
    }
    const out = await interruptions.restoreAll({ uids, incident, note: body.note !== false });
    audit(req, 'interruptions.restore', { restored: out.restored.map((r) => r.uid), failed: out.failed.map((f) => f.uid) });
    return send(res, 200, out);
  }
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/restore$/))) {
    const body = await readJson(req);
    try {
      const out = await interruptions.restore(m[1], { note: body.note !== false, by: 'you' });
      audit(req, 'session.restore', { uid: m[1], window: out.windowId, noted: out.noted });
      return send(res, out.resumed ? 201 : 200, out);
    } catch (err) {
      if (err instanceof InterruptionError) throw new HttpError(err.status, err.message, err.code);
      throw err;
    }
  }
  if (route('GET', /^\/api\/recovery$/)) return send(res, 200, { recoveries: await recovery.list(), config: { auto: config.recovery.auto, maxAttempts: config.recovery.maxAttempts } });
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/recovery$/))) return send(res, 200, await recovery.get(m[1]).catch(recoveryError));
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/recovery$/))) {
    const body = await readJson(req);
    const uid = m[1];
    if (!core.registry.get(uid)) throw new HttpError(404, 'session not found');
    if (body.auto !== undefined) {
      if (typeof body.auto !== 'boolean') throw new HttpError(400, 'auto must be true or false', 'invalid_auto');
      core.registry.setMeta(uid, 'ah.recovery.auto', body.auto);
      await recovery.autoChanged(uid);
      audit(req, 'recovery.auto', { uid, auto: body.auto });
      core.tick().catch(() => {});
      return send(res, 200, await recovery.get(uid));
    }
    const action = body.action;
    if (action !== 'retry' && action !== 'pause' && action !== 'resume' && action !== 'cancel') throw new HttpError(400, 'action must be retry, pause, resume or cancel', 'invalid_action');
    const out = await recovery.control(uid, action, (await core.current()).windows).catch(recoveryError);
    audit(req, `recovery.${action}`, { uid });
    return send(res, 200, out);
  }

  if (route('GET', /^\/api\/state$/)) return send(res, 200, await core.current());

  // What this host supports, with each feature's limits (server/features.ts).
  if (route('GET', /^\/api\/capabilities$/)) {
    return send(res, 200, {
      api: API_VERSION,
      host: hostName(),
      features: features(),
      uploads: { maxBytes: config.uploads.maxBytes, maxTotalBytes: config.uploads.maxTotalBytes, idleMs: config.uploads.idleMs },
    });
  }

  if (route('GET', /^\/api\/events$/)) {
    // Server-sent state pushes: one stream per client instead of polling.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // The whole state first, then patches (only the fields that changed; web/api.ts merges them).
    let sent = false;
    // ?delta=1: windows as per-window deltas (web/api.ts); an older page gets the whole list.
    const deltas = url.searchParams.get('delta') === '1';
    const unsubscribe = core.subscribe((json, patch, slim) => {
      if (sent && patch) sse(res, `event: patch\ndata: ${deltas && slim ? slim : patch}\n\n`);
      else sse(res, `event: state\ndata: ${json}\n\n`);
      sent = true;
    });
    const ping = setInterval(() => sse(res, ': ping\n\n'), 25_000);
    const untrack = auth.track(caller, { close: () => res.end() });
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      untrack();
    });
    return;
  }

  if (route('GET', /^\/api\/projects$/)) {
    const state = await core.current();
    return send(res, 200, await projectSuggestions([...new Set(state.windows.map((w) => w.projectPath))]));
  }

  // The new-session form asks before it offers to create a folder.
  if (route('GET', /^\/api\/dir$/)) {
    const path = (url.searchParams.get('path') ?? '').trim().slice(0, 1024) || '~';
    return send(res, 200, { state: await dirStatus(path), root: shortPath(expandHome(config.projectRoots[0] ?? '~')) });
  }

  if (route('POST', /^\/api\/windows$/)) {
    const body = await readJson(req);
    const preset = await withCatalog(core.preset(str(body.preset, 'preset', 40)));
    const asked = str(body.cwd ?? '~', 'cwd', 1024).trim() || '~';
    // A new project: one new folder inside an existing one, within the file roots.
    let created = false;
    if (body.create && (await dirStatus(asked)) === 'new') {
      const dir = await makeDir(asked);
      created = true;
      if (body.git) await initRepo(dir);
      audit(req, 'project.create', { path: dir, git: !!body.git });
    }
    const cwd = await resolveDir(asked);
    const session = t.sanitizeSessionName(str(body.session || config.defaultSession, 'session', 64));
    if (!session) throw new HttpError(400, 'invalid session');
    const name = str(body.label ?? '', 'label', 80).trim() || defaultName(preset, cwd);
    // Structured launch options (F42): mode/model ids plus a free-form tail.
    const mode = body.mode === undefined ? undefined : str(body.mode, 'mode', 40);
    const model = body.model === undefined ? undefined : str(body.model, 'model', 80);
    const effort = body.effort === undefined ? undefined : str(body.effort, 'effort', 20);
    const extraArgs = body.extraArgs === undefined ? undefined : str(body.extraArgs, 'extraArgs', 2048);
    let command: string;
    let launchMeta: Record<string, unknown>;
    try {
      const plan = buildLaunch(preset, {
        mode,
        model,
        effort,
        extraArgs,
        resume: body.resume && preset.resume ? true : undefined,
      });
      command = plan.command;
      launchMeta = { ...plan.meta };
    } catch (err) {
      if (err instanceof LaunchError) throw new HttpError(400, err.message);
      throw err;
    }
    // One writing agent per checkout (F29): optionally start in a fresh worktree + branch.
    const wt = body.worktree && !created ? await createWorktree(cwd, name) : null;
    const order = core.nextOrder();
    const out = await core.launch({
      preset,
      cwd: wt?.path ?? cwd,
      session,
      name,
      command,
      // "Skip startup confirmations": ah accepts the agent's folder-trust prompt.
      meta: { ...launchMeta!, ...(wt ? { 'ah.worktree': wt } : {}), ...(body.trust === true && preset.trust ? { 'ah.launch.trust': true } : {}), 'ah.order': order },
    });
    audit(req, 'session.create', { window: out.windowId, uid: out.uid, preset: preset.id, cwd: wt?.path ?? cwd, branch: wt?.branch, ...(body.trust === true && preset.trust ? { trust: true } : {}) });
    await core.refreshTmuxPath();
    return send(res, 201, { id: out.windowId, uid: out.uid });
  }

  // Sessions are addressed by registry id, or `harness:harnessId` for discovered history.
  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/resume$/))) {
    const out = await core.resume(m[1]);
    if (out.resumed) audit(req, 'session.resume', { ref: m[1], window: out.windowId });
    return send(res, out.resumed ? 201 : 200, { id: out.windowId, uid: out.uid, resumed: out.resumed });
  }

  // Fork (F36): what the dialog needs, then the fork itself.
  if ((m = route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/fork-info$/))) {
    try {
      return send(res, 200, await core.forkInfo(m[1]));
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/fork$/))) {
    const body = await readJson(req);
    const opt = (k: string, max: number) => (body[k] === undefined ? undefined : str(body[k], k, max).trim() || undefined);
    try {
      const out = await core.fork(m[1], {
        name: opt('name', 80),
        prompt: opt('prompt', 32 * 1024),
        model: opt('model', 80),
        effort: opt('effort', 20),
        mode: opt('mode', 40),
      });
      audit(req, 'session.fork', { ref: m[1], uid: out.uid, window: out.id, branch: out.branch });
      return send(res, 201, out);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/send$/))) {
    const body = await readJson(req);
    const out = await core.send(m[1], str(body.text, 'text', 32 * 1024), body.enter !== false);
    audit(req, 'session.send', { ref: m[1], window: out.windowId, outcome: out.outcome, resumed: out.resumed });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/answer$/))) {
    const body = await readJson(req);
    const answer = body.answer;
    if (answer !== 'approve' && answer !== 'deny') throw new HttpError(400, 'answer must be approve or deny');
    // The prompt the caller saw (`askId`), optional: older clients send none.
    const prompt = body.prompt === undefined || body.prompt === null ? undefined : str(body.prompt, 'prompt', 64);
    await core.answer(m[1], answer, prompt);
    audit(req, `session.${answer}`, { uid: m[1] });
    return send(res, 200, { ok: true });
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/commands$/))) {
    const { preset, cwd } = await core.sessionPlace(m[1]);
    return send(res, 200, preset ? await slashCommands(preset, cwd) : []);
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/files$/))) {
    const { cwd } = await core.sessionPlace(m[1]);
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    return send(res, 200, await projectFiles(cwd, q));
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/choose$/))) {
    const key = str((await readJson(req)).key, 'key', 8);
    const option = await core.choose(m[1], key);
    audit(req, 'session.choose', { uid: m[1], key, label: option.label.slice(0, 80) });
    return send(res, 200, { ok: true, label: option.label });
  }

  // The screen in front of an agent's prompt: what it asks to have typed (a code, an
  // API key — never logged), Esc back a step where it says so, or the address a
  // browser elsewhere ended on after a sign-in that hands back to this host.
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/gate$/))) {
    const body = await readJson(req);
    // A sign-in's callback address carries its one-time code: never in the audit log.
    if (body.callback !== undefined) {
      const { status } = await core.answerGate(m[1], { callback: str(body.callback, 'callback', 8192) });
      audit(req, 'session.gate', { uid: m[1], callback: true, status });
      return send(res, 200, { ok: true, status });
    }
    if (body.back === true) await core.answerGate(m[1], { back: true });
    else await core.answerGate(m[1], { text: str(body.text, 'text', 4000) });
    audit(req, 'session.gate', { uid: m[1], ...(body.back === true ? { back: true } : { typed: true }) });
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/questions$/))) {
    const body = await readJson(req);
    const answerOf = (a: any) => ({
      picked: Array.isArray(a?.picked) ? a.picked.slice(0, 9) : [],
      ...(a?.text !== undefined ? { text: str(a.text, 'text', 2000) } : {}),
      ...(a?.notes !== undefined ? { notes: str(a.notes, 'notes', 2000) } : {}),
    });
    if (body.chat === true) {
      // "Chat about this": decline the questions and talk it over instead.
      await core.chatAboutQuestions(m[1], body.question === undefined ? undefined : str(body.question, 'question', 2000));
      audit(req, 'session.questions.chat', { uid: m[1] });
      return send(res, 200, { ok: true });
    }
    if (body.current) {
      // One question: the one the dialog shows now.
      const current = body.current as { question?: unknown; answer?: unknown };
      await core.answerDialogQuestion(m[1], str(current.question, 'question', 2000), answerOf(current.answer));
      audit(req, 'session.questions', { uid: m[1], count: 1 });
      return send(res, 200, { ok: true });
    }
    if (!Array.isArray(body.answers) || body.answers.length > 8) throw new HttpError(400, 'answers must be a list');
    const answers = body.answers.map(answerOf);
    await core.answerQuestions(m[1], answers);
    audit(req, 'session.questions', { uid: m[1], count: answers.length });
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/switch$/))) {
    const body = await readJson(req);
    const change = {
      ...(body.model !== undefined ? { model: str(body.model, 'model', 80) } : {}),
      ...(body.effort !== undefined ? { effort: str(body.effort, 'effort', 20) } : {}),
    };
    const out = await core.switchLaunch(m[1], change);
    audit(req, 'session.switch', { uid: m[1], ...change, outcome: out.outcome });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/mode$/))) {
    const mode = str((await readJson(req)).mode, 'mode', 40);
    const out = await core.switchMode(m[1], mode);
    audit(req, 'session.mode', { uid: m[1], mode, switched: out.switched });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/settings$/))) {
    const setting = (await readJson(req)).setting;
    if (setting !== 'model' && setting !== 'effort' && setting !== 'mode') throw new HttpError(400, 'unknown setting');
    const out = await core.openSettings(m[1], setting);
    audit(req, 'session.settings', { uid: m[1], setting, outcome: out.outcome });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/relaunch$/))) {
    const body = await readJson(req);
    const change = {
      ...(body.model !== undefined ? { model: str(body.model, 'model', 80) } : {}),
      ...(body.effort !== undefined ? { effort: str(body.effort, 'effort', 20) } : {}),
      ...(body.mode !== undefined ? { mode: str(body.mode, 'mode', 40) } : {}),
    };
    const out = await core.relaunch(m[1], change);
    audit(req, 'session.relaunch', { uid: m[1], ...change, window: out.id });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/interrupt$/))) {
    await core.interrupt(m[1]);
    audit(req, 'session.interrupt', { uid: m[1] });
    return send(res, 200, { ok: true });
  }

  // GUI view: the session's transcript as typed events (server/feed). A stream of
  // snapshot/append messages, plus pages of older entries on demand.
  if ((m = route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed\/stream$/))) {
    const ref = m[1];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const done = new AbortController();
    const ping = setInterval(() => sse(res, ': ping\n\n'), 25_000);
    const untrack = auth.track(caller, { close: () => res.end() });
    // Reading the GUI is looking at the session, the same as its terminal.
    const device = (url.searchParams.get('device') ?? '').slice(0, 60) || 'browser';
    let leave: (() => void) | null = null;
    void core.current().then((st) => {
      const win = st.windows.find((w) => w.uid === ref);
      if (win && !done.signal.aborted) leave = addViewer(win.id, device, clientId(url.searchParams.get('client')));
    });
    req.on('close', () => {
      done.abort();
      clearInterval(ping);
      untrack();
      leave?.();
    });
    // A viewer holding the transcript up to an entry carries on from it (feed/stream.ts Resume).
    const after = Number(url.searchParams.get('after'));
    const resume = Number.isInteger(after) && after > 0 ? { after, id: url.searchParams.get('id') ?? '', harness: url.searchParams.get('harness') ?? '' } : null;
    streamFeed((fresh) => core.feedSource(ref, fresh ? 3000 : 15_000), (msg) => sse(res, `event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`), done.signal, resume);
    return;
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed\/prompts$/))) {
    const prompts = await feedPrompts(() => core.feedSource(m![1]));
    if (!prompts) throw new HttpError(404, 'no transcript');
    return send(res, 200, { prompts });
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed$/))) {
    const before = Number(url.searchParams.get('before') ?? Infinity);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || SNAPSHOT));
    if (Number.isNaN(before)) throw new HttpError(400, 'invalid before');
    const page = await feedPage(() => core.feedSource(m![1]), before, limit);
    if (!page) throw new HttpError(404, 'no transcript');
    return send(res, 200, page);
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/queue$/))) return send(res, 200, core.queue(m[1]));

  if ((m = route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/queue(?:\/([\w-]{1,40}))?$/))) {
    core.clearQueue(m[1], m[2]);
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/move$/))) {
    const to = (await readJson(req)).to;
    if (!Number.isInteger(to) || (to as number) < 0 || (to as number) > 1000) throw new HttpError(400, 'invalid position');
    try {
      return send(res, 200, core.moveQueued(m[1], m[2], to as number));
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  // Browser preview: one per session, of a port its dev server listens on.
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/preview$/))) {
    const pids = await core.sessionPids(m[1]);
    const ports = pids ? (await listeningPorts(pids)).filter((p) => !isPreviewPort(p)) : [];
    return send(res, 200, { preview: previews.get(m[1]), ports, live: !!pids });
  }
  if ((m = route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/preview$/))) {
    const target = (await readJson(req)).target;
    if (!Number.isInteger(target) || (target as number) < 1 || (target as number) > 65535 || isPreviewPort(target as number)) throw new HttpError(400, 'invalid port');
    if (!(await core.sessionPids(m[1]))) throw new HttpError(404, 'session not running');
    const preview = await previews.start(m[1], target as number);
    core.registry.setMeta(m[1], 'ah.preview', { target });
    audit(req, 'preview.start', { uid: m[1], target, port: preview.port });
    return send(res, 200, { preview });
  }
  if ((m = route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/preview$/))) {
    await previews.stop(m[1]);
    core.registry.setMeta(m[1], 'ah.preview', undefined);
    audit(req, 'preview.stop', { uid: m[1] });
    return send(res, 200, { ok: true });
  }

  // Urgent follow-up: deliver one queued message now, stopping the live turn.
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/send-now$/))) {
    const out = await core.sendNow(m[1], m[2]);
    audit(req, 'session.send-now', { uid: m[1], window: out.windowId });
    return send(res, 200, out);
  }

  // Per-turn snapshots (F39): list, restore (with safety snapshot), toggle.
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/snapshots$/))) {
    try {
      return send(res, 200, await core.listSnapshots(m[1]));
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/snapshots\/(\d{1,9})\/restore$/))) {
    const body = await readJson(req);
    try {
      const out = await core.restoreSnapshot(m[1], Number(m[2]), { interrupt: body.interrupt === true });
      audit(req, 'snapshot.restore', { uid: m[1], turn: Number(m[2]), safetyId: out.safety.id, safetyTurn: out.safety.turn });
      return send(res, 200, out);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/snapshots\/toggle$/))) {
    const body = await readJson(req);
    try {
      core.setSnapshotsEnabled(m[1], body.enabled !== false);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
    audit(req, 'snapshot.toggle', { uid: m[1], enabled: body.enabled !== false });
    return send(res, 200, { ok: true });
  }

  // Handoff: the session this device is on, so another device can offer to continue it.
  if (route('POST', /^\/api\/focus$/)) {
    const body = await readJson(req);
    const key = str(body.key, 'key', 120);
    if (!/^(?:[\w.-]{1,64}\/)?[\w-]{1,40}$/.test(key)) throw new HttpError(400, 'invalid key');
    core.setFocus({ key, device: str(body.device ?? '', 'device', 40).replace(/[^\w .-]/g, '').slice(0, 24) || 'browser', client: str(body.client ?? '', 'client', 40) });
    return send(res, 200, { ok: true });
  }

  // Unsent composer text, so a draft follows you between devices (server/drafts.ts).
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/draft$/))) return send(res, 200, { draft: drafts.get(m[1]) });
  if ((m = route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/draft$/))) {
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 32 * 1024);
    return send(res, 200, { draft: drafts.set(m[1], text, str(body.device ?? '', 'device', 40), str(body.client ?? '', 'client', 40)) });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/pin$/))) {
    core.setPinned(m[1], (await readJson(req)).pinned !== false);
    return send(res, 200, { ok: true });
  }

  // ---------- system: host-level actions behind Settings → System

  if (route('GET', /^\/api\/system\/hooks$/)) return send(res, 200, { ...hooksStatus(), audit: screenAudit.summary() });
  if (route('DELETE', /^\/api\/system\/screen-audit$/)) {
    screenAudit.reset();
    return send(res, 200, { ok: true });
  }

  // ah in the host's app launcher, in its own window (server/desktop.ts), like the hooks card.
  if (route('GET', /^\/api\/system\/desktop$/)) return send(res, 200, desktopStatus(config.port));
  if (route('POST', /^\/api\/system\/desktop$/)) {
    const action = (await readJson(req)).action;
    if (action !== 'install' && action !== 'uninstall') throw new HttpError(400, 'action must be install or uninstall');
    let messages: string[];
    try {
      messages = action === 'install' ? installDesktop(config.port) : removeDesktop();
    } catch (err) {
      throw new HttpError(500, (err as Error).message);
    }
    audit(req, `system.desktop.${action}`);
    return send(res, 200, { messages, status: desktopStatus(config.port) });
  }

  if (route('GET', /^\/api\/omarchy\/theme$/)) return send(res, 200, omarchyTheme());

  // Settings → Agents (server/harnesses.ts): what each CLI's installed version offers,
  // which agents New session shows, and agents added by hand.
  if (route('GET', /^\/api\/harnesses$/)) return send(res, 200, core.harnessList());
  if (route('POST', /^\/api\/harnesses\/check$/)) {
    audit(req, 'harnesses.check');
    await core.checkHarnesses(true);
    return send(res, 200, core.harnessList());
  }
  if (route('POST', /^\/api\/harnesses\/custom$/)) {
    const body = await readJson(req);
    let added;
    try {
      added = core.harnesses!.addCustom(body, config.presets.map((p) => p.id));
    } catch (err) {
      throw new HttpError(400, `An added agent needs ${(err as Error).message}.`);
    }
    audit(req, 'harnesses.add', { id: added.id, command: added.command });
    core.applyHarnesses();
    await core.checkHarnesses();
    return send(res, 200, core.harnessList());
  }
  if ((m = route('DELETE', /^\/api\/harnesses\/custom\/([\w-]{1,48})$/))) {
    if (!core.harnesses!.removeCustom(m[1])) throw new HttpError(404, 'no such agent');
    audit(req, 'harnesses.remove', { id: m[1] });
    core.applyHarnesses();
    await core.tick();
    return send(res, 200, core.harnessList());
  }
  if ((m = route('POST', /^\/api\/harnesses\/([\w-]{1,48})$/))) {
    const hidden = (await readJson(req)).hidden;
    if (typeof hidden !== 'boolean') throw new HttpError(400, 'hidden must be true or false');
    if (!config.presets.some((p) => p.id === m![1] && p.command.trim())) throw new HttpError(404, 'no such agent');
    core.harnesses!.setHidden(m[1], hidden);
    await core.tick();
    return send(res, 200, core.harnessList());
  }

  if (route('POST', /^\/api\/system\/hooks$/)) {
    const action = (await readJson(req)).action;
    if (action !== 'install' && action !== 'uninstall') throw new HttpError(400, 'action must be install or uninstall');
    const messages = action === 'install' ? [installClaude(), installCodex()] : [uninstallClaude(), uninstallCodex()];
    audit(req, `system.hooks.${action}`);
    return send(res, 200, { messages, status: hooksStatus() });
  }

  if (route('POST', /^\/api\/system\/restart$/)) {
    audit(req, 'system.restart');
    // `systemctl --user restart ah` stops (SIGTERM → graceful drain above) and
    // starts us again. Live processes belong to ah-tmux.service and never
    // notice; ended records keep their resume data in SQLite.
    send(res, 200, { ok: true });
    scheduleRestart();
    return;
  }

  if (route('POST', /^\/api\/system\/rebuild$/)) {
    if (rebuilding) throw new HttpError(409, 'a rebuild is already running');
    audit(req, 'system.rebuild');
    rebuilding = true;
    // Tests stub the whole side effect. The real path clears dist, builds, answers, then restarts.
    const override = process.env.AH_REBUILD_CMD?.trim();
    try {
      if (override) {
        await promisify(execFile)('/bin/sh', ['-c', override], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      } else {
        console.log('rebuild: clearing dist and building');
        await rebuildWeb(ROOT, DIST);
      }
    } catch (err) {
      const msg = rebuildFailure(err);
      console.error(`rebuild failed: ${msg}`);
      // Sent here so the build log reaches the page. A thrown 500 is replaced with "internal error".
      return send(res, 500, { error: msg });
    } finally {
      rebuilding = false;
    }
    send(res, 200, { ok: true });
    if (!override) {
      console.log('rebuild finished; restarting');
      scheduleRestart();
    }
    return;
  }

  if (route('POST', /^\/api\/system\/uploads\/clear$/)) {
    try {
      const removed = await clearUploadDir(UPLOAD_DIR);
      audit(req, 'system.uploads.clear', { removed });
      return send(res, 200, { ok: true, removed });
    } catch (err) {
      const msg = (err as Error).message || 'could not clear uploads';
      console.error(`clear uploads failed: ${msg}`);
      return send(res, 500, { error: msg });
    }
  }

  // Manual sidebar order (F43): sparse key, persisted in the registry, synced to every device over SSE.
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/order$/))) {
    const body = await readJson(req);
    const order = Number(body.order);
    if (!Number.isFinite(order)) throw new HttpError(400, 'invalid order');
    try {
      await core.setOrder(m[1], order);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
    return send(res, 200, { ok: true });
  }

  if ((m = route('DELETE', /^\/api\/sessions\/([\w:.-]{1,80})$/))) {
    await core.forget(m[1]);
    await terminals.close(m[1]);
    return send(res, 200, { ok: true });
  }

  // ---------- files (explorer + transfer), confined to config.files.roots

  if (route('GET', /^\/api\/fs\/list$/)) {
    return send(res, 200, { ...(await list(url.searchParams.get('path') || roots()[0], url.searchParams.get('hidden') === '1')), roots: roots().map(shortPath) });
  }

  if (route('GET', /^\/api\/fs\/file$/)) return sendFile(res, url.searchParams.get('path') ?? '', url.searchParams.get('download') === '1');

  if (route('POST', /^\/api\/fs\/upload$/)) {
    const path = await receive(req, url.searchParams.get('dir') ?? '', url.searchParams.get('name') ?? '', config.uploads);
    audit(req, 'file.upload', { path });
    return send(res, 201, { path });
  }

  if (route('POST', /^\/api\/fs\/mkdir$/)) return send(res, 201, { path: await makeDir(str((await readJson(req)).path, 'path', 1024)) });

  if (route('POST', /^\/api\/upload$/)) {
    // Pasted/dropped files land in ah's own upload folder, readable only by you,
    // streamed to disk (a screen recording runs to hundreds of megabytes).
    const name = (url.searchParams.get('name') ?? 'upload').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'upload';
    await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    const declared = declaredLength(req);
    await admit(UPLOAD_DIR, declared, config.uploads, UPLOAD_DIR);
    const file = join(UPLOAD_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
    const out = await streamToFile(req, (n) => (n ? file.replace(/(\.[^./]*)?$/, `-${n}$1`) : file), config.uploads, { declared, quotaDir: UPLOAD_DIR });
    audit(req, 'file.upload', { path: out.path, bytes: out.bytes });
    return send(res, 201, { path: out.path, bytes: out.bytes });
  }

  // ---------- web push

  if (route('GET', /^\/api\/push\/key$/)) return send(res, 200, { key: core.push.publicKey });

  if (route('POST', /^\/api\/push\/subscribe$/)) {
    const body = await readJson(req);
    const events = body.events as { waiting?: unknown; done?: unknown } | undefined;
    try {
      core.push.subscribe(body.subscription as never, { waiting: events?.waiting !== false, done: events?.done === true }, String(body.label ?? ''));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/push\/unsubscribe$/)) {
    core.push.unsubscribe(str((await readJson(req)).endpoint, 'endpoint', 2048));
    return send(res, 200, { ok: true });
  }

  // Native app push (server/apns.ts): one registration per native sign-in.
  if (route('GET', /^\/api\/push\/apns$/)) return send(res, 200, apns.status(caller.kind === 'session' ? caller.session.id : null));
  if (route('PUT', /^\/api\/push\/apns$/)) {
    if (caller.kind !== 'session' || !auth.isNative(caller)) throw new HttpError(403, 'only the native app registers for APNs');
    const body = await readJson(req);
    const events = body.events as { waiting?: unknown; done?: unknown } | undefined;
    try {
      apns.register({
        token: str(body.token, 'token', 200),
        environment: str(body.environment, 'environment', 20) as never,
        events: { waiting: events?.waiting !== false, done: events?.done === true },
        preview: body.preview === 'private' ? 'private' : 'full',
        sessionId: caller.session.id,
        deviceId: caller.session.keyId ?? '',
        label: caller.session.label,
      });
    } catch (err) {
      if (err instanceof ApnsError) throw new HttpError(err.status, err.message);
      throw err;
    }
    audit(req, 'push.apns.register', { device: caller.session.keyId });
    return send(res, 200, apns.status(caller.session.id));
  }
  // A Live Activity the app started for a session it sent to: the host keeps it current.
  if (route('PUT', /^\/api\/push\/apns\/activity$/)) {
    if (caller.kind !== 'session' || !auth.isNative(caller)) throw new HttpError(403, 'only the native app registers Live Activities');
    const body = await readJson(req);
    try {
      apns.registerActivity({ uid: str(body.uid, 'uid', 200), token: str(body.token, 'token', 200), environment: str(body.environment, 'environment', 20) as never, sessionId: caller.session.id, rotated: body.rotated === true });
    } catch (err) {
      if (err instanceof ApnsError) throw new HttpError(err.status, err.message);
      throw err;
    }
    return send(res, 200, { ok: true, activities: apns.activityCount(caller.session.id) });
  }
  if ((m = route('DELETE', /^\/api\/push\/apns\/activity\/([^/]+)$/))) {
    if (caller.kind === 'session') apns.unregisterActivity(caller.session.id, decodeURIComponent(m[1]));
    return send(res, 200, { ok: true });
  }
  if (route('DELETE', /^\/api\/push\/apns$/)) {
    if (caller.kind === 'session') apns.unregister(caller.session.id);
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/push\/status$/)) return send(res, 200, { events: core.push.settings(str((await readJson(req)).endpoint, 'endpoint', 2048)) });

  // ---------- worktrees, prompts

  if (route('GET', /^\/api\/worktrees$/)) return send(res, 200, await core.worktrees());

  if (route('DELETE', /^\/api\/worktrees$/)) {
    const body = await readJson(req);
    const path = str(body.path, 'path', 1024);
    await core.removeWorktree(path, body.force === true);
    audit(req, 'worktree.remove', { path, forced: body.force === true });
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/worktrees\/remove-bulk$/)) {
    const body = await readJson(req);
    const paths = Array.isArray(body.paths) ? body.paths.slice(0, 200).map((p: unknown) => str(p, 'path', 1024)) : [];
    const force = Array.isArray(body.force) ? body.force.slice(0, 200).map((p: unknown) => str(p, 'path', 1024)) : [];
    if (!paths.length) throw new HttpError(400, 'no worktrees given');
    // The client selection is never trusted: Core and the git layer
    // revalidate in-use, dirty, and managed-root per item at removal time.
    const results = await core.removeWorktreesBulk(paths, force);
    const removed = results.filter((r) => r.ok).map((r) => r.path);
    audit(req, 'worktree.remove-bulk', {
      removed,
      failed: results.length - removed.length,
      forced: force,
      reclaimedBytes: results.reduce((n, r) => n + (r.ok ? r.reclaimedBytes : 0), 0),
    });
    return send(res, 200, { results });
  }

  if (route('GET', /^\/api\/prompts$/)) return send(res, 200, core.recentPrompts());
  if (route('DELETE', /^\/api\/prompts$/)) {
    core.clearPrompts();
    audit(req, 'prompts.clear');
    return send(res, 200, { ok: true });
  }

  // ---------- windows

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/changes$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    return send(res, 200, await changes(expandHome(w.cwd)));
  }

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/branches$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    return send(res, 200, await listBranches(expandHome(w.cwd)));
  }

  if ((m = route('POST', /^\/api\/windows\/(@\d+)\/branches$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const branch = str((await readJson(req)).branch, 'branch', 200).trim();
    if (!branch) throw new HttpError(400, 'branch required');
    const out = await switchBranch(expandHome(w.cwd), branch);
    audit(req, 'session.branch', { window: m[1], branch: out.branch });
    core.tick().catch(() => {});
    return send(res, 200, out);
  }

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/pull$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const pr = await pullRequest(expandHome(w.cwd));
    return send(res, 200, { number: pr?.number ?? null, url: pr?.url ?? null });
  }

  // ---------- side chat (BYOK change discussion, outside the agent's context)

  if (route('GET', /^\/api\/subscriptions$/)) return send(res, 200, await sidechat.list());

  if (route('POST', /^\/api\/subscriptions$/)) {
    const body = await readJson(req);
    const out = await sidechat.put({
      ...(body.id === undefined ? {} : { id: str(body.id, 'id', 40) }),
      name: str(body.name ?? '', 'name', 80),
      baseUrl: str(body.baseUrl ?? '', 'baseUrl', 200),
      model: str(body.model ?? '', 'model', 80),
      ...(body.apiKey === undefined ? {} : { apiKey: str(body.apiKey, 'apiKey', 500) }),
      ...(body.envName === undefined ? {} : { envName: str(body.envName, 'envName', 128) }),
    });
    audit(req, 'subscription.save', { id: out.id, name: out.name, ...(out.envName ? { env: out.envName } : {}) });
    return send(res, 200, out);
  }

  // The models an endpoint offers, so the form can offer them: a typed key, or a saved one at its own URL.
  if (route('POST', /^\/api\/subscriptions\/models$/)) {
    const body = await readJson(req);
    const models = await sidechat.models({
      baseUrl: str(body.baseUrl ?? '', 'baseUrl', 200),
      ...(body.apiKey === undefined ? {} : { apiKey: str(body.apiKey, 'apiKey', 500) }),
      ...(body.id === undefined ? {} : { id: str(body.id, 'id', 40) }),
    });
    return send(res, 200, { models });
  }

  if ((m = route('DELETE', /^\/api\/subscriptions\/([\w-]{1,40})$/))) {
    await sidechat.remove(m[1]);
    audit(req, 'subscription.remove', { id: m[1] });
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/subscriptions\/default$/)) {
    const id = str((await readJson(req)).id, 'id', 40);
    await sidechat.setDefault(id);
    audit(req, 'subscription.default', { id });
    return send(res, 200, { ok: true });
  }

  // ---------- voice dictation (docs/spec/14-voice.md): speech and cleanup through
  // subscriptions; the text only fills a composer. Neither audio nor text is logged.

  if (route('GET', /^\/api\/voice$/)) return send(res, 200, await voice.settings());

  if (route('PUT', /^\/api\/voice$/)) {
    const out = await voice.update(await readJson(req));
    audit(req, 'voice.settings', { speech: out.speech?.name ?? null, cleanup: out.cleanup?.name ?? null, style: out.style });
    return send(res, 200, out);
  }

  if (route('POST', /^\/api\/voice\/models$/)) {
    const models = await voice.models(str((await readJson(req)).subscriptionId, 'subscriptionId', 40));
    return send(res, 200, { models });
  }

  if (route('POST', /^\/api\/voice\/dictate$/)) {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_AUDIO_BYTES) throw new HttpError(413, 'recording too large', 'voice_too_large');
    const q = url.searchParams;
    const context = q.get('context');
    if (context !== null && context.length > 2000) throw new HttpError(400, 'invalid context');
    if (dictating >= MAX_DICTATING) throw new HttpError(429, 'too many dictations at once', 'voice_busy');
    dictating++;
    try {
      let audio: Buffer;
      try {
        audio = await readBody(req, MAX_AUDIO_BYTES, AUDIO_UPLOAD_MS);
      } catch (err) {
        if (err instanceof HttpError && err.status === 413) throw new HttpError(413, 'recording too large', 'voice_too_large');
        throw err;
      }
      const out = await voice.dictate(audio, { name: q.get('name'), style: q.get('style'), language: q.get('language'), context });
      audit(req, 'voice.dictate', { bytes: audio.length, speech: out.speech, cleanedBy: out.cleanedBy, ...(out.cleanupError ? { cleanupFailed: true } : {}) });
      return send(res, 200, out);
    } finally {
      dictating--;
    }
  }

  if (route('POST', /^\/api\/voice\/refine$/)) {
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 24_000).trim();
    if (!text) throw new HttpError(400, 'text required');
    const out = await voice.refine(text, body.style, body.phone === undefined ? '' : str(body.phone, 'phone', 24_000));
    audit(req, 'voice.refine', { chars: text.length, cleanedBy: out.cleanedBy });
    return send(res, 200, out);
  }

  // ---------- session environment (Settings → Environment)

  if (route('GET', /^\/api\/env$/)) {
    const [list, env] = await Promise.all([envStore.list(), envStore.forLaunch()]);
    return send(res, 200, { ...list, stale: await core.envStale(env) });
  }

  if (route('POST', /^\/api\/env$/)) {
    const body = await readJson(req);
    if (typeof body.secret !== 'boolean') throw new HttpError(400, 'invalid secret');
    const out = await envStore.put({
      name: str(body.name, 'name', 128),
      ...(body.value === undefined ? {} : { value: str(body.value, 'value', 8192) }),
      secret: body.secret,
    });
    // Names only: values (secret or not) stay out of the activity log.
    audit(req, 'env.save', { name: out.name });
    return send(res, 200, out);
  }

  if ((m = route('DELETE', /^\/api\/env\/([A-Za-z_][A-Za-z0-9_]{0,127})$/))) {
    await envStore.remove(m[1]);
    audit(req, 'env.remove', { name: m[1] });
    return send(res, 200, { ok: true });
  }

  // Handoff brief: summarize a transcript with the chat subscription. Not stored.
  if (route('POST', /^\/api\/summarize$/)) {
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 24_000).trim();
    if (!text) throw new HttpError(400, 'text required');
    try {
      const summary = await sidechat.summarize(text, body.subscriptionId === undefined ? undefined : str(body.subscriptionId, 'subscriptionId', 40));
      return send(res, 200, { summary });
    } catch (err) {
      if (err instanceof SideChatError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  // Side chats attach to the conversation (`harness:harnessId`), not the window:
  // the key follows the session across uids, and legacy uid rows migrate over.
  const chatKeyFor = async (windowId: string) => {
    const w = (await core.current()).windows.find((w) => w.id === windowId);
    if (!w) throw new HttpError(404, 'window not found');
    const key = sidechat.chatKey(w.agent, w.harnessId, w.uid);
    await sidechat.rekey(w.uid, key);
    return key;
  };

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const key = await chatKeyFor(m![1]);
    const [messages, subscriptionId] = await Promise.all([sidechat.history(key), sidechat.picked(key)]);
    return send(res, 200, { messages, subscriptionId });
  }

  // The subscription this side chat answers with, picked before (or between) turns.
  if ((m = route('PUT', /^\/api\/windows\/(@\d+)\/chat\/subscription$/))) {
    const key = await chatKeyFor(m![1]);
    await sidechat.pick(key, str((await readJson(req)).id, 'id', 40));
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const key = sidechat.chatKey(w.agent, w.harnessId, w.uid);
    await sidechat.rekey(w.uid, key);
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 8000).trim();
    if (!text) throw new HttpError(400, 'text required');
    const dir = expandHome(w.cwd);
    const [chg, pr] = await Promise.all([changeContext(dir).catch(() => null), pullRequest(dir).catch(() => null)]);
    try {
      const msg = await sidechat.chat(
        key,
        text,
        { title: w.title, session: w.session, branch: chg?.branch ?? w.branch, pr: pr?.number ?? null, diff: chg?.diff ?? '', dir },
        body.subscriptionId === undefined ? undefined : str(body.subscriptionId, 'subscriptionId', 40),
      );
      return send(res, 200, msg);
    } catch (err) {
      if (err instanceof SideChatError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('DELETE', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const key = await chatKeyFor(m![1]);
    await sidechat.clear(key);
    return send(res, 200, { ok: true });
  }

  // ---------- historic chats (every stored conversation, live session or not)

  if (route('GET', /^\/api\/chats$/)) {
    const q = url.searchParams.get('q') ?? undefined;
    return send(res, 200, await sidechat.listChats(q?.slice(0, 200)));
  }

  if ((m = route('GET', /^\/api\/chats\/([\w:.-]{1,80})$/))) {
    return send(res, 200, { messages: await sidechat.history(m[1], Number(url.searchParams.get('msgId')) || undefined) });
  }

  // ---------- full-text search over transcripts and side chats (issue #9)

  if (route('GET', /^\/api\/search\/status$/)) return send(res, 200, await search.status());

  if (route('GET', /^\/api\/search$/)) {
    // ?lineage=<ref>: across every conversation that ref's lineage holds (forks, continuations in other agents).
    const lineage = url.searchParams.get('lineage');
    if (lineage && !/^[\w:.-]{1,80}$/.test(lineage)) throw new HttpError(400, 'invalid lineage');
    return send(res, 200, await search.search({ ...searchParams(url), ...(lineage ? { refs: await portable.lineageKeys(lineage) } : {}) }));
  }

  if (route('GET', /^\/api\/search\/all$/)) {
    // Hub fan-out: our own results plus every peer's, merged. A peer that is
    // offline or errors becomes a note in the response, never a failed search.
    const params = searchParams(url);
    const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 20)));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const needed = offset + limit;
    const selected = (host: string) => !params.host || host.toLowerCase().includes(params.host.toLowerCase());
    // Every host supplies the ordered prefix needed for this global page.
    // Applying the global offset on each host would lose or repeat sessions.
    const prefix = async (get: (p: SearchParams) => Promise<Awaited<ReturnType<typeof search.search>>>) => {
      let body: Awaited<ReturnType<typeof search.search>> | undefined;
      const results: NonNullable<typeof body>['results'] = [];
      do {
        const next = await get({ ...params, host: undefined, order: 'recent', limit: Math.min(50, needed - results.length), offset: results.length });
        body = next;
        results.push(...next.results);
        if (!next.results.length || results.length >= next.total) break;
      } while (results.length < needed);
      return { ...body!, results };
    };
    const parts = await Promise.all([
      ...(selected(hostName()) ? [prefix((p) => search.search(p)).then((body) => ({ host: hostName(), body }))] : []),
      ...peers.list().filter((peer) => selected(peer.name)).map(async (peer) => {
        if (!peer.online || !peerUrlAllowed(peer.url)) return { host: peer.name, error: 'offline' };
        try {
          const body = await prefix(async (p) => {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries({ q: p.q, in: p.scope, role: p.role, p: p.project, m: p.model, limit: p.limit, offset: p.offset, from: p.from, to: p.to, sort: 'recent' })) {
              if (v !== undefined && v !== 'all') qs.set(k, String(v));
            }
            const r = await fetch(`${peer.url}/api/search?${qs}`, {
              headers: peer.token ? { authorization: `Bearer ${peer.token}` } : {},
              signal: AbortSignal.timeout(3000),
              redirect: 'manual',
            });
            if (!r.ok) throw new Error(`http ${r.status}`);
            return await r.json();
          });
          return { host: peer.name, body };
        } catch { return { host: peer.name, error: 'unreachable' }; }
      }),
    ]);
    return send(res, 200, combineResponses(parts, { offset, limit }));
  }

  if (route('POST', /^\/api\/search\/rebuild$/)) {
    void search.rebuild().catch((err) => console.error('search rebuild failed:', err));
    audit(req, 'search.rebuild');
    return send(res, 200, await search.status());
  }

  if (route('POST', /^\/api\/search\/enabled$/)) {
    const on = (await readJson(req)).enabled === true;
    await search.setEnabled(on);
    audit(req, on ? 'search.enable' : 'search.disable');
    return send(res, 200, await search.status());
  }

  if ((m = path.match(/^\/api\/windows\/(@\d+)(\/capture)?$/))) {
    const id = m[1];
    if (!(await t.windowExists(id))) throw new HttpError(404, 'window not found');
    if (m[2] && method === 'GET') {
      const lines = Math.min(10000, Math.max(1, Number(url.searchParams.get('lines')) || 2000));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await t.capturePane(id, lines));
    }
    if (!m[2] && method === 'PATCH') {
      const name = str((await readJson(req)).name, 'name', 80).trim();
      if (!name) throw new HttpError(400, 'name required');
      await t.renameWindow(id, name);
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (!m[2] && method === 'DELETE') {
      // You ended it: recovery (server/recovery) must not take this for a crash.
      const ending = (await core.current()).windows.find((w) => w.id === id);
      if (ending) core.registry.setMeta(ending.uid, 'ah.endedBy', 'you');
      if (ending) await terminals.close(ending.uid);
      await t.killWindow(id);
      audit(req, 'session.kill', { window: id });
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'not found');
}

// ---------- auth routes

/**
 * The https address Tailscale Serve publishes ah at, re-read at most once a minute:
 * Serve can be set up, or turned off, while ah runs. The only address another device
 * can use: ah listens on loopback, and the gate refuses any other name (its tailnet IP,
 * a LAN address) before sign-in, which passkeys bind to this name anyway.
 */
let served: { at: number; url: Promise<string | null> } | null = null;
function serveAddress(): Promise<string | null> {
  if (!served || Date.now() - served.at > 60_000) served = { at: Date.now(), url: serveStatus((server.address() as AddressInfo).port) };
  return served.url;
}

async function authApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, caller: Caller | null) {
  const route = (verb: string, re: RegExp) => (method === verb ? path.match(re) : null);
  const label = (b: Record<string, unknown>) => String(b.label ?? '').replace(/[^\w .·()-]/g, '').slice(0, 60);
  const isHost = caller?.kind === 'token' && caller.token.id === 'local';
  const signedIn = (cookie: { cookie: string } | null) => {
    if (cookie) res.setHeader('set-cookie', cookie.cookie);
    return send(res, 200, { ok: true });
  };
  let m: RegExpMatchArray | null;

  if (route('GET', /^\/api\/auth\/status$/)) {
    return send(res, 200, { enabled: auth.enabled, enrolled: auth.enrolled, authenticated: !!caller, password: auth.hasPassword });
  }
  if (route('POST', /^\/api\/auth\/register\/options$/)) {
    const body = await readJson(req);
    return send(res, 200, await auth.registrationOptions(req, caller, typeof body.code === 'string' ? body.code : undefined));
  }
  if (route('POST', /^\/api\/auth\/register\/verify$/)) {
    const body = await readJson(req);
    return signedIn(await auth.verifyRegistration(req, str(body.challengeId, 'challenge', 40), body.response as never, label(body)));
  }
  if (route('POST', /^\/api\/auth\/login\/options$/)) return send(res, 200, await auth.authenticationOptions(req));
  if (route('POST', /^\/api\/auth\/login\/verify$/)) {
    const body = await readJson(req);
    return signedIn(await auth.verifyAuthentication(req, str(body.challengeId, 'challenge', 40), body.response as never, label(body)));
  }
  if (route('POST', /^\/api\/auth\/password\/login$/)) {
    const body = await readJson(req);
    return signedIn(await auth.passwordLogin(req, str(body.password, 'password', 512), label(body)));
  }
  if (route('POST', /^\/api\/auth\/native\/enroll\/options$/)) {
    const body = await readJson(req);
    return send(res, 200, auth.nativeEnrollOptions(req, caller, typeof body.code === 'string' ? body.code : undefined));
  }
  if (route('POST', /^\/api\/auth\/native\/enroll\/verify$/)) {
    const body = await readJson(req);
    return send(res, 200, auth.nativeEnrollVerify(req, str(body.challengeId, 'challenge', 40), str(body.publicKey, 'publicKey', 100), str(body.signature, 'signature', 200), label(body)));
  }
  if (route('POST', /^\/api\/auth\/native\/login\/options$/)) return send(res, 200, auth.nativeLoginOptions(req));
  if (route('POST', /^\/api\/auth\/native\/login\/verify$/)) {
    const body = await readJson(req);
    return send(res, 200, auth.nativeLoginVerify(req, str(body.challengeId, 'challenge', 40), str(body.deviceId, 'deviceId', 20), str(body.signature, 'signature', 200), label(body)));
  }
  if (route('POST', /^\/api\/auth\/logout$/)) {
    if (caller?.kind === 'session') auth.endSession(caller.session.id, 'signed out');
    res.setHeader('set-cookie', clearCookies());
    return send(res, 200, { ok: true });
  }

  // Management: signed-in devices and the host's own CLI only.
  if (!caller) throw new HttpError(401, 'sign in required');

  if (route('POST', /^\/api\/auth\/cache-key$/)) {
    const key = auth.cacheKey(caller);
    if (!key) throw new HttpError(404, 'no cache for this caller');
    res.setHeader('cache-control', 'no-store');
    return send(res, 200, { key });
  }
  // `address`: where another device opens ah (Security → Add a device), or null off the tailnet.
  if (route('GET', /^\/api\/auth\/overview$/)) return send(res, 200, { ...auth.overview(caller), audit: auth.recentAudit(50), address: await serveAddress() });
  if (route('POST', /^\/api\/auth\/code$/)) {
    return send(res, 200, { code: auth.issueCode(caller.kind === 'session' ? `device ${caller.session.label}` : 'host CLI'), ttlMinutes: 10 });
  }
  if ((m = route('DELETE', /^\/api\/auth\/sessions\/(\w{1,20})$/))) {
    auth.endSession(m[1], 'revoked');
    return send(res, 200, { ok: true });
  }
  if (route('POST', /^\/api\/auth\/signout-all$/)) {
    auth.signOutEverywhere(caller.kind === 'session' ? caller.session.id : undefined);
    return send(res, 200, { ok: true });
  }
  if ((m = route('DELETE', /^\/api\/auth\/passkeys\/([\w-]{1,512})$/))) {
    auth.removePasskey(m[1]);
    return send(res, 200, { ok: true });
  }
  if (route('POST', /^\/api\/auth\/native\/preview-session$/)) return send(res, 200, auth.nativePreviewSession(caller));
  if ((m = route('DELETE', /^\/api\/auth\/devices\/(\w{1,20})$/))) {
    auth.removeDevice(m[1]);
    return send(res, 200, { ok: true });
  }
  if (route('POST', /^\/api\/auth\/tokens$/)) return send(res, 200, { token: auth.createToken(str((await readJson(req)).name, 'name', 60)) });
  if ((m = route('DELETE', /^\/api\/auth\/tokens\/(\w{1,20})$/))) {
    auth.removeToken(m[1]);
    return send(res, 200, { ok: true });
  }
  // The master password can only be set from the host itself.
  if (route('POST', /^\/api\/auth\/password$/)) {
    if (!isHost) throw new HttpError(403, 'set the master password on the host: node bin/ah.js auth password');
    const body = await readJson(req);
    await auth.setPassword(body.password === null ? null : str(body.password, 'password', 512));
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'not found');
}

// ---------- static files

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  // Ignored over plain http (localhost); pins https for the ts.net name.
  'strict-transport-security': 'max-age=31536000',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const cspFor = () => [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  // Inline style attributes only (React); no third-party origins anywhere.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  // Previews: a session's dev server, each on a port of its own (server/preview.ts).
  `frame-src http://localhost:* http://127.0.0.1:*${gate.tailnet ? ` https://${gate.tailnet.dnsName}:*` : ''}`,
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const rel = pathname === '/' ? 'index.html' : safeDecode(pathname).replace(/^\/+/, '');
  let file = resolve(DIST, rel);
  if (!file.startsWith(DIST + '/')) file = join(DIST, 'index.html');
  let body = await readFile(file).catch(() => null);
  if (!body) {
    file = join(DIST, 'index.html');
    body = await readFile(file).catch(() => null);
  }
  if (!body) {
    res.writeHead(503, { 'content-type': 'text/plain', 'content-security-policy': cspFor() });
    return res.end('UI not built. Run `pnpm build`, or use `pnpm dev`.');
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const out = await encoded(file, body, type, req.headers['accept-encoding']);
  res.writeHead(200, {
    'content-type': type,
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': cspFor(),
    ...(compressible(type) ? { vary: 'accept-encoding' } : {}),
    ...(out.encoding ? { 'content-encoding': out.encoding } : {}),
    'content-length': out.body.length,
  });
  res.end(out.body);
}

// ---------- the gate

function deny(res: ServerResponse, status: number, reason: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(reason);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const verdict = gate.check(req);
  if (!verdict.ok) return deny(res, verdict.status, verdict.reason);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://x');
  } catch {
    return deny(res, 400, 'bad request');
  }
  const method = req.method ?? 'GET';
  try {
    const caller = auth.identify(req);
    // CSRF: a custom header can't be sent cross-site without a preflight we never answer.
    if (method !== 'GET' && method !== 'HEAD' && (req.headers['x-ah'] !== '1' || !(gate.originOk(req) || nativeWithoutOrigin(req, caller, safeDecode(url.pathname))))) throw new HttpError(403, 'forbidden');

    // /h/<host>/… addresses a host: ourselves (served here) or a peer (proxied).
    let path = safeDecode(url.pathname);
    const h = path.match(/^\/h\/([\w.-]{1,64})(\/.*)$/);
    if (h && h[1] !== hostName()) {
      if (!caller) throw new HttpError(401, 'sign in required');
      const peer = peers.get(h[1]);
      if (!peer) throw new HttpError(502, `host ${h[1]} is offline`);
      return await proxyHttp(peer, h[2] + url.search, req, res);
    }
    if (h) {
      path = h[2];
      url = new URL(h[2] + url.search, 'http://x');
      if (path.startsWith('/h/')) throw new HttpError(404, 'not found');
    }

    if (path.startsWith('/api/')) {
      // Default deny (invariant 4).
      if (!caller && !PUBLIC_ROUTES.has(`${method} ${path}`)) throw new HttpError(401, 'sign in required');
      return await api(req, res, url, path, caller);
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError || err instanceof CoreError || err instanceof AuthError || err instanceof FsError || err instanceof SideChatError || err instanceof UploadError ? err.status : err instanceof GitError ? 400 : 500;
    if (status === 500) console.error(err);
    // A failure mid-stream (e.g. a download) can't be turned into a JSON error any more.
    if (res.headersSent) return res.destroy();
    const stderr = (err as { stderr?: string }).stderr;
    // `code`: ah's own stable reason, for clients to branch on. Never a system error's code.
    const code = (err instanceof HttpError || err instanceof FsError || err instanceof UploadError || err instanceof CoreError) && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined;
    // A refused body the client is still sending isn't read: close instead of draining it.
    if (status === 413 || status === 507) res.setHeader('connection', 'close');
    send(res, status, { error: status === 500 ? 'internal error' : stderr?.trim() || (err as Error).message, ...(code ? { code } : {}) });
  }
}

/**
 * One server-sent event. A client that stopped reading (a phone asleep behind
 * tailscale serve, a stalled proxy) would otherwise buffer every patch and feed
 * append in memory without limit: past 8 MB unread, drop it; it reconnects and
 * gets a fresh snapshot.
 */
function sse(res: ServerResponse, chunk: string) {
  if (res.destroyed) return;
  if (res.writableLength > 8 * 1024 * 1024) return void res.destroy();
  res.write(chunk);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

// Heartbeat: a device that went away without closing (slept, lost its network)
// leaves a half-open socket, and its terminal (a tmux client and a viewer that
// marks the window as watched) would live until the window dies. Ping every 30 s;
// a socket that misses two pings in a row is gone. Browsers and the ws client
// (peers) answer pings on their own.
const missed = new WeakMap<WebSocket, number>();
setInterval(() => {
  for (const ws of wss.clients) {
    const n = (missed.get(ws) ?? 0) + 1;
    if (n > 2) {
      ws.terminate();
      continue;
    }
    missed.set(ws, n);
    ws.ping();
  }
}, 30_000).unref();

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const reject = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const verdict = gate.check(req);
  if (!verdict.ok) return reject(`${verdict.status} Forbidden`);
  // A WebSocket has no preflight: a browser's needs ah's exact Origin. The native app's
  // carries its bearer sign-in and no Origin or cookie at all.
  const caller = auth.identify(req);
  const native = req.headers.origin === undefined && req.headers.cookie === undefined && auth.isNative(caller);
  if (!gate.originOk(req) && !native) return reject('403 Forbidden');
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://x');
  } catch {
    return reject('400 Bad Request');
  }
  const m = safeDecode(url.pathname).match(/^(?:\/h\/([\w.-]{1,64}))?\/ws\/(@\d+)$/);
  if (!m) return reject('404 Not Found');
  if (!caller) return reject('401 Unauthorized');
  const [, host, windowId] = m;
  const peer = host && host !== hostName() ? peers.get(host) : null;
  if (host && host !== hostName() && !peer) return reject('502 Bad Gateway');

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('pong', () => missed.delete(ws));
    // Protocol errors (e.g. a frame over maxPayload) must close this socket, not crash ah:
    // ws closes with 1009/1002 itself; an unhandled 'error' event would kill the process.
    ws.on('error', (err) => console.warn(`websocket closed on error: ${err.message}`));
    // Revoking this device's session closes its terminals too.
    ws.on('close', auth.track(caller, { close: () => ws.close(4401, 'signed out') }));
    if (peer) return proxyWs(peer, `/ws/${encodeURIComponent(windowId)}${url.search}`, ws);
    const cols = Number(url.searchParams.get('cols'));
    const rows = Number(url.searchParams.get('rows'));
    const device = (url.searchParams.get('device') ?? '').replace(/[^\w .-]/g, '').slice(0, 24) || 'browser';
    attach(ws, windowId, cols, rows, device, clientId(url.searchParams.get('client'))).catch((err) => {
      console.error(err);
      ws.close(1011, 'attach failed');
    });
  });
}

// ---------- start

/** Read-only: is Tailscale Serve set up to forward to us? (ah never changes it.) */
async function serveStatus(port: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('tailscale', ['serve', 'status', '--json'], { timeout: 5000 });
    return servedAt(JSON.parse(stdout || '{}'), port);
  } catch {}
  return null;
}

await Promise.all([gate.watch(), t.cleanupViewers(), t.ensureServer()]);
// SQLite is the durable state now: deploy schema, import any pre-Prisma JSON
// once (idempotent), then seed the in-memory mirrors before the first tick.
await ensureMigrated();
// An update that added tables needs the database client regenerated, which only a
// fresh process loads: exit non-zero so the service manager starts ah again.
if ((await ensureClient().catch((err) => (console.error((err as Error).message), 'current'))) === 'regenerated') {
  console.error('ah updated its database client for the new schema; restarting to load it.');
  process.exit(75);
}
await importLegacyJson(getDb()).then(
  (c) => console.log('imported legacy state:', JSON.stringify(c)),
  (err) => console.error('legacy import failed:', err),
);
// Only now, with the schema current and legacy rows imported, read the
// sessions: fail closed rather than start with an empty registry, which would
// re-register live windows under new ids and orphan their links, queues and meta.
try {
  await core.registry.load();
} catch (err) {
  console.error(`Can't read ah's session registry: ${(err as Error).message}`);
  process.exit(1);
}
await core.loadPrompts();
await notes.load().catch((err) => console.error('notes: reading the cursor failed:', err));
// Continuations a restart interrupted: watched again, or marked failed if nothing launched.
await portable.recover().then(
  (r) => (r.resumed || r.failed) && console.log(`portable: ${r.resumed} continuation(s) resumed, ${r.failed} marked failed`),
  (err) => console.error('portable recovery failed:', err),
);
void migrations.recover().then((n) => n && console.log(`migrations: ${n} resumed`)).catch((err) => console.error('migration recovery failed:', err));
void migrations.sweep().catch(() => {});
core.start();
review.start();
search.start();
peers.start();
if (process.env.AH_USAGE !== '0') usage.start();

const server: Server = createServer(handle);
// No whole-request deadline: a long upload over a phone's link must not be cut at
// five minutes. Small bodies have their own timeout (readBody), uploads an idle one.
server.requestTimeout = 0;
await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 }).catch(() => {});
void sweepParts(UPLOAD_DIR).catch(() => {});
server.on('upgrade', upgrade);
server.listen(PORT, HOST, async () => {
  const { port } = server.address() as AddressInfo;
  const where = HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`ah listening on http://${where}:${port}`);
  if (!auth.enabled) {
    console.warn('⚠ auth is off ("auth": {"mode": "off"}): anyone who can reach this port gets a shell.');
  } else if (!auth.enrolled) {
    const code = auth.issueCode('startup');
    console.log(`\n  Set up your first device: open ah and enter this one-time code (valid 10 minutes):\n\n      ${code}\n\n  Need another later? Run \`node bin/ah.js auth code\` on this machine.\n`);
  }
  const exposed = await serveStatus(port);
  console.log(exposed ? `Reachable on your tailnet at ${exposed} (tailscale serve)` : 'Not on your tailnet yet: run `node bin/ah.js setup tailscale` once.');
  console.log(`config: ${CONFIG_PATH}`);
  if (process.env.AH_PREVIEW_PUBLISH !== '0') await removeStaleMappings(config.preview.ports);
  await syncPreviews().catch((err) => console.warn('previews:', err));
  setInterval(() => void syncPreviews().catch(() => {}), 15_000).unref();
  // An agent CLI updated since last time shows its new modes and efforts; then hourly
  // (an unchanged version isn't read again). Off in tests: they don't run real CLIs.
  if (process.env.AH_HARNESS_CHECK !== '0') {
    setTimeout(() => void core.checkHarnesses().catch((err) => console.warn('agents:', err)), 3000).unref();
    setInterval(() => void core.checkHarnesses().catch(() => {}), 3600_000).unref();
  }
});

let stopping = false;
// Graceful shutdown is part of crash persistence: session records are written
// fire-and-forget during ticks, so exiting in 200ms could truncate the very
// rows a post-restart resume needs. Stop the ticker, then drain them (bounded).
async function shutdown(sig: string) {
  if (stopping) process.exit(1); // second signal: out now
  stopping = true;
  console.log(`ah shutting down (${sig})`);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close();
  core.stop();
  review.stop();
  await drafts.save();
  // Unpublish preview ports; a crash leaves them for removeStaleMappings at the next start.
  await Promise.race([previews.stopAll(), new Promise((r) => setTimeout(r, 3000))]);
  const drain = (async () => {
    core.registry.flush();
    await core.registry.settled();
    // A tick that was already in flight may have dirtied the registry after
    // the first flush; a second round catches its write too.
    core.registry.flush();
    await core.registry.settled();
  })().catch((err) => console.error('shutdown drain failed:', err));
  await Promise.race([drain, new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void shutdown(sig));
}
