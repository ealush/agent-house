# 16 · Subagents (`SUB`)

When a session's agent spawns agents of its own (Claude Code's Agent tool, Codex's
multi-agent threads), each child is a session ah shows under the one that spawned it:
found without hooks, counted on its parent's row, browsable as a tree (nested children
too), its conversation read and followed live like any session's, and still there when
the parent has long ended. Asked for by the owner on 20 November 2026 ("subagents should
feel like sessions, not like debug logs attached to sessions").

The routes follow the conductor's contract rules ([13](13-conductor.md#contract-rules-all-of-cnd)):
`api` stays 28, the capability is `subagents` in `features`, errors are `{ error, code? }`,
every route is behind sign-in, and a peer's children are reached through `/h/<host>/…`
like the rest of its sessions.

| Feature | Version | Routes and fields |
|---|---|---|
| `subagents` | 1 | `windows[].subagents`, `GET /api/sessions/:ref/subagents`, a child's ref in `…/feed`, `…/feed/stream`, `…/feed/prompts` |

## SUB-1 Where children come from (verified, 2026-11-20)

ah keeps nothing of its own about a child: the harness already writes everything that
matters, durably, and a child's identity is a function of the harness's own ids. Any
number of reads, a restarted ah, a reconnecting client or a child found long after it
finished all arrive at the same tree, with the same refs, and nothing is ever counted
twice.

**Claude Code** (2.1.300, read on real sessions with nested and background agents):

- `<projects>/<cwd>/<session>/subagents/agent-<agentId>.jsonl`: the child's transcript,
  every line `isSidechain: true`, its first user line the instructions it was given.
- `agent-<agentId>.meta.json` beside it: `agentType`, `description`, `toolUseId` (the
  parent's Agent call), `parentAgentId` (nested children), `spawnDepth`, `requestShape`
  (`foreground`/`background`). Nested children sit flat in the same folder.
- Its outcome is in its parent's transcript (the root's, or `agent-<parent>.jsonl`): the
  Agent call's `tool_result` (`toolUseResult.status: completed` inline for a foreground
  child, `async_launched` for a background one), and for a background child a
  `<task-notification>` naming its id with a `<status>`, written as a `queue-operation`
  or a `queued_command` attachment. Notifications quoted anywhere else are ignored.

**Codex** (0.162.1, real `codex exec` runs, and a real 0.160 multi-agent v2 thread):

