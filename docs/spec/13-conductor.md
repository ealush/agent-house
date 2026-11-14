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
