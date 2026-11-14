# 13 · Conductor (`CND`)

ah as an always-on conductor: conversations that move between agents and hosts,
work that runs on a schedule or when other work finishes, agents that recover from
temporary failures, and a view of what it all uses. Lifted from the feature freeze
by the owner on 14 November 2026.

This file is both the product spec and the **protocol reference** for clients (the
web app, the CLI, the native app). Every shape below is what the server sends;
TypeScript sources of truth are named beside each section.

## Contract rules (all of `CND`)

- **`api` stays 28.** Shipped native apps accept exactly that value. New capabilities
  are announced in `features` instead: a map of feature name → contract version, in
  `GET /api/hello` (before sign-in; versions only), in the state stream (`features`
  top-level key), and in `GET /api/capabilities` (with limits). A host that doesn't
  list a feature doesn't have it; a client says so instead of guessing.
  (`server/features.ts`)
- **Additive only.** New fields are optional; no existing field changes meaning; no
  new value appears in an existing enum (`status`, `statusSource`, history `kind`, ask
  `kind`): new state lives in new fields.
- **Errors** are `{ "error": string, "code"?: string }`. `code` is stable and meant
  for branching; `error` is for people. Clients that only read `error` keep working.
- **Same gate as everything else.** Every route below is behind sign-in (or the host
  token), X-AH and exact Origin on writes, the native bearer rules, revocation. None
  is public. Sessions are only ever started from configured agents, through the same
  launch path as New session, and every action is in the audit log.
- **Idempotency.** Operations that start something take an `idempotencyKey`
  (8–120 of `[\w:.-]`). The same key returns the same operation (`existed: true`,
  HTTP 200) and starts nothing new, also when two requests race.

| Feature | Version | Routes |
|---|---|---|
| `capabilities` | 1 | `GET /api/capabilities` |
| `uploads` | 2 | `POST /api/upload`, `POST /api/fs/upload` (streamed, limits, `code`) |
| `concurrentCreate` | 1 | `POST /api/windows` safe under concurrent requests |
| `portable` | 1 | `/api/portable/*` |
| `migration` | 1 | `/api/migrations/*` |
| `jobs` | 1 | `/api/jobs/*`, state `jobs` |
| `recovery` | 1 | windows' and history's `recovery`, `/api/recovery`, `/api/sessions/:uid/recovery` |
| `usage` | 1 | `/api/usage`, `/api/usage/limits`, `/api/usage/export`, `/api/sessions/:uid/usage` |
| `activityPush` | 1 | `PUT /api/push/apns/activity`, `DELETE /api/push/apns/activity/:uid` |
| `interruptions` | 1 | history's `interrupted`, state `interruptions`, `/api/interruptions/*`, `POST /api/sessions/:uid/restore` |

## CND-1 Uploads (`uploads` v2)

`POST /api/upload?name=<name>` and `POST /api/fs/upload?dir=<dir>&name=<name>` take a
raw body (`application/octet-stream`) and answer `201 { path, bytes }`. The body is
streamed to a hidden part file and renamed when whole. Limits come from config
(`uploads`) and `GET /api/capabilities` → `uploads { maxBytes, maxTotalBytes, idleMs }`.

| Status | `code` | Meaning |
|---|---|---|
| 413 | `upload_too_large` | over `maxBytes` (declared length: refused before reading) |
| 507 | `upload_quota` | ah's upload folder would pass `maxTotalBytes` |
| 507 | `disk_full` | it would leave less than `minFreeBytes` free |
| 400 | `upload_incomplete` | the client hung up before the last byte |
| 408 | `upload_stalled` | nothing arrived for `idleMs` |

Nothing is left on disk after any refusal. Progress is the client's (bytes sent);
the server answers once the last byte is on disk.

## CND-2 Portable conversations (`portable` v1)

Sources: `server/portable/{schema,extract,handoff,store,service,api}.ts`.

### What it is

A **portable document** is ah's versioned record of a conversation
(`format: "ah.portable-conversation"`, `version: 1`), read from the harness's own
transcript, which stays the authoritative source and is never written. It holds what
the transcript shows: messages in order with the source line each came from, turns
(a turn starts at each message the person typed), tool calls and results (results
kept head and tail, ~2 KB), models, the harness's own compaction summaries, images
(copied owner-only beside the document, referenced by id), files the person attached
from ah's uploads, files the tools changed, the project (cwd, branch, head, remote
without credentials), and `limitations`: what it couldn't carry, by code.

It never carries what the transcript doesn't: a model's internal state, or its
reasoning (counted as `reasoning_omitted`, not copied). Every document says
`no_internal_state`.

Identity: `pc-` + the first 16 hex of sha256(`harness:harnessId`): the same
conversation has the same id on every host.

Documents are bounded (8 MB of messages; the oldest go first, the opening request
stays, `older_messages_dropped` says so) and read in one streaming pass whatever the
transcript's size. A line that doesn't parse is counted (`unparsed_lines`); a
half-written last line is left out (`partial_last_line`).

