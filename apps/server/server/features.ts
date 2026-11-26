// What this host can do, for clients to read before they offer a feature. The
// state's `api` must stay what shipped clients expect (the native app accepts
// exactly one value), so new capabilities are announced here instead: one
// version per feature, bumped when that feature's routes or shapes change in a
// way a client must know about. An older host sends no entry for a feature, and
// a client then says the host doesn't support it yet rather than guessing.
//
// Contract (docs/spec/13-conductor.md): `features` appears in GET /api/hello
// (before sign-in, versions only), in the state stream, and with each feature's
// limits in GET /api/capabilities.

/** Feature name → contract version. Each feature module adds itself when it ships. */
export const FEATURES: Record<string, number> = {
  /** Per-session companion shells: /api/sessions/:uid/terminal, windows' terminal status. 2: GET …/terminal/text, POST's `run: false`. */
  attachedTerminal: 2,
  /** GET /api/capabilities and these versions. */
  capabilities: 1,
  /** /api/upload and /api/fs/upload stream to disk, with explicit limits and `code` on refusal. */
  uploads: 2,
  /** POST /api/windows is safe under concurrent requests for the same tmux session. */
  concurrentCreate: 1,
  /** /api/portable: portable documents, preview/continue in another agent, lineage, operations (server/portable). */
  portable: 1,
  /** /api/migrations: move a stopped session to another trusted host, with progress, retry and rollback (server/migrate). */
  migration: 1,
  /** /api/jobs: scheduled, recurring, dependent and event-triggered agent work with decisions (server/jobs). 2: `every` interval heartbeats, `session` `waiting`/`repeat`/`*` triggers, `skipIfBusy`/`ifLive` policies, non-transcript harness settlement. */
  jobs: 2,
  /** Recovery from rate limits, provider errors and crashes: windows' `recovery`, /api/sessions/:uid/recovery (server/recovery). */
  recovery: 1,
  /** POST /api/review/sessions/:uid/pulls: open a pull request for a branch the session committed on, and the review of it. */
  reviewPulls: 1,
  /** POST /api/review/stacks/:id/ready: every draft in the stack out of draft at once. */
  reviewReady: 1,
  /** /api/usage: tokens per session, model, provider and day, rate-limit windows, estimates, export (server/usage). */
  usage: 1,
  /** PUT/DELETE /api/push/apns/activity: Live Activity updates over APNs; phases incl. starting/failed, `until`, `rotated` tokens. */
  activityPush: 1,
  /** Sessions cut off by a tmux server stop, a host restart or a closed window: history's `interrupted`, state `interruptions`, /api/interruptions (server/interruptions). */
  interruptions: 1,
  /** /api/voice: dictation through a speech subscription, cleanup by a chat one, the Voice settings (server/voice.ts, docs/spec/14-voice.md). */
  voice: 1,
  /** /api/notes: scratchpads, Markdown notes kept as sessions of their own, synced by revision, saved as files, handed to agents (server/notes, docs/spec/15-scratchpads.md). */
  /** 2: a note's `sessions`, the ones it started or was handed to; POST /api/notes/:id/sessions records one started from it. */
  notes: 2,
  /** GET /api/fs/complete?dir=&q=: the @ completion's files under a folder inside files.roots, for a box with no session (a note's Space). */
  folderFiles: 1,
  /** A prompt is answered once: a second approve/deny/choose for the prompt just answered is 409 `already_answered`. */
  answerOnce: 1,
  /** POST /api/sessions/:ref/send takes an optional `id` ([\w-]{1,40}): asking again with it answers, never types twice. */
  sendId: 1,
  /** Subagents as sessions (server/subagents, docs/spec/16-subagents.md): windows' `subagents` counts, GET /api/sessions/:ref/subagents, child refs' feeds. */
  subagents: 1,
  /** /api/spaces: where sessions belong; Spaces with shared preferences, memory, knowledge promotion & explicit session membership (server/spaces, docs/spec/17-spaces.md). 2: Space-owned context for all Space kinds, PUT /api/sessions/:uid/space, knowledge promote, Chief brief. 3: Spaces are only the ones made (a repository or folder is a project, attached to one with PUT /api/spaces/:name/projects); `space` on sessions and History is the Space each is in (absent: none). */
  spaces: 3,
  /** /api/checkouts: concurrent agent workspaces with automatic worktree isolation, atomic exclusive writer ownership, runtime ports, overlap & merge-tree checks, and disk-pressure-aware GC (server/checkouts, docs/spec/18-checkouts.md). */
  checkouts: 1,
  /** Every message ah types is watched until the agent's conversation shows it; one that never does is listed first in GET /api/sessions/:uid/queue?unsent=1 with `unsent: true` (send-now sends it again, DELETE lets it go), counted in windows' `unsent`. */
  unsent: 1,
  /** /api/system/logging: the host's developer log (on/off, daily folders, last three days kept) and devices' log bundles (server/devlog.ts). */
  logging: 1,
  /** GET /api/fs/media?path=: a picture, video or sound file streamed in byte ranges for the media viewers, read-only, from files.roots and files.media (server/files.ts). */
  media: 1,
  /** POST /api/sessions/:uid/forward: forward a session's prompt/attention to the user's devices; canonical permission levels across harnesses. */
  sessionForward: 1,
  /** PUT /api/sessions/:uid/supervision, GET /api/system/audit, fail-open alert muting, external approval guardrails and caller attribution. */
  supervision: 1,
  /** A Space's live Chief supervises every agent session in it, running or ended, that no live session supervises: written as their `supervision`, nothing to adopt (docs/spec/17-spaces.md). */
  spaceChief: 1,
  /** /api/fleet/mailbox and /api/fleet/tasks: durable cross-session async mailbox and fleet task ledger. 2: live `fleet.revision` in SSE state and per-recipient broadcast acks. */
  fleet: 2,
};

export function features(): Record<string, number> {
  return { ...FEATURES };
}
