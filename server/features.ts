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
};

export function features(): Record<string, number> {
  return { ...FEATURES };
}