Readers: Claude Code, Codex (exact); Gemini, Grok, opencode, Hermes (messages only:
no model or summary metadata yet); Muse (`format_unverified`). Agents without a
transcript reader (Cursor, Copilot, Crush, pi) can **receive** a continuation but
can't be the source of one (`unsupported_source`).

### Continuation strategies

They have different guarantees, and the API and UI always say which one applies.

| Strategy | When | What transfers |
|---|---|---|
| `native-resume` | same agent, `intent: continue` | the same conversation, resumed by its own agent (use `POST /api/sessions/:ref/resume`; continue answers 409 `use_resume`) |
| `native-fork` | same agent, `intent: fork` | a copy under a new id in its own worktree; the agent re-reads all of it (the existing Fork) |
| `ancestor-fork` | back to an agent this lineage started in | that agent's conversation copied natively **as it was at the branch point** (byte length and sha256 checked; a rewritten transcript falls back to `context-handoff` with `source_changed`), then a record of only what happened since in the other agents |
| `context-handoff` | otherwise | a new session primed with a bounded record (48 000 characters by default; the opening request always kept), reconstructed from the transcript(s) of the whole lineage path, with pointers to the full documents |

A hand-off starts with `[ah continuation <linkId> · from <A> to <B>]`, says plainly
that it is a reconstruction and not the other agent's memory, fences the record in
`<ah-record>` as data (a transcript can't close the fence: any `<ah-record` inside it
is defused), lists the files changed and the documents' paths, and names what's
missing. ah reads that first line back to tell its own hand-offs from the person's
messages, so a later hand-off never repeats an earlier one.

The source is only read. `intent: continue` defaults to the same folder (with a
`same_checkout` limitation while the source runs); `intent: fork` defaults to a new
worktree. A source mid-turn by its own hooks' word is refused (409 `source_busy`)
unless a worktree is asked for.

### Lineage and operations (state machine)

Each continuation is a **link** (`ConversationLink`): an edge from the parent
conversation to the child, and the record of the operation that made it.

```
preparing ──▶ launching ──▶ delivering ──▶ linked
    │              │              │
    └──────────────┴──────────────┴──▶ failed ──(retry)──▶ preparing
                                  └──▶ cancelled
```

- `preparing`: the link is written, with the destination's uid **chosen before
  anything launches** and the checkpoint (`line`, `bytes`, `sha256` of the parent as
  read).
