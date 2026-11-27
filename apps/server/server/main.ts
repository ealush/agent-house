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
import { readFile, mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { hostName } from './host.ts';
import { basename, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, expandHome, CONFIG_PATH, type Config } from './config.ts';
import { AttachedTerminals } from './attachedTerminal.ts';
import { compressible, encoded } from './compress.ts';
import { Core, resolveDir } from './core.ts';
import { features } from './features.ts';
import { devlog, redactedPath } from './devlog.ts';
import { buildLaunch, resumeSelection } from './launch.ts';
import { withCatalog } from './catalog.ts';
import { attach, clientId, viewers } from './terminal.ts';
import { Drafts } from './drafts.ts';
import { feedPage, feedPrompts } from './feed/stream.ts';
import type { Part } from './feed/schema.ts';
import { Previews, removeStaleMappings, tailscalePublish } from './preview.ts';
import * as t from './tmux.ts';
import { createWorktree, changes } from './git.ts';
import { SideChatStore } from './sidechat.ts';
import { VoiceService } from './voice.ts';
import { ensureClient, ensureMigrated, getDb } from './db.ts';
import { importLegacyJson } from './migrate.ts';
import { list, setArtifactRoots, setMediaRoots, setRoots, roots, safePath } from './files.ts';
import { Peers, proxyHttp, proxyWs } from './peers.ts';
import { SearchIndexer } from './search.ts';
import { Auth, type Caller } from './auth.ts';
import { Gate, LOOPBACK_BIND, servedAt } from './gate.ts';
import { Apns } from './apns.ts';
import { errorReply } from './errors.ts';
import { admitRequest, admitUpgrade } from './admission.ts';
import { SessionGateway } from './sessionGateway.ts';
import { match } from './api/router.ts';
import { apiRoutes } from './api/index.ts';
import { actorToken, actorUid, HttpError, send, readBody, safeDecode } from './http.ts';
import { sweepParts } from './uploads.ts';
import { EnvStore } from './env.ts';
import { Harnesses } from './harnesses.ts';
import { ReviewService, readTextFile, type SessionLite } from './review/service.ts';
import { reviewApi } from './review/api.ts';
import { conversationKey } from './registry.ts';
import { PortableService } from './portable/service.ts';
import { PortableStore } from './portable/store.ts';
import { portableApi } from './portable/api.ts';
import { MigrationService } from './migrate/service.ts';
import { migrateApi } from './migrate/api.ts';
import { Scheduler } from './jobs/scheduler.ts';
import { jobsApi } from './jobs/api.ts';
import { NotesStore } from './notes/store.ts';
import { Handoffs, MaybeArrived } from './notes/handoff.ts';
import { notesApi } from './notes/api.ts';
import { MailboxStore } from './fleet/mailbox.ts';
import { TaskStore } from './fleet/tasks.ts';
import { fleetApi } from './fleet/api.ts';
import { SpacesService } from './spaces/service.ts';
import { nodeSpaceFs } from './spaces/files.ts';
import { CheckoutsService } from './checkouts/service.ts';
import type { Worktree } from './git.ts';
import { projectOf, repoInfo, shortPath } from './sessions.ts';
import { resolveSpawnSupervision, supervisionOf } from './supervision.ts';
import { linesAfter, readAfter } from './jobs/transcript.ts';
import { RecoveryEngine } from './recovery/engine.ts';
import { Interruptions, interruptedOf, shortWhy } from './interruptions.ts';
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

// The developer log (Settings → System → Developer): off unless turned on there.
devlog.init();
devlog.teeConsole();

let auth: Auth;
try {
  auth = new Auth(config.auth);
} catch (err) {
  // Fail closed: never start without the sign-in data we're supposed to enforce.
  console.error(`Can't read ah's auth state: ${(err as Error).message}`);
  process.exit(1);
}
const core = new Core(config, viewers);
// Checkouts (server/checkouts, docs/spec/18-checkouts.md): automatic worktree isolation,
// atomic exclusive writer ownership, port/temp allocation, overlap & merge-tree checks, GC.
const CHECKOUT_TEMP_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ah', 'checkouts');
const checkouts = new CheckoutsService(getDb(), {
  config: () => config.checkouts,
  tempRoot: CHECKOUT_TEMP_DIR,
  liveWindows: async () =>
    (await core.current()).windows.map((w) => ({
      uid: w.uid,
      id: w.id,
      name: w.name,
      title: w.title,
      agent: w.agent,
      status: w.status,
      cwd: expandHome(w.cwd),
    })),
  records: () =>
    core.registry.all().map((r) => ({
      id: r.id,
      title: r.title,
      harness: r.harness,
      harnessId: r.harnessId,
      cwd: expandHome(r.cwd),
      lifecycle: r.lifecycle,
      lastActivityAt: r.lastActivityAt,
      worktree: r.meta['ah.worktree'] as Worktree | undefined,
    })),
  changed: () => void core.tick().catch(() => {}),
});
// What every other context needs from sessions, written once (server/sessionGateway.ts).
const sessions = new SessionGateway(core, config, checkouts);
// Native app push: delivered beside Web Push; a sign-in that ends stops its alerts.
const apns = new Apns(config.apns);
auth.onSessionEnd = (id) => apns.forgetSession(id);
// A sign-in left unused past its idle limit ends on its own (and its push registration with it).
auth.prune();
apns.retain(auth.sessionIds());
setInterval(() => auth.prune(), 3600_000).unref();
// Each agent CLI's current modes and efforts, and the host's hidden and added agents.
const harnesses = new Harnesses();
const drafts = new Drafts();
const sidechat = new SideChatStore();
const voice = new VoiceService(sidechat);
const envStore = new EnvStore();
const terminals = new AttachedTerminals(core.registry, () => envStore.forLaunch());
const search = new SearchIndexer(getDb(), () => core.searchSources());
// Stack review (docs/stack-review.md): sessions it can send findings to are the live
// windows plus ended conversations that resume.
const review = new ReviewService(getDb(), sidechat, {
  sessions: async () => {
    const windows = (await core.current()).windows;
    const live = new Set(windows.map((w) => w.uid));
    const out: SessionLite[] = windows.map((w) => ({ uid: w.uid, key: sidechat.chatKey(w.agent, w.harnessId, w.uid), title: w.title, agent: w.agent, status: w.status, cwd: expandHome(w.cwd), branch: w.branch, live: true, startedAt: core.registry.get(w.uid)?.createdAt ?? w.createdAt }));
    for (const r of core.registry.all()) {
      if (live.has(r.id) || !r.harnessId || r.harness === 'shell') continue;
      out.push({ uid: r.id, key: conversationKey(r.harness, r.harnessId, r.id), title: r.title || r.harness, agent: r.harness, status: 'ended', cwd: expandHome(r.cwd), branch: null, live: false, startedAt: r.createdAt });
    }
    return out;
  },
  send: (uid, text, id) => core.send(uid, text, true, undefined, { id, remember: false }),
  alert: (p) => core.push.alert(p),
  changed: () => sessions.changed(),
  readPlan: async (path) => readTextFile(await safePath(expandHome(path))),
  launch: async ({ preset, root, label, fromRef }) => {
    const out = await sessions.startAgent({ preset, cwd: root, name: label, worktree: { fromRef } });
    const wt = out.worktree!;
    await core.tick();
    return { uid: out.uid, key: sidechat.chatKey(out.preset.id, null, out.uid), title: label, agent: out.preset.id, status: 'idle', cwd: wt.path, branch: wt.branch, live: true };
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

// Portable conversations (server/portable): continuing a conversation in another agent,
// with its lineage. Sessions start only from configured agents, through core.launch.
const portable = new PortableService(new PortableStore(getDb()), {
  host: hostName,
  presets: () => core.presets(),
  available: (id) => core.presetAvailable(id),
  resolve: (ref) => sessions.resolveConversation(ref),
  transcripts: () => discover(1000),
  record: (uid) => core.registry.get(uid),
  freshUid: () => core.registry.freshId(),
  launch: async (o) => {
    const out = await sessions.startAgent({ preset: o.preset, selection: o.sel, resume: o.resume, cwd: o.cwd, session: o.session, name: o.name, uid: o.uid, meta: o.meta, worktree: false });
    return { uid: out.uid, windowId: out.windowId };
  },
  send: (uid, text, id) => sessions.sendAs(uid, text, id),
  transcriptHas: async (uid, needle, from) => {
    const rec = core.registry.get(uid);
    const found = rec?.harnessId ? await sessions.findTranscript(rec.harness, rec.harnessId) : null;
    return found ? fileContains(found.file, needle, from) : false;
  },
  copyTranscript: async (harness, file, cwd, upto) => {
    const out = await copyTranscript(harness, file, cwd, upto);
    await usage.copied(out.file).catch(() => {});
    return out;
  },
  removeCopy: (file) => removeCopiedTranscript(file),
  worktree: (cwd, name, fromRef) => createWorktree(cwd, name, fromRef),
  checkLaunch: async (id, sel) => void (await sessions.checkLaunch(id, sel)),
  fork: async (ref, o) => {
    const out = await core.fork(ref, { name: o.name, model: o.model, effort: o.effort, mode: o.mode });
    return { uid: out.uid, harnessId: out.harnessId };
  },
  isDir: (p) => sessions.isDir(p),
  fallbackCwd: (cwd, uid) => sessions.fallbackCwd(cwd, uid),
  recreateWorktree: (repoRoot, targetPath, branch) => sessions.recreateWorktree(repoRoot, targetPath, branch),
  uploadDirs: () => [UPLOAD_DIR],
  changed: () => sessions.changed(),
});
core.afterTick.add(() => portable.reconcile());

// Scheduled and conditional work (server/jobs): runs from the core tick, launches only
// configured agents through core.launch, speaks through core.send (queue ids = run ids).
const scheduler = new Scheduler(getDb(), {
  // A job keeps its saved worktree choice; none means in place (never a branch per run).
  launch: async (o) => {
    const cwd = await resolveDir(o.cwd);
    const jobActor = o.createdBy?.startsWith('session:') ? o.createdBy.slice('session:'.length) : null;
    if (jobActor && o.mode) {
      const checked = await sessions.checkLaunch(o.preset, { model: o.model, effort: o.effort, mode: o.mode });
      if (checked.dangerous) {
        throw new HttpError(403, 'only the human user may launch a session in a dangerous/bypass permission mode', 'upward_control_denied');
      }
    }
    const inheritedSup = jobActor
      ? resolveSpawnSupervision({
          actorUid: jobActor,
          targetUid: o.uid,
          requested: null,
          graph: core.supervisionGraph(),
          targetSpace: core.spaceOfDir(cwd),
        })
      : null;
    const meta = {
      ...o.meta,
      ...(inheritedSup ? { 'ah.supervision': inheritedSup } : {}),
      ...(inheritedSup?.space ? { 'ah.space': inheritedSup.space } : {}),
    };
    await sessions.startAgent({ preset: o.preset, selection: { model: o.model, effort: o.effort, mode: o.mode }, cwd, name: o.name, uid: o.uid, meta, worktree: o.worktree ? {} : false });
    await sessions.sendAs(o.uid, o.prompt, o.id);
  },
  send: async (target, text, id, actor) => {
    const out = await sessions.sendAs(target, text, id, actor);
    return { outcome: out.outcome, uid: target };
  },
  resolveTarget: async (ref) => sessions.uidOf(ref),
  checkLaunch: (id, sel) => sessions.checkLaunch(id, sel),
  record: (uid) => core.registry.get(uid),
  freshUid: () => core.registry.freshId(),
  queueIds: (uid) => sessions.queueIds(uid),
  readTranscript: async (uid, from) => {
    const t = await sessions.transcriptOf(uid);
    return t ? readAfter(t.file, t.adapter, from) : null;
  },
  inputBox: async (uid) => {
    const w = (await core.current()).windows.find((x) => x.uid === uid);
    return w ? t.inputBox(w.id) : null;
  },
  alert: (p) => core.push.alert(p),
  changed: () => sessions.changed(),
  limits: () => config.jobs,
  capacity: (harness) => usage.knownLimit(harness),
  harnessOf: (uid) => core.registry.get(uid)?.harness ?? null,
  records: () => core.registry.all(),
  hasTranscript: (uid) => {
    const h = core.registry.get(uid)?.harness;
    return !!h && !!core.presets().find((p) => p.id === h)?.feed;
  },
  overlaps: async () => {
    const view = await checkouts.list();
    const seen = new Set<string>();
    const out: Array<{ repoRoot: string; repoName: string; key: string; sessions: string[]; files: string[] }> = [];
    for (const c of view.checkouts) {
      for (const o of c.overlaps) {
        const pair = [c.id, o.checkoutId].sort().join(':');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const sessions = [c.owner?.uid, o.ownerUid].filter((x): x is string => !!x);
        out.push({ repoRoot: c.repoRoot, repoName: c.repoName, key: pair, sessions, files: o.files });
      }
    }
    return out;
  },
  spaceOf: (uid) => core.spaceOf(uid),
  managedByOf: (uid) => supervisionOf(core.registry.get(uid)?.meta as Record<string, unknown>)?.managedBy ?? null,
  roleOf: (uid) => supervisionOf(core.registry.get(uid)?.meta as Record<string, unknown>)?.role ?? null,
});

// Cross-session asynchronous mailbox & durable task ledger (server/fleet).
let fleetRevision = 0;
const bumpFleet = () => {
  fleetRevision++;
  sessions.changed();
};
const mailbox = new MailboxStore(getDb(), bumpFleet);
const fleetTasks = new TaskStore(getDb(), bumpFleet);

// Scratchpads (server/notes): notes the devices write, offline or not, and meet here.
// Handed to an agent through core.send like a typed message (queue ids = hand-off ids).
const notes = new NotesStore(getDb(), () => sessions.changed());
// Spaces (server/spaces): where sessions belong, and plain ones in the Spaces folder.
const spacesStateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'spaces');
const spaces = new SpacesService({
  root: expandHome(config.spaces.root),
  stateFile: join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'spaces.json'),
  fs: nodeSpaceFs,
  current: async () => {
    const s = await core.current();
    return {
      // Each in the Space it's in (Core placed it: its own choice, else its project's Space).
      live: s.windows.map((w) => ({ space: w.space ?? null, projectPath: w.projectPath, at: w.activity })),
      history: s.history.map((h) => ({ space: h.space ?? null, projectPath: h.cwd ? projectOf(expandHome(h.cwd)).projectPath : null, at: h.at })),
    };
  },
  isRepo: (path) => !!repoInfo(path),
  projectOf: (path) => projectOf(path).projectPath,
  shortPath,
  expandHome,
  refresh: async () => {
    await core.tick();
  },
  refsIn: (name) => core.historyRefs(name),
  notesIn: async (spaceAbsPath, spaceNameIn, roots) => {
    const pathSet = new Set<string>();
    if (spaceAbsPath) pathSet.add(spaceAbsPath.replace(/\/+$/, ''));
    for (const r of roots ?? []) if (r) pathSet.add(r.replace(/\/+$/, ''));
    const wantName = spaceNameIn?.toLowerCase() ?? null;
    if (!pathSet.size && !wantName) return [];
    const host = hostName();
    const { notes: listed } = await notes.list(0);
    return listed
      .filter((n) => {
        if (n.deleted) return false;
        if (n.project?.host && n.project.host !== host) return false;
        if (n.project?.path) {
          const abs = expandHome(n.project.path).replace(/\/+$/, '');
          if (pathSet.has(abs)) return true;
          if (wantName && projectOf(abs).project.toLowerCase() === wantName) return true;
        }
        return false;
      })
      .map((n) => ({ id: n.id, title: n.title || '(untitled)', updatedAt: n.updatedAt }));
  },
});
const handoffs = new Handoffs(getDb(), {
  send: async (target, text, id, actor) => {
    const out = await core.send(target, text, true, undefined, { id, actorUid: actor });
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
  resolve: async (ref) => sessions.uidOf(ref),
  queueIds: (uid) => sessions.queueIds(uid),
});

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
  transcript: (uid) => sessions.transcriptOf(uid),
  settle: (uid, why) => recovery.settle(uid, why),
  alert: (p) => core.push.alert(p),
  changed: () => sessions.changed(),
});
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
  transcript: (uid) => sessions.transcriptOf(uid),
  readLines: (file, from) => linesAfter(file, from),
  fresh: async (file, seconds) => {
    const s = await stat(file).catch(() => null);
    return !!s && Date.now() - s.mtimeMs < seconds * 1000;
  },
  // An interrupted session (server/interruptions) comes back through its restore: told first
  // what happened (under the attempt's id), its queued prompts after.
  send: async (uid, text, id) => (interruptions.pending(uid) ? { outcome: (await interruptions.restore(uid, { id, by: 'recovery' })).noted ? 'queued' : 'resumed' } : sessions.sendAs(uid, text, id)),
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
  queueIds: (uid) => sessions.queueIds(uid),
  alert: (p) => core.push.alert(p),
  changed: () => sessions.changed(),
});

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
core.afterTick.add(() => interruptions.tick());
core.afterTick.add((state) => recovery.tick(state.windows));
core.afterTick.add((state) => scheduler.tick(state.windows));
core.afterTick.add(() => checkouts.tick());