- Each spawned thread is a rollout of its own. Its (first) `session_meta` says
  `source.subagent.thread_spawn` with `parent_thread_id`, `depth`, `agent_nickname`,
  `agent_role`, and `session_id` is the tree's root. A v2 thread copies its parent's
  history after its own meta (the parent's `session_meta` first among it);
  `subagent_history_start_ordinal` says where its own begins, and its feed starts there.
- Its turns start and end in it: `task_started`, then `task_complete` or `turn_aborted`.
- Threads the harness runs for itself (`source.subagent.other`, e.g. a guardian review)
  are kept out of history and adoption, and aren't shown as subagents.

Discovery used to show every spawned Codex thread as a conversation of its own, and a
window still waiting for its id could adopt its first child's thread; spawned threads now
stay out of history and adoption.

## SUB-2 Identity

| What | Ref | Unique because |
|---|---|---|
| A Claude child | `claude:<session id>:<agent id>` | Agent ids are unique in their session's folder |
| A Codex child | `codex:<thread id>` | Thread ids are UUIDs (v7) |

A ref is accepted wherever a session ref is. It is resolved only through what discovery
found: a Claude child's file is `<the root's transcript folder>/subagents/agent-<id>.jsonl`,
with the session id a UUID and the agent id `[A-Za-z0-9_-]{1,48}`, and the file must be
there, a regular file (links are never followed). A guessed or malformed ref names
nothing (404 or an empty tree). Refs are host-local, as uids are: a client keys a peer's
child by its host, as it does a peer's sessions.

## SUB-3 Lifecycle

`running`, `waiting` (its own work done, its children still at theirs), `completed`,
`failed`, `canceled`, `unknown`. The rules, in order (`server/subagents/model.ts`):

1. **What its parent was told wins.** Claude: the spawning call's result (an interruption
   → canceled, an error → failed, a foreground result → completed) or, for a background
   child, its newest notification (`completed`, `failed`, `killed`/`stopped` → canceled).
   Codex: its own newest turn event (`task_complete` → completed, `turn_aborted` →
   canceled). A completed Codex thread given more work runs again.
2. **While the process that runs it lives**, a child written to since that process
   started is running. Its own last words don't end it: Claude writes a text block
   before the tool call that follows in the same message, with no stop reason on either.
3. **Once nothing will write to it**: a Claude child whose last word was its answer is
   completed, an error failed, an interruption canceled.
4. **Otherwise unknown.** A parent that ended, or restarted since the child last wrote,
   with no outcome on record is not proof the child stopped, and it is never shown as
   running either.

## SUB-4 Capabilities

Each child says what can be done with it, and only what ah can really carry out. Neither
harness lets a supervisor of its terminal UI reach one child of a running agent:

| Capability | Claude Code | Codex |
|---|---|---|
| Discover children, parent and root | yes (sidecar + parent's transcript) | yes (session_meta) |
| Nested children | yes (Claude: up to 3 levels by default) | yes (Codex: 1 level unless `agents.max_depth` is raised) |
| Read the transcript, history | yes | yes |
| Follow it live | yes (its transcript, polled like any feed) | yes |
| Lifecycle | yes; failed/stopped notifications never seen on disk, handled by their documented status names | yes |
| `send`: a message to it alone | **no**: only the parent agent can (SendMessage); ACP says "a client cannot prompt … a child" | **no** from outside: the TUI's own `/agent` picker, or an app-server client on the same daemon (not ah's integration) |
| `cancel`: stop it alone | **no**: only the SDK's `stopTask` (ACP's `session/cancel`), or `x` in the TUI's `/tasks` | **no** from outside: app-server `turn/interrupt` or the model's `close_agent` |
| `continue`: go on as a session of its own | no | **yes, once its tree has stopped**: `codex resume <thread>` (verified with 0.162.1) through `POST /api/sessions/codex:<thread>/resume` |

So `send` and `cancel` are always false, and the app shows a child read-only: to steer
one, talk to its parent. A message or a resume to a Claude child is refused with 409
`subagent_read_only`; a Codex child's resume while its root or parent still runs with
409 `subagent_running`.

## SUB-5 Wire

`windows[].subagents` (present for agents ah reads subagents of; zeros until one is
spawned):

```json
{ "total": 3, "active": 2, "completed": 1, "failed": 0, "rev": "9ho7zp" }
```

Counts cover the whole tree, nested children too; `active` is running + waiting, `failed`
is failed + canceled. `rev` changes whenever anything in the tree does (a child, a
state, its last activity): a client that shows the tree fetches it again then.

`GET /api/sessions/:ref/subagents` (`:ref` a uid, a history ref, or a child's ref, which
answers its whole tree and names it in `self`):

```json
{
  "root": { "ref": "claude:421c…", "uid": "8c1d2f0a", "title": "Refactor server architecture", "live": true },
  "self": null,
  "nodes": [
    { "ref": "claude:421c…:a5e458ae8133f318e", "harness": "claude", "agentId": "a5e458ae8133f318e",
      "parentRef": "claude:421c…", "rootRef": "claude:421c…", "depth": 1,
      "name": "API boundary refactor", "role": "general-purpose", "prompt": "Refactor …",
      "state": "running", "background": true, "startedAt": 1795127000, "updatedAt": 1795127300, "endedAt": null,
      "activity": "Edit: server/api/feed.ts", "toolCallId": "toolu_01…",
      "capabilities": { "transcript": true, "live": true, "send": false, "cancel": false, "continue": false } }
  ]
}
```

Nodes come parents first, siblings in the order they were spawned; a child whose parent
isn't known hangs from the root. 404 `no_subagents` for a session whose agent has none
ah can read (a shell, another harness); 404 `session_not_found` for a ref that names
nothing. `toolCallId` is the parent's Agent call: a client opens the child from it in
the parent's transcript.

A child's conversation is its ref's feed: the Claude child's own transcript, the Codex
thread's rollout from where its own history starts.

## SUB-6 Cost

Per pass (1.5 s), for each live Claude or Codex session, in the background (the row
carries the last pass's summary): one `lstat` of its subagents folder (Claude) or the
discovery list (Codex, rescanned every 3 s while the session works, else 15 s), then for
each child a stat; a child's start and end are read in 64 KB slices only when its size
changes, and a parent's transcript is read on from where it was left, its lines skipped
by a substring test unless they could be an outcome. On this machine a session with six
children (two levels) reads in 22 ms cold and 1 ms after. Caches are bounded (4 000
files, 400 parents, 500 children a folder).

## SUB-7 Limits

- Only Claude Code and Codex. Grok, opencode, Hermes and Muse record a parent link too
  (their discovery skips their children); they can join through `server/subagents`.
- A child can't be messaged, stopped or resumed alone (SUB-4). Stopping the parent
  (its Stop) stops its turn, and with it its foreground children.
- Claude deletes transcripts after its cleanup period (30 days); a child's history lasts
  as long as the harness keeps it.
- A Claude child started by a forked skill has no `toolUseId`: it can't be opened from
  the parent's transcript, only from the tree.