- `launching`: worktree/copy made, the session is starting.
- `delivering`: the session exists; the hand-off is typed or queued (its queue item
  carries the link id, so it can't be queued twice).
- `linked`: the hand-off is in the child's own transcript (found by link id) and the
  child has its conversation id.
- `failed`: with `error`. `POST …/retry` re-runs it under the same link id.

**After a restart**, links in `preparing`/`launching`/`delivering` are looked at
again: one whose destination session never came to exist is `failed` ("nothing was
launched", retry to continue); one whose session exists is watched until `linked`.
A link never launches a second session on its own.

Sessions carry where they came from as `continued` on windows and history items:

```ts
continued: {
  linkId: string; fromUid: string | null; fromHarness: string; fromTitle: string;
  fromHost?: string; kind: 'resume' | 'fork' | 'portable' | 'import' | 'migration';
  strategy: string; at: number;
} | null
```

### Routes

| Route | Body | Answer |
|---|---|---|
| `GET /api/portable/capabilities` | | `{ version, format, launchOptions: true, strategies, harnesses: [{ id, name, available, read, nativeResume, nativeFork, receive, notes }] }` |
| `GET /api/portable/conversations/:ref` | | `{ conversation: PortableConversation, path }` (`?download=1`: the document as a file) |
| `GET /api/portable/conversations/:ref/lineage` | | `{ root, nodes: [{ conversationId, harness, harnessName, harnessId, title, host, uids, current }], edges: [Link] }` |
| `POST /api/portable/conversations/:ref/preview` | `{ to, intent?, worktree?, name?, budget?, model?, effort?, mode? }` | `Plan` (below); starts nothing |
| `POST /api/portable/conversations/:ref/continue` | `{ to, intent?, worktree?, name?, budget?, model?, effort?, mode?, idempotencyKey? }` | 201 `{ operation: Link, existed: false }`, or 200 `{ …, existed: true }` |
| `GET /api/portable/operations` | | `{ operations: [...] }` (newest 50) |
| `GET /api/portable/operations/:linkId` | | `Link` |
| `POST /api/portable/operations/:linkId/retry` | | `Link` (only from `failed`) |
| `POST /api/portable/operations/:linkId/cancel` | | `Link` |
| `GET /api/search?q=…&lineage=<ref>` | | search limited to every conversation in that lineage |

`:ref` is a session uid or `harness:harnessId` (a conversation found on disk).
`model`, `effort` and `mode` are ids from the destination agent's catalog, checked as New
session checks them (400 `invalid_launch` otherwise), echoed in `plan.destination`, and
kept for a retry; without them the agent's defaults apply.

```ts
Plan = {
  strategy: 'native-resume' | 'native-fork' | 'ancestor-fork' | 'context-handoff';
  kind: 'resume' | 'fork' | 'portable';
  source: { ref, uid, harness, conversationId, title, cwd, live, busy };
  destination: { harness, name, cwd, worktree, model?, effort?, mode? };
  transfers: string[];          // plain sentences: what carries over
  limitations: Limitation[];    // { code, message, count? }: what doesn't
  blocked: { code, message } | null;
  ancestor: { conversationId, harness, title, checkpointLine } | null;
  handoff: { chars, messagesIncluded, messagesOmitted, preview } | null;
  stats: { messages, turns, toolCalls, reasoningOmitted, unparsedLines, droppedBefore } | null;
}
Link = {
  id: 'lk-xxxxxxxx'; kind; strategy; state; parentId; childId; parentUid; childUid;
  fromHarness; toHarness; fromName; toName; fromHost; toHost;
  checkpoint: { line, bytes, sha256 } | null; limitations; detail; error; createdAt; updatedAt;
}
```

Failure codes: `not_found` (404), `not_a_conversation`, `unsupported_source`,
`no_transcript` (422), `unknown_destination`, `destination_unavailable`, `source_busy`,
`use_resume`, `cwd_missing`, `not_failed`, `destination_exists` (409), `invalid_launch`,
`invalid_*` (400).

### Surfaces

- **Web:** session menu and palette → *Continue in <agent>* opens a dialog with the
  host's preview (what carries over, what doesn't, own worktree), then opens the new
  session. Its header shows `↪ <agent>`, which opens the session it came from; History
  rows say `↪ from <agent>`. A host without `features.portable` gets the earlier
  in-page hand-off.
- **CLI:** `ah continue <target> --in <agent> [--fork] [--worktree] [--preview] [--json]`,
  `ah portable <target> [--out FILE]`, `ah lineage <target> [--json]`.
- **Native:** the routes above; gate on `features.portable`.

## CND-3 Moving a session to another host (`migration` v1)

Sources: `server/migrate/{manifest,paths,service,api}.ts`.

A **stopped** agent session moves to another host you trust and resumes there with
its own conversation: the same conversation id, the harness's own transcript
re-homed to the destination's folder. A running session stays where it is
(409 `source_running`); live hand-off of a running process is not offered.

**Trust.** The source pushes, with the token the destination issued it
(`ah auth token <source>` on the destination, `ah peers trust <dest> <token>` on the
source): the same trust as the multi-host proxy. The destination's
`/api/migrations/incoming/*` routes take only such a machine token (a device's
sign-in gets 403 `machine_only`), and validate everything sent.

**What moves.** The transcript; its portable document; files the person attached from
ah's uploads (their paths in the conversation are rewritten to the destination's
uploads); the conversation's lineage edges and the documents they read. Each file is
listed in the manifest by role with its size and sha256, and the destination checks
each hash as it lands (400 `hash_mismatch`, nothing kept). **What never moves:**
environment variable values (names only, to say which are missing), credential stores,
SSH keys, provider tokens, anything outside the conversation. Workspace files move
through git, not through ah: uncommitted changes stay on the source and are named.

**Where it lands.** Only inside the destination's project and file roots. In order: a
folder you name; `migration.pathMap` prefix rules in the destination's config
(`{ "from": "/home/me/", "to": "/Users/me/" }`); the same path; the same place under
home; a checkout of the same repository (by origin URL, credentials stripped) up to two
levels under its roots. The preview says which (`resolvedBy`).

**Requirements**, from the destination before anything moves (`blocking` ones refuse;
the rest need `acceptWarnings: true`):

| code | blocking | meaning |
|---|---|---|
| `missing_harness` | yes | no such agent there, or its CLI isn't installed |
| `unsupported_harness` | yes | conversations of that agent can't be moved (only Claude Code, Codex, Muse) |
| `missing_project` | yes | no folder for it inside the roots |
| `conflict` | yes | the destination already has a conversation under that id; nothing is overwritten |
| `commit_missing` | no | the source's HEAD isn't in the destination's repository (push and pull first) |
| `branch_differs` | no | the destination's checkout is on another branch |
| `not_a_repository` | no | the folder isn't a git checkout |
| `uncommitted_changes` | no | they stay on the source |
| `env_missing` | no | session variables set on the source but not here (values never travel) |

**State machine.** Durable on both ends (table `Migration`, `role` outgoing/incoming).

```
outgoing:  planned → transferring → committing → verifying → completed
incoming:  receiving → committed → verified
either:    failed  (retry resumes: a file already staged with the right hash isn't resent)
           cancelled (the destination's restore rolled back)
```

- **transferring:** each file is streamed (`PUT …/incoming/:id/files/:name`, header
  `x-ah-sha256`) to a staging folder; progress per file is recorded.
- **committing:** the destination writes the transcript into its own store (never over
  an existing file), its portable record and lineage, and an *ended* session record
  (`continued: { kind: 'migration', fromHost, … }`), so it is in History and resumable.
