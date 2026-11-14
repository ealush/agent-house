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
