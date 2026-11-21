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
  /** /api/jobs: scheduled, recurring, dependent and event-triggered agent work with decisions (server/jobs). */
  jobs: 1,
  /** Recovery from rate limits, provider errors and crashes: windows' `recovery`, /api/sessions/:uid/recovery (server/recovery). */
  recovery: 1,
  /** /api/usage: tokens per session, model, provider and day, rate-limit windows, estimates, export (server/usage). */
  usage: 1,
  /** PUT/DELETE /api/push/apns/activity: Live Activity updates over APNs; phases incl. starting/failed, `until`, `rotated` tokens. */
  activityPush: 1,
  /** Sessions cut off by a tmux server stop, a host restart or a closed window: history's `interrupted`, state `interruptions`, /api/interruptions (server/interruptions). */
  interruptions: 1,
  /** /api/voice: dictation through a speech subscription, cleanup by a chat one, the Voice settings (server/voice.ts, docs/spec/14-voice.md). */
  voice: 1,
  /** /api/notes: scratchpads, Markdown notes kept as sessions of their own, synced by revision, saved as files, handed to agents (server/notes, docs/spec/15-scratchpads.md). */
  notes: 1,
  /** A prompt is answered once: a second approve/deny/choose for the prompt just answered is 409 `already_answered`. */
  answerOnce: 1,
  /** POST /api/sessions/:ref/send takes an optional `id` ([\w-]{1,40}): asking again with it answers, never types twice. */
  sendId: 1,
  /** Subagents as sessions (server/subagents, docs/spec/16-subagents.md): windows' `subagents` counts, GET /api/sessions/:ref/subagents, child refs' feeds. */
  subagents: 1,
  /** /api/spaces: where sessions belong; plain Spaces with shared preferences and memory, removing and restoring (server/spaces, docs/spec/17-spaces.md). State `spaces.revision`. */
  spaces: 1,
};

export function features(): Record<string, number> {
  return { ...FEATURES };
}