- **verifying:** the destination's own discovery must find the transcript where the
  restore put it. Only then does the source mark its record `movedTo` (History:
  "→ moved to <host>") and record a `migration` lineage edge. **The source's
  conversation is never deleted**: it stays resumable there.
- A restart of the source resumes every unfinished outgoing move; each step is
  idempotent (a commit that already happened returns the same uid).
- **cancel** rolls the destination back: the restored transcript, copied uploads and
  the record go. Refused (409 `in_use` / `diverged`) once it was resumed there.

**Known limit.** Moving a conversation back to a host that still has the original
copy is a `conflict` (nothing is overwritten): remove that copy first.

### Routes

| Route | Body | Answer |
|---|---|---|
| `POST /api/migrations/preview` | `{ ref, to, cwd? }` | `{ manifest, preflight }`; nothing moves |
| `POST /api/migrations` | `{ ref, to, cwd?, acceptWarnings?, idempotencyKey? }` | 201 `{ migration, existed: false }` / 200 existed; 409 with the first blocking `code`, or `needs_confirmation` |
| `GET /api/migrations` | | `{ migrations: [Migration] }` (both directions, newest 50) |
| `GET /api/migrations/:id` | | `Migration` |
| `POST /api/migrations/:id/retry` · `/cancel` | | `Migration` |
| `POST /api/migrations/incoming/preflight` | `{ manifest, cwd? }` | `Preflight` (machine token only) |
| `POST /api/migrations/incoming` · `PUT …/:id/files/:name` · `POST …/:id/commit` · `POST …/:id/verify` · `DELETE …/:id` | | the destination's steps (machine token only) |

```ts
Preflight = { ok, destCwd, resolvedBy: 'explicit'|'path_map'|'same_path'|'home_relative'|'git_remote'|null,
              requirements: [{ code, message, blocking }], existing: 'none'|'identical'|'conflict', host }
Migration = { id: 'mg-xxxxxxxx', role, state, peer, sourceUid, destUid, harness, title, sourceCwd, destCwd,
              preflight, progress: { [file]: { bytes, sent } }, error, createdAt, updatedAt }
```

History items gain `moved: { host, uid, at } | null` on the source.

### Surfaces

- **Web:** History → *Move* (with more than one host online, for Claude Code, Codex and
  Muse conversations): the destination's verdict, a confirmation for warnings, progress,
  then *Resume on <host>*. A moved session's header shows `↪ <source host>`.
- **CLI:** `ah move <target> --to HOST [--cwd DIR] [--preview] [--yes]`,
  `ah migrations [--json]`, `ah migrations retry|cancel <id>`.

## CND-4 Scheduled and conditional work (`jobs` v1)

Sources: `server/jobs/{cron,scheduler,transcript,api}.ts`. ah runs it from its own tick:
no page or app needs to stay open.

A **job** is what to do and when; it has its own identity (`jb-…`), separate from any
session's. A **run** (`jr-…`) is one time it ran; a run may start a session or speak to
one, and records which (`sessionUid`).

**Actions**
- `launch { preset, cwd, prompt, name?, model?, effort?, mode?, worktree? }`: a new agent
  session (configured agents only, choices checked like New session) given `prompt`.
- `send { target, text }`: a message to a session (typed, queued, or resumed then queued,
  as Send does).
- `decide { title, body?, then? }`: waits for your answer; *Go ahead* runs `then` (a
  launch or send) as part of the same run, *Stop here* ends it.