// Moving stopped sessions between hosts (server/migrate): the source pushes to a peer with
// the token that peer issued it; the destination restores into its own stores.
const migrations = new MigrationService(getDb(), {
  host: hostName,
  home: () => homedir(),
  stateDir: join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah'),
  uploadsDir: UPLOAD_DIR,
  limits: () => config.uploads,
  peer: (name) => peers.get(name),
  resolve: (ref) => sessions.resolveConversation(ref),
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
  findTranscript: (harness, harnessId) => sessions.findTranscript(harness, harnessId, { fresh: true }),
  isLive: (uid) => !!core.registry.get(uid) && (core.registry.get(uid)!.lifecycle === 'live' || core.registry.get(uid)!.lifecycle === 'starting'),
  rules: () => config.migration.pathMap,
  copied: (file) => void usage.copied(file).catch(() => {}),
  roots: () => [...new Set([...config.projectRoots, ...config.files.roots].map(expandHome))],
  changed: () => sessions.changed(),
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
async function ensureChiefSubscriptions({ uid, space }: { uid: string; space: string | null }) {
  const owner = `system:chief:${uid}`;
  const existing = (await scheduler.list()).filter((j) => j.createdBy === owner && ['scheduled', 'waiting', 'paused'].includes(j.state));
  // Verify exact expected triggers (scope, excludeRoles: ['chief'], managedBy on idle) so upgrades
  // from older subscriptions cleanly replace stale triggers that could cause Chief-to-Chief loops.
  const wantSpace = space ?? null;
  const hasWaiting = existing.some(
    (j) =>
      j.trigger.kind === 'session' &&
      j.trigger.on === 'waiting' &&
      (j.trigger.space ?? null) === wantSpace &&
      Array.isArray(j.trigger.excludeRoles) &&
      j.trigger.excludeRoles.includes('chief'),
  );
  const hasIdle = existing.some(
    (j) =>
      j.trigger.kind === 'session' &&
      j.trigger.on === 'idle' &&
      (j.trigger.space ?? null) === wantSpace &&
      j.trigger.managedBy === uid &&
      Array.isArray(j.trigger.excludeRoles) &&
      j.trigger.excludeRoles.includes('chief'),
  );
  if (existing.length === 2 && hasWaiting && hasIdle) return;
  if (existing.length) await scheduler.cancelByOwner(owner);
  const scopeLabel = space ? ` (${space})` : '';
  const trigScope = space ? { space } : {};
  await scheduler.create({
    name: `Chief watch waiting${scopeLabel}`,
    action: {
      kind: 'send',
      target: uid,
      text: '[Space event] Session {{trigger.title}} ({{trigger.session}}, {{trigger.agent}}) is waiting for input:\n{{trigger.ask}}\n\nInspect with `session_read` / `ah show {{trigger.session}}`. Approve routine safe actions (`session_answer`) or escalate risky/sign-in/product decisions to the user (`session_forward`).',
    },
    trigger: { kind: 'session', uid: '*', ...trigScope, on: 'waiting', repeat: true, exclude: [uid], excludeRoles: ['chief'] },
    policy: { ifLive: true, skipIfBusy: true, until: 'delivered' },
    createdBy: owner,
  });
  await scheduler.create({
    name: `Chief watch finished${scopeLabel}`,
    action: {
      kind: 'send',
      target: uid,
      text: '[Space event] Worker {{trigger.title}} ({{trigger.session}}, {{trigger.agent}}) finished its turn.\nLatest reply: {{trigger.reply}}\n\nReview progress, update Space tasks/memory/artifacts if warranted, or assign the next step.',
    },
    trigger: { kind: 'session', uid: '*', ...trigScope, managedBy: uid, on: 'idle', repeat: true, exclude: [uid], excludeRoles: ['chief'] },
    policy: { ifLive: true, skipIfBusy: true, until: 'delivered' },
    createdBy: owner,
  });
}

const peers = new Peers(config.peers, PORT);
// Every context exists now: what sessions report about them, and hand to them.
core.connect({
  harnesses,
  peers,
  apns,
  launchEnv: () => envStore.forLaunch(),
  views: {
    review: () => review.state(),
    jobs: () => scheduler.state(),
    notes: () => notes.state(),
    spaces: () => spaces.state(),
    checkouts: () => checkouts.state(),
    fleet: () => ({ revision: fleetRevision }),
    historyFilter: (live) => spaces.historyFilter(live),
    spaceFor: (chosen, projectPath) => spaces.spaceFor(chosen, projectPath),
    hasSpace: (name) => spaces.has(name),
    interruptions: () => interruptions.state(),
    recoveryOf: (s) => recovery.viewOf(s),
  },
  checkouts: {
    acquireForLaunch: (input) => checkouts.acquireForLaunch(input),
    ensureForResume: (input) => checkouts.ensureForResume(input),
    transferOwner: (fromUid, toUid) => checkouts.transferOwner(fromUid, toUid),
  },
  copied: (file) => void usage.copied(file).catch(() => {}),
  ended: (r, last) => {
    interruptions.ended(r, last);
    recovery.sessionEnded(r, last);
    void checkouts.releaseOwner(r.id).catch(() => {});
    if (!core.isRelaunching(r.id)) void scheduler.cancelByOwner(`system:chief:${r.id}`).catch(() => {});
  },
  onRekey: async (oldUid, newUid) => {
    await Promise.all([fleetTasks.rekey(oldUid, newUid), mailbox.rekey(oldUid, newUid), scheduler.rekey(oldUid, newUid)]);
  },
  prepareSpaceContext: (name, cwd, opts) => spaces.prepareSessionContext(name, cwd, opts),
  port: () => ahPort(),
  onChiefActive: (o) => ensureChiefSubscriptions(o),
  onChiefInactive: (uid) => void scheduler.cancelByOwner(`system:chief:${uid}`).catch(() => {}),
});
setRoots([...config.files.roots.map(expandHome), expandHome(config.spaces.root), spacesStateDir]);
setMediaRoots((config.files.media ?? []).map(expandHome));
setArtifactRoots((config.files.artifacts ?? []).map(expandHome));


function audit(req: IncomingMessage, event: string, detail: Record<string, unknown> = {}) {
  const rawActor = req.headers['x-ah-session'];
  const actor = typeof rawActor === 'string' && /^[\w-]{1,40}$/.test(rawActor.trim()) ? rawActor.trim() : undefined;
  auth.audit(event, { ...detail, ...(actor ? { actorUid: actor } : {}), from: String(req.headers['tailscale-user-login'] ?? 'local') });
}






// ---------- API (reached only after the gate in handle())

// Each bounded context's routes (server/api/*.ts), handed only the services they use.
const { auth: authTable, routes } = apiRoutes({
  auth, address: () => serveAddress(), audit, checkouts, config, core, harnesses, terminals, drafts, previews, isPreviewPort,
  interruptions, recovery, usage, sidechat, voice, portable, search, peers, apns, envStore, spaces,
  graph: () => core.supervisionGraph(),
  sessionsInSpace: async (spaceName) => {
    const s = await core.current();
    return s.windows
      .filter((w) => w.space === spaceName)
      .map((w) => ({ uid: w.uid, title: w.title, agent: w.agent, status: w.status }));
  },
  subscribeChief: (o) => ensureChiefSubscriptions(o),
  uploadDir: UPLOAD_DIR, root: ROOT, dist: DIST,
});

async function api(req: IncomingMessage, res: ServerResponse, url: URL, path: string, caller: Caller | null) {
  let method = req.method ?? 'GET';
  if (method === 'GET' && path === '/api/hello') return send(res, 200, { ah: true, hostname: hostName(), auth: auth.enabled, features: features() });
  // Signing in answers signed out; managing sign-ins needs a caller.
  if (path.startsWith('/api/auth/')) {
    const hit = match(authTable, method, path);
    if (hit && (hit.route.public || caller)) return await hit.route.run({ req, res, url, m: hit.m, caller });
    if (!caller) throw new HttpError(401, 'sign in required');
    throw new HttpError(404, 'not found');
  }
  if (!caller) throw new HttpError(401, 'sign in required'); // belt and braces; handle() already denied
  // Verify per-session launch secret whenever a request claims a launched session identity.
  core.verifyActorToken(actorUid(req), actorToken(req));

  // A session by its uid, which outlives tmux windows (resume, relaunch, a tmux restart): the
  // window routes, resolved to the window the session has now. Naming the session means a
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
  if (path === '/api/jobs' || path.startsWith('/api/jobs/')) return jobsApi(req, res, path, caller, scheduler, audit, () => core.supervisionGraph(), (uid) => core.spaceOf(uid));
  if (path === '/api/fleet' || path.startsWith('/api/fleet/')) return fleetApi(req, res, url, path, {
    mailbox,
    tasks: fleetTasks,
    graph: () => core.supervisionGraph(),
    spaceOf: (uid) => core.spaceOf(uid),
    wake: async (uid, text, actor) => {
      // Never type a mail wake-up note directly into a session currently waiting on a prompt/gate.
      const live = (await core.current()).windows.find((w) => w.uid === uid);
      if (live?.status === 'waiting') return;
      await core.send(uid, text, true, undefined, { actorUid: actor });
    },
    audit,
  });
  if (path === '/api/notes' || path.startsWith('/api/notes/')) return notesApi(req, res, url, path, caller, {
      store: notes,
      handoffs,
      host: hostName,
      audit,
      session: async (ref) => {
        const uid = sessions.uidOf(ref);
        const rec = uid ? core.registry.get(uid) : undefined;
        if (!uid || !rec) return null;
        return { uid, title: (await core.current()).windows.find((w) => w.uid === uid)?.title ?? rec.title };
      },
    });

  const hit = match(routes, method, path);
  if (hit) return await hit.route.run({ req, res, url, m: hit.m, caller });
  throw new HttpError(404, 'not found');
}


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

/**
 * RFC 9112 §9.6 lingering half-close for early refusals (413/507): when unread
 * upload bytes sit in the kernel receive buffer, Node's immediate socket.destroy()
 * on Connection: close triggers a TCP RST that can discard the unread error
 * response on the client. Half-close the write side (FIN) and discard incoming
 * bytes until the peer closes or a short timeout elapses.
 */
function lingerClose(req: IncomingMessage) {
  const sock = req.socket;
  if (!sock || sock.destroyed || req.complete) return;
  sock.destroySoon = () => {
    if (sock.destroyed) return;
    req.resume();
    sock.resume();
    sock.end();
    const timer = setTimeout(() => sock.destroy(), 500);
    timer.unref();
    sock.once('end', () => {
      clearTimeout(timer);
      sock.destroy();
    });
    sock.once('close', () => clearTimeout(timer));
  };
}

/** One request in the developer log, once answered: the API's, and anything refused. */
function logRequest(req: IncomingMessage, res: ServerResponse, t0: number, failure: string | undefined) {
  let u: URL;
  try {
    u = new URL(req.url ?? '/', 'http://x');
  } catch {
    return;
  }
  if (!/^\/(api|h)\//.test(u.pathname) && res.statusCode < 400) return;
  const bytesIn = Number(req.headers['content-length']) || 0;
  devlog.event('request', {
    method: req.method,
    path: redactedPath(u.pathname, u.searchParams),
    status: res.statusCode,
    ms: Math.round(performance.now() - t0),
    ...(bytesIn ? { bytesIn } : {}),
    ...(res.writableFinished ? {} : { aborted: true }),
    ...(failure ? { error: failure } : {}),
    ua: String(req.headers['user-agent'] ?? '').slice(0, 100),
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const t0 = performance.now();
  let failure: string | undefined;
  if (devlog.enabled) res.once('close', () => logRequest(req, res, t0, failure));
  const verdict = gate.check(req);
  if (!verdict.ok) {
    failure = verdict.reason;
    return deny(res, verdict.status, verdict.reason);
  }
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
    const decoded = safeDecode(url.pathname);
    const admission = admitRequest({
      method,
      path: decoded,
      origin: req.headers.origin !== undefined,
      cookie: req.headers.cookie !== undefined,
      sameOrigin: gate.originOk(req),
      csrfHeader: req.headers['x-ah'] === '1',
      signedIn: !!caller,
      native: auth.isNative(caller),
      self: hostName(),
    });
    if (admission.kind === 'deny') throw new HttpError(admission.status, admission.reason);
    if (admission.kind === 'peer') {
      const peer = peers.get(admission.host);
      if (!peer) throw new HttpError(502, `host ${admission.host} is offline`);
      return await proxyHttp(peer, admission.path + url.search, req, res);
    }
    // /h/<this host>/… is served here, as if the prefix weren't there.
    const target = admission.path === decoded ? url : new URL(admission.path + url.search, 'http://x');
    if (admission.kind === 'api') return await api(req, res, target, admission.path, caller);
    await serveStatic(req, res, target.pathname);
  } catch (err) {
    const reply = errorReply(err);
    failure = reply.body.code ? `${reply.body.code}: ${reply.body.error}` : reply.body.error;
    if (reply.internal) {
      failure = (err as Error)?.message ?? String(err);
      console.error(err);
    }
    // A failure mid-stream (e.g. a download) can't be turned into a JSON error any more.
    if (res.headersSent) return res.destroy();
    if (reply.close) {
      res.setHeader('connection', 'close');
      lingerClose(req);
    }
    send(res, reply.status, reply.body);
  }
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
  const caller = auth.identify(req);
  let url: URL | null = null;
  try {
    url = new URL(req.url ?? '/', 'http://x');
  } catch {}
  const admission = admitUpgrade({
    path: url && safeDecode(url.pathname),
    origin: req.headers.origin !== undefined,
    cookie: req.headers.cookie !== undefined,
    sameOrigin: gate.originOk(req),
    signedIn: !!caller,
    native: auth.isNative(caller),
    self: hostName(),
  });
  if (admission.kind === 'reject' || !url || !caller) return reject(admission.kind === 'reject' ? admission.status : '400 Bad Request');
  const { host, windowId } = admission;
  const peer = host ? peers.get(host) : null;
  if (host && !peer) return reject('502 Bad Gateway');
  // Enforce supervision on terminal WebSocket upgrades when a session identity is present.
  const wsActor = actorUid(req);
  if (wsActor && !peer) {
    try {
      core.verifyActorToken(wsActor, actorToken(req));
      const rec = core.registry.all().find((r) => r.tmux?.windowId === windowId);
      if (rec) core.assertControl(wsActor, rec.id, 'terminal');
    } catch {
      return reject('403 Forbidden');
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('pong', () => missed.delete(ws));
    // Protocol errors (e.g. a frame over maxPayload) must close this socket, not crash ah:
    // ws closes with 1009/1002 itself; an unhandled 'error' event would kill the process.
    ws.on('error', (err) => console.warn(`websocket closed on error: ${err.message}`));
    if (devlog.enabled) {
      const opened = performance.now();
      devlog.event('terminal', { phase: 'open', window: windowId, ...(host ? { host } : {}) });
      ws.on('close', (code, reason) => devlog.event('terminal', { phase: 'close', window: windowId, code, reason: reason.toString().slice(0, 200), sec: Math.round((performance.now() - opened) / 1000) }));
    }
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
  devlog.stopping('database client regenerated (exit 75)');
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
await spaces.load().catch((err) => console.error('spaces: reading spaces.json failed:', err));
// Continuations a restart interrupted: watched again, or marked failed if nothing launched.
await portable.recover().then(
  (r) => (r.resumed || r.failed) && console.log(`portable: ${r.resumed} continuation(s) resumed, ${r.failed} marked failed`),
  (err) => console.error('portable recovery failed:', err),
);
void migrations.recover().then((n) => n && console.log(`migrations: ${n} resumed`)).catch((err) => console.error('migration recovery failed:', err));
void migrations.sweep().catch(() => {});
core.start();
checkouts.start();
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
  void promisify(execFile)('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, timeout: 3000 })
    .then((r) => r.stdout.trim(), () => null)
    .then((commit) => devlog.started({ port, host: HOST, commit, systemd: !!process.env.INVOCATION_ID }));
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
  devlog.stopping(sig);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close();
  core.stop();
  checkouts.stop();
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
