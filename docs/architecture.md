# Server architecture

How `server/` is put together, which rules hold, and where each kind of code goes.
The rules below marked **checked** are enforced by tests (`test/architecture.test.ts`,
`server/errors.test.ts`, `server/routes.test.ts`);
the rest are conventions a reviewer holds you to. Keep this page current: change it in
the same commit as the code it describes.

## Shape: a modular monolith, functional core, imperative shell

One process (`node server/main.ts`) serves the web client, the native app, the CLI and
peer hosts. Inside it:

| Layer | What it is | May depend on |
|---|---|---|
| **Domain core** | Decisions, policies, parsing, state transitions: plain values in, plain values out. | Other core modules; types from anywhere. |
| **Application services** | A context's use cases (send a note, run a job, recover a session). Orchestrate effects through *ports* they're handed (a `deps` object, a `PrismaClient` passed in). | Core; ports (interfaces) only. |
| **Infrastructure** | tmux, processes, the filesystem, Prisma, gh/git, providers, APNs/Web Push. | Node, packages. Never routes. |
| **Delivery** | `admission.ts` (who gets in), `api/*.ts` (one route table per context), the sub-routers (`review/api.ts`, `jobs/api.ts`, …), SSE, the terminal WebSocket, the CLI. Decode and validate input, authorize, call one use case, map its outcome to the protocol. | Application services, `http.ts`, `errors.ts`. |
| **Composition root** | `main.ts`: builds every service, connects their ports, starts the server. The only place that knows every context. | Everything. Nothing depends on it. |

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
   don't catch and re-wrap domain errors. *(checked: every exported `*Error` a request
   can meet extends `DomainError`)*
5. **A context is used through its service and its types, not its internals.** Another
   context calls `scheduler.create(…)`, never reads the scheduler's tables.
6. **Ports are narrow and named for what the caller needs** (`send`, `resolve`,
   `queueIds`), not for how the host does it. A context never imports `core.ts`.
7. **Who gets in is one pure decision.** `admission.ts` decides every request and
   WebSocket upgrade that passed the gate (Host and Serve identity): CSRF (X-AH plus
   ah's own Origin, or the native app with nothing ambient), `/h/<host>` routing, and
   default deny outside `PUBLIC_ROUTES`. `handle()` and `upgrade()` only gather the facts
   and carry out the answer. Change a rule there, with its test, never in a handler.
8. **Routes live in their context's table.** `server/api/<context>.ts` exports
   `<context>Routes(deps)`: an ordered list of `route(method, /^…$/, handler)`, given
   only the services it uses. `api/index.ts` puts the tables together; main.ts hands
   in the services. The full list is pinned in `docs/spec/api-routes.txt`
   (`server/routes.test.ts`, which also fails on a route shadowed by an earlier one
   and on a public route that admission doesn't let through). *(checked)*
9. **Wire shapes are contracts.** Paths, field names, status codes, error `code`s, SSE
   frames and WebSocket close codes are consumed by ah-native and the web client.
   Change them only additively, and announce new capabilities in `features.ts`;
   `API_VERSION` (core.ts) must stay 28 while the native app checks it for equality.

## Bounded contexts

| Context | Owns | Lives in | Talks to the rest through |
|---|---|---|---|
| Sessions & lifecycle | The registry of sessions (uid ↔ tmux window ↔ conversation), launch, resume, fork, status, the state stream | `core.ts`, `sessions.ts`, `registry.ts`, `launch.ts`, `tmux.ts` | `Core` (the only god object left; being split) |
| Messaging & delivery | Typing into an agent, the per-session queue, delivery confirmation | `queue.ts`, `core.ts` (send/sendNow) | `Core.send` → `SendResult` |
| Screens & answers | Reading an agent's screen: pickers, questions, sign-in/trust gates | `choices.ts`, `agentgate.ts` (pure), `core.ts` (answering) | `WindowView.ask` |
| Conversations & feeds | Transcripts on disk, per-harness adapters, the feed stream | `feed/`, `discovery.ts`, `replies.ts`, `search.ts` | `feedPage`, `streamFeed`, `discover` |
| Portability & migration | Continuing a conversation in another agent or host | `portable/`, `migrate/`, `fork.ts` | `PortableService`, `MigrationService` deps |
| Jobs | Scheduled and conditional runs | `jobs/` | `SchedulerDeps` |
| Recovery & interruptions | Sessions cut off or stuck on a provider error | `recovery/`, `interruptions.ts` | `RecoveryDeps`, `InterruptionDeps` |
| Notes | Scratchpads synced by revision, handed to agents | `notes/` | `NotesStore`, `Handoffs` deps |
| Review | Stacked PRs, reviewer chats, merges | `review/` | `ReviewService` deps |
| Identity & access | Passkeys, native devices, tokens, the gate | `auth.ts`, `gate.ts` | `Auth.identify` → `Caller` |
| Hosts | Peers, proxying `/h/<host>/…` | `peers.ts` | `Peers` |
| Files & uploads | Rooted file access, streamed uploads | `files.ts`, `uploads.ts` | `safePath`, `receive` |
| Voice, side chats, subscriptions | Provider calls through your subscriptions | `voice.ts`, `sidechat.ts` | `VoiceService`, `SideChatStore` |
| Attention | Web Push, APNs, Live Activities | `push.ts`, `apns.ts` | `Push.alert` |
| Usage | Tokens and limits from transcripts | `usage/` | `UsageDeps` |

## Known debt (ranked)

Kept current as layers land; the PR stack `arch/*` works down this list.

1. ~~`main.ts` is the composition root *and* the whole HTTP layer.~~ Admission is
   `admission.ts`; routes are `api/*.ts`. main.ts (870 lines) is the composition root,
   the static file server and the WebSocket upgrade. The adapters it builds for each
   context are still inline (next item).
2. The adapters main.ts hands each context duplicate the same rules: "a uid or
   `harness:harnessId`" is resolved in three places, "launch a preset" in four.
3. `Core` is wired by assigning public fields after construction (`core.reviewState =`,
   `core.recoveryOf =`, …): a forgotten assignment is a silent default, not an error.
4. `Core.tick` mixes the state-stream diff (pure) with tmux reads and queue delivery.
5. `review/service.ts` (2,100 lines) holds stack derivation next to gh/git effects.