- Texts may name `{{trigger.reply}}`, `{{trigger.session}}` (the run that triggered this
  one) and `{{job:<id>.reply}}`, `{{job:<id>.session}}` (that job's last successful run).
  They are filled in as data, never read as instructions to the scheduler.

**Triggers**
- `at { at }` (epoch seconds), once.
- `cron { expr, tz }`: five-field cron (and `@daily` …) in an IANA time zone. A wall time
  a DST change skips is skipped that day; one it repeats runs once (hourly schedules
  run in both real hours). A schedule missed while ah was down runs **once** for the
  latest slot it missed, not once per slot.
- `after { job, on: success | failure | any }`: once per run of that job; when the
  outcome doesn't match, a `skipped` run records why.
- `session { uid, on: idle | ended }`: once, when that session is seen at work and then
  finishes its turn (screen output alone isn't work), or ends.
- `manual`: only when you run it.

**Policy** `{ maxRuns?, retries? (≤ 10), backoffSeconds? (60), timeoutSeconds? (6 h),
until?: 'finished' | 'delivered', concurrencyKey?, notify?, allowDangerous?, autoRecover? }`.
A permission mode the agent marks dangerous needs `allowDangerous` (400 `dangerous_mode`).

### State machines

```
job:  scheduled ⇄ paused        (pause/resume; a schedule resumes at its next slot)
      scheduled → waiting       (a decision run is waiting on you) → scheduled
      scheduled → done          (one-time ran; maxRuns reached)
      scheduled → failed        (a one-time run failed past its retries)
      any       → cancelled     (pending runs cancelled; nothing in flight is undone)

run:  eligible → running → succeeded | failed | uncertain | cancelled
      eligible → cancelled       (job cancelled)
      skipped                    (an `after` trigger whose outcome didn't match)
      running  → waiting         (decide) → running (Go ahead with a follow-up) | succeeded | cancelled
      failed   → (a new run, attempt + 1, after backoff with ±20% jitter) while retries remain
```

**Delivery** is recorded per run in `delivery`: `dispatchingAt` (about to act, with the
transcript's length as `mark`) → `acceptedAt` (Send answered) → `queuedAt` / `typedAt` →
`observedAt` (the message is in the session's own transcript) → `finishedAt` (its turn
ended with a reply). A run succeeds when the message was observed and the session
settled with a reply (`until: finished`, default), or when observed (`until: delivered`).
A session that ends first fails the run (retryable); so does the timeout.

### Never twice on a guess

- **One run per cause.** Every run has a unique idempotency key: the schedule slot
  (`slot:<job>:<at>`), the upstream run (`after:<run>:<job>`), the session event, the
  retry of one run. A duplicate trigger, a second scheduler on the same database, or a
  restart between two steps creates nothing.
- **One executor.** A run is claimed by a conditional update (eligible → running).
- **Evidence after a crash.** Runs the previous process held are decided by what's there:
  a launch whose session never came to exist is launched again (same uid); a message in
  the session's queue (its queue id is the run id) or in its transcript is on its way and
  watched; a launched session whose prompt is nowhere gets it queued again under the
  same id (a second copy can't be queued). A message that may have been typed without
  its arrival being recorded becomes **`uncertain`**: never re-sent on its own; *Send
  again* or *Leave it* is yours. Dependents a crash cut off are created at start.
- **Bounded.** `jobs.maxConcurrent` (3) runs at once; `jobs.maxLaunchesPerHour` (20)
  sessions started by jobs; `jobs.maxRetriesPerMinute` (10). Past a limit a run waits
  its turn (still `eligible`); nothing is dropped. Decisions don't count.

### Routes

| Route | Body | Answer |
|---|---|---|
| `GET /api/jobs` | | `{ jobs: [Job], state: JobsState }` |
| `POST /api/jobs` | `{ name, action, trigger, policy? }` | 201 `Job`; 400 `invalid_action` / `invalid_launch` / `invalid_trigger` / `invalid_policy` / `unknown_target` / `dangerous_mode` |
| `GET /api/jobs/:id` | | `Job & { runs: [Run] }` (newest 100) |
| `PATCH /api/jobs/:id` | `{ name?, action?, trigger?, policy? }` | `Job` (a new trigger re-arms it) |
| `POST /api/jobs/:id/pause` · `resume` · `cancel` · `run` | | `Job` (`run`: the new `Run`) |
| `GET /api/jobs/runs/:run` | | `Run` |
| `POST /api/jobs/runs/:run/decide` | `{ approve: boolean, note? }` | `Run` |
| `POST /api/jobs/runs/:run/resolve` | `{ resend: boolean }` | `Run` (only an `uncertain` one) |

```ts
Job = { id, name, state, action, trigger, policy, nextRunAt, runCount, createdAt, updatedAt, lastRun: Run | null }
Run = { id, jobId, seq, state, triggeredBy, scheduledFor, attempt, sessionUid, delivery, outcome: { reply?, body?, decision?, note?, skippedBecause? }, error, startedAt, endedAt, createdAt }
JobsState = { next: [{ id, name, at }], running: [{ id, name, runId, sessionUid }],
              waiting: [{ id, name, runId, title, body }], uncertain: [{ id, name, runId }] }   // also the state's `jobs`
```

Decisions and failures notify your devices (Web Push and APNs, as "needs you").

### Surfaces

- **Web:** Jobs (Ctrl+Shift+6, the sidebar with a badge when something waits on you):
  jobs, their triggers in words, runs with what each delivered, Run now / Pause / Resume /
  Cancel, *New job* (an agent with a prompt, now, at a time, every day, or after a job).
  Decisions also show in the Inbox's **Needs you** with *Go ahead* / *Stop here*.
- **CLI:** `ah jobs`, `ah job add … [--at|--in|--daily|--cron|--after|--when-idle|--when-ended]`,
  `ah job show|pause|resume|cancel|run <id>`, `ah job decide <run> yes|no`,
  `ah job resolve <run> resend|leave`.

## CND-5 Recovery from limits, provider errors and crashes (`recovery` v1)

Sources: `server/recovery/{classify,engine}.ts`. Runs from ah's tick; nothing needs to
be open.

**Evidence only.** A recovery starts from something the agent or ah saw, recorded word
for word (`evidence`):
- the agent's own error lines in its transcript (Claude Code's API error lines, Codex's
  error events), classified as `rate_limit` (with the reset time or retry-after it
  gives), `provider_unavailable` (overloaded, 5xx), `network`, or `credentials` (an
  invalid key, "please run /login", an expired token, billing); anything else is
  `unknown` and ignored;
- the usage-limit notice on the agent's screen, with the reset it prints (the
  transcript's exact time wins over the screen's minute);
- `process_exit`: an agent gone from its window while it was working (its shell left
  behind), or a session found gone while working after a host restart, that you
  didn't end (Terminate records that you did).

Looked at fresh (a new session, or after ah restarts), a transcript that **ends** on an
error written within six hours is current evidence; older or answered ones aren't.

**State machine** (one durable row per conversation, `Recovery`; every step a
`RecoveryEvent` saying why):

```
waiting_capacity   a limit; automatic recovery off: it waits for you (with the reset time)
recoverable        another failure; automatic recovery off
scheduled          automatic recovery on: the next attempt at the provider's time, else backoff
resuming           an attempt was made; watching for the agent to work again
needs_user         credentials (never retried), or a window ah won't type into
failed             attempts spent (maxAttempts, 5)
stopped            you paused it
resolved           the agent is working again (by the attempt, by itself, or by you)
```

**An attempt**, when its time comes, checks first: the agent isn't already working, the
conversation hasn't moved on since the failure (a newer turn in the transcript), the
last attempt's message isn't still queued. Then it sends **one** continuation
(`recovery.prompt`, "Continue where you left off.") through the normal send path,
queued under an id naming the attempt, which resumes an ended session first: the same
conversation, the same launch choices. If work is already queued, it only resumes and
lets the queue go in. A session cut off by a tmux stop or a host restart (CND-8) is
restored instead: its note, saying what happened and where it stopped, takes the place of
the generic continuation. An agent that died in a live window is restarted there with its
own resume command, only when the pane is at a shell prompt, and continued once it's up.
**It never changes model, provider or permissions.** Attempts back off exponentially with
jitter, capped (`maxBackoffSeconds`), and at most `maxActionsPerMinute` (3) go out across
the host. A continuation that doesn't get the agent going within ten minutes counts as a
failed attempt. A limit already recovered from isn't re-detected from its notice still
on screen.

**Off by default.** `recovery.auto` in config sets the host's default; each session has
its own switch (session menu, `ah recovery <target> --auto on|off`, API). Jobs with
`policy.autoRecover` switch it on for the sessions they start. Without it, ah still
records and shows what happened and waits for you (Go on now).

Config: `recovery: { auto, maxAttempts, backoffSeconds, maxBackoffSeconds, jitterSeconds,
prompt, maxActionsPerMinute }`.

### Shapes and routes

```ts
// windows[].recovery and history[].recovery (optional; absent on older hosts)
recovery: { state, reason, evidence, attempts, maxAttempts, nextAttemptAt, resetsAt, auto, updatedAt } | null
// windows[].limitResetsAt: when the on-screen limit notice says it resets (epoch seconds)
```

| Route | Body | Answer |
|---|---|---|
| `GET /api/recovery` | | `{ recoveries: [...], config: { auto, maxAttempts } }` |
| `GET /api/sessions/:uid/recovery` | | `{ auto, recovery, events: [{ at, state, detail }] }` |
| `POST /api/sessions/:uid/recovery` | `{ action: 'retry' \| 'pause' \| 'resume' \| 'cancel' }` or `{ auto: boolean }` | the same |

### Surfaces

- **Web:** a `↻` pill in the session header ("limited until 5:20 PM", "going on at…",
  "sign in again", "kept failing"), its evidence and attempts on hover; the session
  menu's Go on now, Pause/Resume recovery, Stop retrying, and *Keep going after limits
  and crashes*.
- **CLI:** `ah recovery` (what's being recovered), `ah recovery <target>` (its history),
  `--retry`, `--pause`, `--resume`, `--cancel`, `--auto on|off`.

## CND-6 Usage, limits and cost (`usage` v1)

Sources: `server/usage/{ingest,prices,service}.ts`. Read every minute, incrementally.

**Where each number comes from**, said beside it:

| Field | Source | Means |
|---|---|---|
| tokens (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`) | `local_telemetry` | read from the agent's own transcript on this host. Claude Code: each message's `usage`, counted **once** per message id (it repeats it on every line of a message). Codex: each turn's `token_count` (`cached_input_tokens` split out of input; reasoning is part of output) |
| rate-limit windows | `provider_telemetry` | what Codex recorded the provider told it (`used_percent`, window length, reset) |
| cooldowns | `screen` / `transcript` | a limit notice or error line (from recovery, CND-5) with its reset |
| `cost.estimateUsd` | estimate | at list price (`basis: list_price`, Anthropic's as of 2026-10-06) or your price (`configured`); **never a bill** |
| `cost.billing` | your config | `api`, `subscription` or `unknown` per provider: a subscription doesn't bill per token |
| anything else | unknown | agents that record no usage (Gemini, Grok, opencode, Hermes, Cursor, …) are unknown, not zero; tokens with no price are `unpricedTokens`, left out of the estimate, not counted as free |

ah never calls a provider's private endpoints, and never makes a decision about money:
the only use of limits is that **jobs wait** for an agent whose provider stated a limit
(any session of that agent at a limit, or a reported window at 100%), until its reset.
Nothing switches provider or model.

**Bounded.** Daily rows per conversation and model (`usage.retentionDays`, 400); limit
samples kept when they change, 30 days. A pass reads at most 64 MB, from where the last
one stopped, so a long transcript is read once. A rewritten transcript is recounted, not
added; a transcript ah copied (a fork, a native continuation, a move from another host)
counts only what's written to it after the copy, since its history counted where it
happened.

Config: `usage: { retentionDays, prices: { "<model id>": { input, output, cacheRead?, cacheWrite? } }, billing: { anthropic: 'subscription', openai: 'api' } }` (USD per million tokens).

### Routes

| Route | Answer |
|---|---|
| `GET /api/usage?by=day\|model\|provider\|harness\|session&from=&to=` | `{ from, to, by, rows: [UsageRow], notes }` |
| `GET /api/usage/limits` | `{ windows: [{ harness, provider, window, usedPercent, windowMinutes, resetsAt, source, observedAt }], cooldowns: [{ harness, uid, resetsAt, source, text }] }` |
| `GET /api/usage/export?format=csv\|json` | every daily row (CSV cells can't start a spreadsheet formula) |
| `GET /api/sessions/:uid/usage` | `{ metered, models: [{ model, input, output, cacheRead, cacheWrite, messages, cost }], notes }` |
| `POST /api/usage/refresh` | reads what's new now: `{ files, bytes, events }` |

```ts
UsageRow = { key, provider, harness, model, uid,
  tokens: { input, output, cacheRead, cacheWrite, reasoning, source: 'local_telemetry' },
  messages, sessions,
  cost: { estimateUsd: number | null, basis: 'list_price' | 'configured' | null, unpricedTokens, billing } }
```

### Surfaces

- **Web:** Usage (Ctrl+Shift+7): tiles (tokens in, out, cache reads, the estimate marked
  *estimate* with your billing), tokens per day (a chart with a readout, or a table), the
  limit windows with their source, by model, the busiest conversations, CSV/JSON export.
- **CLI:** `ah usage [--days N] [--by …] [--json]`, `ah usage limits`, `ah usage export [--json]`.

## CND-7 Live Activities (`activityPush` v1)

Source: `server/apns.ts` (`ActivityState`, `activityState`, `Apns.follow`). For the
native app: a session you sent to from the phone stays current on the Lock Screen and
in the Dynamic Island, pushed over APNs (`liveactivity` push type), with nothing open.

**Registering.** Only the native app's sign-in can (403 otherwise). The app starts the
activity on the device, then registers its push token:

| Route | Body | Answer |
|---|---|---|
| `PUT /api/push/apns/activity` | `{ uid, token, environment: 'sandbox' \| 'production', rotated?: true }` | `{ ok, activities }` |
| `DELETE /api/push/apns/activity/:uid` | | `{ ok }` |

One activity per session per sign-in: registering another (a new message) replaces the
last. ActivityKit can give a running activity a **new token**; register it with
`rotated: true` and the activity carries on (its age, whether it started, what it last
showed) instead of starting over. Signing out forgets the sign-in's activities; they
survive an ah restart.

**What it shows** (`aps.content-state`, the app's `SessionAttributes.ContentState`):

```ts
{ phase: 'working' | 'waiting' | 'finished' | 'limited' | 'starting' | 'failed',
  detail: string | null,   // one line, ≤ 120 chars; null under a private preview
  answerable: boolean,     // an ask the Lock Screen can approve or deny
  since: number,           // when this phase began (epoch seconds)
  until?: number | null }  // limited: the reset, or when ah will carry on
```

`starting`, `failed`, `interrupted` and `until` are newer than the first app build: a client that
doesn't know a phase shows its name, and ignores `until`.

| The session | Phase | Ends it |
|---|---|---|
| working (`busy`) | `working`, with what it's doing | |
| asking (`waiting`) | `waiting`, with the ask; `answerable` when it can be answered there | |
| at a limit, automatic recovery planned (`recovery.state` `scheduled`) | `limited`, "Going on after the reset", `until` = the attempt | no |
| at a limit, no plan | `limited`, the notice, `until` = its reset | yes |
| another failure with a retry planned | `limited`, "Trying again", `until` | no |
| recovery picking it up (`resuming`) | `starting` | |
| credentials (`needs_user`) | `waiting`, "Sign the agent in again" | |
| recovery gave up (`failed`) | `failed`, the evidence | yes |
| done (idle, attention), or gone | `finished` | yes |
| gone in a crash or restart (CND-8) | `interrupted`, what cut it off | yes |

A change of phase goes out at once (priority 10); a new line of what it's doing at most
every 15 s at priority 5 (Apple budgets these). An activity starts following only once
the message reached the session (it was working), lingers a while after it ends, and is
dropped when Apple says its token is gone or after Apple's eight hours.

## CND-8 Interrupted sessions (`interruptions` v1)

Source: `server/interruptions.ts`, fed by the registry's end sweep and `serverSeen()` in
`server/tmux.ts`. The case it's built for: on 14 November 2026 the tmux server died and
seven sessions ended in the same second, recorded as plain `ended`, indistinguishable from
sessions you'd finished; two were mid-turn.

**What counts.** A session you didn't end (Terminate) and that wasn't moved, with a
conversation to resume, is *interrupted* when:

| `cause` | Evidence | Which sessions |
|---|---|---|
| `tmux_server` | tmux answers "no server running", or a server with another pid than ah last listed (the old one died, a new one started). At ah's start: a pid other than the one ah saved (`tmux-server.json` in ah's state dir, at most a minute old while ah runs) | every session that was open in it, working or not |
| `host_restart` | at ah's start, the host booted after ah last ticked (else after the session's last activity) | every session that was open |
| `window` | its window closed while the agent was working or waiting | that one |

A window that closes while its agent is idle is someone closing it: an end, as before.
Shell sessions and sessions with no conversation yet are never interrupted. ah's own
restarts aren't interruptions: tmux outlives ah, so its windows are still there.

**Where you see it.** One notification per incident ("7 sessions were interrupted · The
tmux server stopped; 2 were working. Restore them in ah."), `ah restore`, and every
client through the state (`interruptions`, history's `interrupted`, below). A Live Activity following an interrupted
session ends as `interrupted` with what cut it off (CND-7).

**Restoring** is one step for one or all. Mid-turn ones go first, one after another, each
resumed in its own conversation with its own launch choices (the resume path; never
another model, provider or permission mode). Prompts you'd queued stay queued, in order.
A mid-turn one is first sent a note, queued ahead of your prompts:

> [ah] This session was interrupted at Sat Nov 14 2026 15:38:05 GMT+0200: the tmux server
> it ran in stopped while you were working, and ah has restarted you in the same
> conversation. The last step recorded: you called Bash ("npm test"). Check the state of
> whatever you were in the middle of (files being edited, commands or servers that were
> running) before you carry on from where you stopped.

The last step is the newest assistant entry in the transcript's last 256 KB: its last
tool call with its main argument (command, file, path, pattern, URL, query), else the start
of its text, on one line and clipped. One that had finished is resumed without a message.
`note: false` restores without the note. Restoring twice, or concurrently, restores once;
any way back (Resume, sending to it, recovery) clears the interruption. Dismissing clears
it and drops an unsent note, leaving your prompts. With automatic recovery on (CND-5), a
mid-turn session's recovery attempt goes through the same restore (the note under the
attempt's id); restoring it yourself settles its recovery.

### Shapes and routes

```ts
// history[].interrupted (optional; null when it wasn't)
interrupted: { cause: 'tmux_server' | 'host_restart' | 'window', at, lastSeenAt, incident, lastStatus, midTurn } | null
// state.interruptions (always present on hosts with the feature)
interruptions: { count, midTurn, incidents: [{ id, cause, at, count, midTurn }] }
```

`at` is when ah noticed, `lastSeenAt` when it last saw it running (they differ after a
restart: it went down in between). Sessions cut off together share an `incident`.

| Route | Body | Answer |
|---|---|---|
| `GET /api/interruptions` | | `{ interruptions: [{ uid, title, harness, cwd, queued, ...interrupted }], count, midTurn, incidents }`, mid-turn first |
| `POST /api/interruptions/restore` | `{ uids?: string[] } \| { incident } \| { all: true }`, `note?: false` | `{ restored: [{ uid, windowId, resumed, noted, midTurn }], failed: [{ uid, error, code }] }` |
| `POST /api/interruptions/dismiss` | `{ uids? } \| { incident } \| { all: true }` | `{ dismissed }` |
| `POST /api/sessions/:uid/restore` | `{ note?: false }` | the restored entry (201 when resumed); 409 `not_interrupted`, 404 `not_found` |

A body with no target is refused (400 `invalid_target`): everything happens only when
you say `all`. Restores and dismissals are in the audit log.

### Surfaces

- **Web:** a card per incident first under the Inbox's *Needs you* ("3 sessions were
  interrupted · The tmux server stopped at 3:38 PM; 1 was working"), each session with what
  it was doing (was working, was asking, had finished) and its own Restore, then Restore
  all and Dismiss; the tagline counts them instead of "All quiet.". An interrupted session's
  page says *Interrupted* and what Restore will do, and Restore (with a message: Restore and
  send) restores it first so your message goes in after the note. History marks them
  *interrupted* / *interrupted mid-turn*, with Restore in place of Resume.
- **CLI:** `ah restore` (the list), `ah restore --all`, `ah restore <target>`,
  `--incident ID`, `--no-note`, `--dismiss`.
- **Native:** state `interruptions` and history's `interrupted`; the incident's alert
  (route `interrupted`); the Live Activity's `interrupted` end.

