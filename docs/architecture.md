# Server architecture

How `server/` is put together, which rules hold, and where each kind of code goes. Paths
on this page are inside [`apps/server`](../apps/server) unless they start with `docs/`.
Rules marked *(checked)* are enforced by tests (`test/architecture.test.ts`,
`server/errors.test.ts`, `server/routes.test.ts`, `test/contract.test.ts`); the rest
are conventions a reviewer holds you to. Keep this page current: change it in the same
commit as the code it describes.

## Shape: a modular monolith, functional core, imperative shell

One process (`node server/main.ts`) serves the web client, the native app, the CLI and
peer hosts. Inside it:

| Layer | What it is | May depend on |
|---|---|---|
| **Domain core** | Decisions, policies, parsing, state transitions: plain values in, plain values out. | Other core modules; types from anywhere. |
| **Application services** | A context's use cases (send a note, run a job, recover a session). Orchestrate effects through *ports* they're handed (a `deps` object, a `PrismaClient` passed in). | Core; ports (interfaces) only. |
| **Infrastructure** | tmux, processes, the filesystem, Prisma, gh/git, providers, APNs/Web Push. | Node, packages. Never routes. |
| **Delivery** | `admission.ts` (who gets in), `api/*.ts` (one route table per context), the sub-routers (`review/api.ts`, `jobs/api.ts`, …), SSE, the terminal WebSocket, the CLI. Decode and validate input, authorize, call one use case, map its outcome to the protocol. | Application services, `http.ts`, `errors.ts`. |
| **Composition root** | `main.ts`: builds every service, connects their ports (`core.connect`, each context's `deps`), starts the server. The only place that knows every context. | Everything. Nothing depends on it. |

A request, end to end: `handle()` (main.ts) → the gate (`gate.ts`: Host, Serve
identity) → `admitRequest()` (`admission.ts`: CSRF, `/h/<host>`, default deny) →
`api()` → the first matching route in its context's table (`api/<context>.ts`) →
one service call → `send()`; any `DomainError` on the way becomes its status and
`{ error, code? }` (`errorReply()`), anything else a logged 500.

## Rules

1. **No import cycles.** *(checked)*
2. **The functional core reaches no I/O on its own.** Modules listed in `CORE` in
   `test/architecture.test.ts` may not import `fs`, `child_process`, sockets, Prisma or
   the like, directly or through anything they load. Effects come in through ports.
   Grow the list as decisions are extracted; never shrink it. *(checked)*
3. **Reading the config loads nothing else.** `config.ts` parses `config.json`; each
   context owns its settings type and defaults in a leaf module (`usage/settings.ts`,
   `recovery/settings.ts`). *(checked)*
4. **Domains say no with a `DomainError`.** Each context has its own subclass
   (`JobError`, `NoteError`, …) carrying an HTTP-meaningful `status`, a message and a
   stable `code`. The edge turns any of them into a response with `errorReply()`
   (`errors.ts`); anything else is a logged 500 that says only "internal error". Routes
   don't catch and re-wrap domain errors. Codes a client acts on are listed in
   `packages/protocol/errors.md`. *(checked: every exported `*Error` a request can meet extends
   `DomainError`; every code the sessions use is in the list)*
5. **A context is used through its service and its types, not its internals.** Another
   context calls `scheduler.create(…)`, never reads the scheduler's tables.
6. **Ports are narrow and named for what the caller needs** (`send`, `resolve`,
   `queueIds`), not for how the host does it. A context never imports `core.ts`; the
   composition root implements its ports, through `SessionGateway` where they're
   about sessions.
7. **Who gets in is one pure decision.** `admission.ts` decides every request and
   WebSocket upgrade that passed the gate: CSRF (X-AH plus ah's own Origin, or the
   native app with nothing ambient), `/h/<host>` routing, and default deny outside
   `PUBLIC_ROUTES`. `handle()` and `upgrade()` only gather the facts and carry out the
   answer. Change a rule there, with its test, never in a handler.
8. **Routes live in their context's table.** `server/api/<context>.ts` exports
   `<context>Routes(deps)`: an ordered list of `route(method, /^…$/, handler)`, given
   only the services it uses. `api/index.ts` puts the tables together. The full list is
   pinned in `packages/protocol/api-routes.txt` (`server/routes.test.ts`, which also fails on a
   route shadowed by an earlier one and on a public route admission doesn't let
   through). *(checked)*
9. **Wire shapes are contracts.** Paths, field names, status codes, error `code`s, SSE
   frames and WebSocket close codes are consumed by ah-native and the web client.
   Change them only additively, and announce new capabilities in `features.ts`;
   `API_VERSION` (core.ts) stays 28 while the native app checks it for equality.
   `test/contract.test.ts` pins what clients read (hello, auth status, state,
   capabilities, the first SSE frame, a send, a queue, the error body) in
   `packages/protocol/wire-shapes.txt`: every listed field must stay, with its type, and
   the real answers it was taken from (`packages/protocol/fixtures`) decode in the app's own
   decoders (`apps/ios/Tests/Core/ProtocolFixtureTests.swift`). *(checked)*

10. **Every action is in the audit log.** A route that changes something calls
    `audit(req, event, detail)` (never with secrets or message text), or is listed in
    `NOT_AUDITED` in `server/routes.test.ts` with why not; `/api/auth` is audited inside
    `auth.ts`. *(checked)*

## Effects, commit points and what a crash leaves

The operations that span more than one effect, in the order they take them, and why.

| Operation | Order | A crash or failure in between leaves |
|---|---|---|
| Start a session (`Core.launch`) | acquire checkout (worktree + atomic DB writer claim) → window → its options → registry `starting` (returns an undo) → command | `abandonStart(undo)` + checkout rollback: a newly created worktree, temp dir and writer claim are released; a resumed record is put back as it was, its queue returned. Never a leaked worktree or deleted session. |
| Send (`Core.send`) | resume if needed → input lock → queued? delivered? (by `id`) → snapshot → paste → note the id | A named message asked again answers `queued` / `delivered`; nothing is typed twice. Unnamed sends are new messages. A send to an ended record whose conversation runs in another window (relaunched) goes to that window; nothing new starts. |
| Deliver a queued follow-up (`deliverDue`, `sendNow`) | input lock → snapshot → **take** → paste → note the id | The follow-up stays queued (on disk) until the instant it's typed. A paste that typed nothing goes back first; once text landed it counts as delivered. |
| Answer a prompt (`answer`, `choose`, a free-text answer by `send`) | input lock → re-read the window (never a `tick()` under the lock) → claim the prompt (`AnswerGuard`) → keys | A second answer to the prompt just answered is 409 `already_answered` (a free-text one is queued); keys that failed release the claim. The hold lasts until a pass sees the prompt go, or 4 s. |
| Stop | input lock, waited for at most 1 s → keys | Not between a send's paste and its Enter; never more than a second late. |
| Relaunch | new window → input lock → kill the old one | A message that went in since relaunch's check cancels it; a message to the old uid afterwards follows the conversation. |
| Hand a note to an agent (`notes/handoff.ts`) | row `sending` → send (named) → wait for the queue on disk → row | Uncertain until confirmed; a retry is the same write. |
| Take PRs into a review (create, add layers, a sync joining) | per-repo claim → "not under review"? → insert | One PR is in at most one open review. |
| Dispatch review findings (`ReviewService.dispatch`) | dispatch row → send named `rd-<id>` → queue id | A failed send removes the row; a sent one is never unrecorded. |
| Registry writes (`Registry.flush`) | changed rows + deletions, one write at a time | A failed write is pending again (rows and deletions): the next flush retries. |

Locks (all in-process, per session): the **input lock** (`Core.withInput`) serializes
everything typed into a session; snapshots have their own (`TurnSnapshots.exclusive`).
Nothing holding the input lock may wait on a pass (`tick()`): a pass delivers queued
follow-ups through the same lock, so the two would wait on each other forever.
Reading tmux into windows (`buildWindows`) is one read at a time: a read registers what
it finds (a new window gets its uid), so two overlapping reads could register one
window twice.
Neither survives a restart: what must survive is on disk first (the queue, the
delivered-id ledger, the dispatch row).

## Bounded contexts

| Context | Owns | Lives in | Talks to the rest through |
|---|---|---|---|
| Sessions & lifecycle | The registry of sessions (uid ↔ tmux window ↔ conversation), launch, resume, fork, status, the state stream | `core.ts`, `sessions.ts`, `registry.ts`, `launch.ts`, `tmux.ts`, `stateStream.ts` | `SessionGateway` (for other contexts), `Core` (for routes) |
| Messaging & delivery | Typing into an agent, the per-session queue, delivery confirmation, the delivered-id ledger | `queue.ts`, `core.ts` (send, sendNow) | `Core.send` → `SendResult` |
| Screens & answers | Reading an agent's screen (pickers, questions, sign-in/trust gates), answering it once | `choices.ts`, `agentgate.ts`, `answers.ts` (pure), `core.ts` (answering) | `WindowView.ask`, `askId` |
| Turn snapshots | The tree before each turn, the per-session switch, retention | `turnSnapshots.ts`, `snapshots.ts`; restore in `core.ts` | `Core.listSnapshots`, `restoreSnapshot` |
| Conversations & feeds | Transcripts on disk, per-harness adapters, the feed stream | `feed/`, `discovery.ts`, `replies.ts`, `search.ts` | `feedPage`, `streamFeed`, `discover` |
| Portability & migration | Continuing a conversation in another agent or host | `portable/`, `migrate/`, `fork.ts` | `PortableService`, `MigrationService` deps |
| Jobs | Scheduled and conditional runs | `jobs/` | `SchedulerDeps` |
| Recovery & interruptions | Sessions cut off or stuck on a provider error | `recovery/`, `interruptions.ts` | `RecoveryDeps`, `InterruptionDeps` |
| Notes | Scratchpads synced by revision, handed to agents | `notes/` | `NotesStore`, `Handoffs` deps |
| Spaces | Where sessions belong: the list, plain Spaces (their folder, preferences and memory), removing and restoring (docs/spec/17-spaces.md) | `spaces/` (`model.ts` pure; `files.ts`; `service.ts`) | `SpacesService` (Core reads `historyFilter` and `spaces.state()` through `CoreViews`) |
| Checkouts | Concurrent agent workspaces: automatic worktree isolation, atomic exclusive writer ownership, port/temp allocation, overlap & merge-tree checks, startup/periodic disk-pressure-aware GC (docs/spec/18-checkouts.md) | `checkouts/` (`settings.ts`, `model.ts` pure; `git.ts`; `service.ts`) | `CheckoutsService` (launch/resume/fork acquire & rollback, `api/checkouts.ts`, `CoreViews.checkouts`) |
| Subagents | The agents a session's agent spawned, as a tree of sessions: identity, lifecycle, capabilities, where each child's transcript is (docs/spec/16-subagents.md) | `subagents/` (`model.ts`, `claude.ts`, `codex.ts` pure; `store.ts` reads; `service.ts`) | `SubagentService` (Core holds it), `Core.subagentTree`, child refs through `Core.feedSource` |
| Review | Stacked PRs, reviewer chats, merges | `review/` (`view.ts`, `owners.ts`, `stack.ts` pure) | `ReviewService` deps |
| Identity & access | Passkeys, native devices, tokens, the gate, admission | `auth.ts`, `gate.ts`, `admission.ts` | `Auth.identify` → `Caller` |
| Hosts | Peers, proxying `/h/<host>/…` | `peers.ts` | `Peers` |
| Files & uploads | Rooted file access, streamed uploads | `files.ts`, `uploads.ts` | `safePath`, `receive` |
| Voice, side chats, subscriptions | Provider calls through your subscriptions | `voice.ts`, `sidechat.ts` | `VoiceService`, `SideChatStore` |
| Attention | Web Push, APNs, Live Activities | `push.ts`, `apns.ts` | `Push.alert` |
| Usage | Tokens and limits from transcripts | `usage/` | `UsageDeps` |

## Decisions

- **Late binding through one typed call, not constructor injection.** Core and the
  contexts built on it need each other (review shows in the state; review sends
  through Core). `core.connect({...})` takes every connection at once, required by its
  type, once; contexts get `deps` objects. A DI container would hide the same graph.
- **Route tables, not a framework.** `route(method, regex, handler)` and a first-match
  `match()` are 40 lines; the manifest test pins the result. Handlers keep using
  `send`/`readJson`/`str` directly.
- **At most once for typed text.** When ah can't tell whether text reached the agent
  (a paste that partly landed), it counts as delivered: a lost message is visible and
  can be sent again, a duplicate turn can't be taken back. Named messages make the
  retry safe.
- **Contracts are additive and observed.** The wire-shape manifest is generated from a
  running host and only ever checked for removals and retypes.

## Known debt (ranked)

1. **Core still reaches tmux directly** (`import * as t`): its ordering guarantees
   (Stop between a paste and its Enter, a double answer) can only be tested end to end
   with a fake agent. A `Terminal` port handed to Core would make them unit-testable.
2. **`Core.tick` is one long pass**: reading tmux, adopting transcripts, queue delivery,
   snapshots, alerts. Its pure parts (the state diff, turn boundaries, answer holds)
   are out; the pass's own ordering is still implicit.
3. **`review/service.ts` (1,900 lines)** still holds sync, merge and dispatch decisions
   next to their gh/git effects (`layerNeeds`, merge runs, the dispatch watcher). Its
   merge state (`merging`, `settle`) lives in memory and is lost on restart.
4. **Locks are per process.** Two ah processes on one database (a misconfigured
   second instance, the CLI writing) aren't serialized; invariants that must hold
   across processes (one open review per PR, one position per layer) have no database
   constraint.
5. **A review dispatch has no outbox.** Its row is written before the message goes
   out (so a sent message is never unrecorded), but a crash between the two leaves a
   row whose message never went: it settles as "no push". Re-sending pending rows
   under their own id at start (the send ledger makes that safe) would close it.
6. **Tests aren't type-checked** (`tsconfig.json` covers `server/` and `web/`), and a
   dozen unit tests leave their temporary databases and folders in `/tmp`.

