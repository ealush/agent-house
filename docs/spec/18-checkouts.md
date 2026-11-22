# 18 · Checkouts (`CHK`) — Concurrent Agent Workspaces

Worktrees solve filesystem isolation; they do not by themselves solve concurrent agent
coordination. This spec makes concurrent agent work in a Git repository a first-class
concept in ah: **Repository (Space) → Checkouts → Sessions**.

Asked for by the owner on 22 November 2026: automatic isolation by default, exclusive
writer ownership enforced on the server across every launch path, runtime resource
allocation, observable overlap and integration checks, a repository-level concurrency
and storage view, and automatic disk-pressure-aware worktree reclamation.

## Vocabulary and relationship to Spaces and Workspaces

- A **Space** ([17](17-spaces.md)) is the canonical repository identity (`repoRoot`).
- A **Workspace** ([05](05-workspace.md)) remains a device-local screen/pane layout (Workspaces 1–9).
- A **Checkout** (`CHK`) is one working tree of a repository Space: either the canonical
  **main checkout** (`kind: "main"`) or an ah-managed **worktree** (`kind: "worktree"`)
  under `<parent>/.worktrees/<repo>/<slug>`.
- A **Session** belongs to a Checkout, not directly to a raw repository path.

**Central principle:** Multiple agents may work on the same repository concurrently. At
most one independent writing session may own a Checkout at a time. Integration is
explicit, observable, and recoverable. Worktree storage is managed automatically without
ever discarding unpreserved work.

## Contract

Follows the conductor contract rules ([13](13-conductor.md#contract-rules-all-of-cnd)):
`api` stays `28`, the capability is `checkouts: 1` in `features`, every refusal uses
`{ error, code? }`, and every route is behind sign-in.

| Feature | Version | Routes |
|---|---|---|
| `checkouts` | 1 | `GET /api/checkouts`, `GET /api/checkouts/:id`, `POST /api/checkouts/:id/pin`, `POST /api/checkouts/:id/check`, `POST /api/checkouts/:id/recreate`, `DELETE /api/checkouts/:id`, `POST /api/checkouts/gc` |

Existing `/api/worktrees` routes remain supported and additive for older clients.

### Error codes

| Code | Status | Means |
|---|---|---|
| `checkout_owned` | 409 | Another active writing session already owns this checkout. |
| `checkout_not_found` | 404 | No checkout by that id or path. |
| `checkout_busy` | 409 | A live session or child process is using this checkout. |
| `checkout_dirty` | 409 | Uncommitted or untracked files are present; archive or force explicitly. |
| `checkout_main_protected` | 409 | The canonical repository checkout cannot be removed or reclaimed. |
| `checkout_pinned` | 409 | A pinned checkout is exempt from automatic reclamation. |
| `checkout_branch_missing` | 409 | A reclaimed checkout cannot be recreated because its branch and commit are gone. |
| `checkout_unborn_repo` | 409 | A worktree cannot be created until the repository has at least one commit. |

## CHK-1 · Automatic isolation

Every new writable coding-agent session launched in a Git repository with at least one
commit receives its own managed worktree checkout and `ah/<slug>` branch automatically
when `checkouts.autoIsolate` is enabled (the default).

Isolation is skipped automatically when:
- the preset is a plain shell (`!preset.command` or `preset.id === "shell"`),
- the target directory is not inside a Git repository, or the repository has no commits yet (`unborn`),
- the request is creating a brand-new folder (`create: true`),
- the request is continuing the last conversation in-place (`resume: true`),
- the session continues a conversation in another agent (Continue in, `ah.continued`): it
  always runs in the source's checkout, main or worktree, even while the source is live,
- the session is a scheduled job run: a job keeps its own saved `worktree` setting, and a
  job without one runs in place (no branch per run), or
- the caller explicitly opted out (`worktree: false`, "Use main checkout").

If session launch fails after creating a worktree, ah rolls back the checkout, ownership
claim, and disposable temp directory immediately.

## CHK-2 · Exclusive writer ownership

At most one live or starting writing session may own a worktree Checkout at any time.
The repository's main checkout is shared on purpose: it is tracked (its live writers are
listed) and new-session clients warn when agents are already writing there, but it has no
owner and a launch into it is never refused.

- Ownership is persisted in SQLite (`Checkout.ownerUid`) and acquired atomically inside a
  database write transaction so concurrent requests (web, native, CLI, jobs, fork, resume,
  recovery) cannot assign two writers to the same checkout.
- Before refusing with `409 checkout_owned`, the server reconciles stale owners whose
  sessions have ended or crashed. A claim made in the last 30 seconds counts as live while
  its window is still starting.
- Only a new launch is refused. Resume, restore, crash recovery and continuations never
  fail on ownership: when another session owns the checkout they share it.
- Plain shells (`shell`) are observers: they do not acquire or conflict with writer
  ownership (so you can open a shell inside an agent's checkout to inspect it), though any
  live shell still protects that checkout from reclamation.
- `409 checkout_owned` includes the conflict context (`ownerUid`, `ownerTitle`, `path`,
  `branch`) so clients can jump to the owning session or launch in an isolated worktree.

## CHK-3 · Runtime resource allocation

Each managed checkout receives deterministic, non-overlapping runtime allocations stored
on its record and injected into its session environment:

- `AH_WORKSPACE_ID` — the stable checkout id (`ck-...`)
- `AH_WORKSPACE_ROOT` — the checkout's absolute path
- `AH_REPO_ROOT` — the canonical repository root
- `AH_PORT` and `AH_PORT_END` — a contiguous port block allocated from
  `checkouts.portRange` (default `41000–41999`, 4 ports per checkout, disjoint from
  `preview.ports`)
- `AH_TEMP_DIR` — a per-checkout disposable temp directory reclaimed when the checkout is
  removed

Repositories may optionally place `.ah/workspace.json` at the repo root to declare extra
static environment variables (with `${AH_PORT}`, `${AH_WORKSPACE_ID}`, `${AH_TEMP_DIR}`,
`${AH_WORKSPACE_ROOT}` interpolation). A repository can't set what decides which programs
run or what they load (`PATH`, `HOME`, `SHELL`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`,
`PYTHON*`, `GIT_*`, …) nor ah's own `AH_*`; those entries are ignored.

*Scope note:* Worktrees and environment allocation are not OS sandboxes. An unrestricted
agent shell can still write outside its working directory by absolute path; filesystem
confinement requires OS-level sandboxing.

## CHK-4 · Observable overlap and integration checks

For each tracked checkout in a repository, ah records `baseSha`, `baseBranch`, current
`branch`, `ahead`, `dirty`, and the set of changed files (committed since `baseSha` plus
working-tree modifications and untracked files).

- **Pairwise overlap detection:** Whenever two non-reclaimed checkouts in the same
  repository touch overlapping file paths, ah computes and exposes those overlaps on both
  checkouts and in the repository summary.
- **Non-destructive compatibility check (`POST /api/checkouts/:id/check`):** Uses
  `git merge-tree --write-tree <trunk> <branch>` to evaluate whether a checkout's branch
  merges cleanly with the latest integration branch without touching any working tree or
  index. Never silently rebases or merges into an active agent's checkout.
- **Review handoff:** Once a checkout's branch has a PR, Stack Review ([12](12-review.md))
  remains the authority for PR review, checks, and merging.

## CHK-5 · Lifecycle and automatic disk reclamation

A checkout is **managed** when ah made its worktree for a session (`Checkout.managed`).
Worktrees found on disk under `.worktrees/<repo>/` (made by hand, or by ah before
Checkouts) are listed with their owners, sizes and overlaps, and can be removed by hand,
but are never reclaimed automatically.

Every managed worktree checkout moves through an explicit lifecycle:

| State | Meaning |
|---|---|
| `active` | Owning agent is `live`/`starting`, or a live shell/process is running in it. |
| `retained` | No active owner; work preserved (dirty files, resumable session, or inside retention window). |
| `archived` | Clean and merged into trunk (or explicitly archived); eligible after grace period. |
| `reclaimed` | Worktree directory and disposable temp dir removed; Git branch and DB record preserved. |

### Default retention policy (configurable under `config.json → "checkouts"`)

| Condition | Automatic behavior |
|---|---|
| Main repository checkout | Never delete |
| Worktree ah didn't make (found on disk) | Never auto-delete |
| Active session or live process | Never delete |
| Pinned checkout | Exempt from automatic cleanup |
| Dirty or untracked files | Never auto-delete (even under disk pressure) |
| Clean, merged into trunk, no active owner | Reclaim after `mergedRetentionHours` (default 24h) idle |
| Clean, unmerged branch, no active owner | Reclaim checkout after `unmergedRetentionDays` (default 7d) idle; preserve Git branch |
| Failed session launch | Roll back immediately |
| Disk pressure (`free < minFreeBytes` or `total > diskBudgetBytes`) | Reclaim oldest-eligible clean, unpinned, non-active measured checkouts early, until the threshold is met; never one idle under an hour or whose conversation can still be resumed |

Idle time runs from the later of the checkout's own activity and its sessions' last
activity. A resumable conversation's checkout waits out its window; after that, resuming
recreates it (below). An `ah/*` branch that never got a commit is deleted with its
checkout; any branch with work stays.

### Safety and recovery guarantees

- Cleanup runs at server startup (after registry load and reconciliation), periodically
  every `gcIntervalSeconds` (default 15 minutes), and on demand (`POST /api/checkouts/gc`,
  supporting `dryRun: true`).
- Immediately before removing any checkout, ah revalidates ownership, live windows, any
  process whose working directory is inside it (Linux), managed-root containment, pin
  state, and Git dirty status.
- Uses `git worktree remove` and `git worktree prune`; never blindly deletes directories.
- **Resume after reclamation:** Conversation transcripts live independently of worktrees.
  When resuming a session whose checkout was `reclaimed`, ah recreates the worktree at its
  original path from the preserved branch (or base commit) before starting the agent. Only
  when that's impossible (branch and commit both gone) does it fall back to `~`, as before.
- Multi-host checkouts are reconciled and reclaimed independently per host.

## CHK-6 · Clients and CLI

- **New session (web & native):** Coding agents in a Git repository default to an isolated
  checkout automatically, with an explicit toggle to use the main checkout instead. On
  `409 checkout_owned`, the client surfaces who owns the checkout and lets the user launch
  an isolated checkout instead. Against a host without the `checkouts` feature, both keep
  the old opt-in switch, off by default.
- **Checkouts & storage view (web & native):** Groups checkouts by repository Space,
  showing owner agent and status, branch, ahead/dirty counts, overlapping files,
  compatibility check status, pin toggle, "+ Parallel session" action, and a storage card
  with Total / Active / Retained / Reclaimable sizes and Cleanup trigger.
- **CLI:** `ah new` supports `--no-worktree` (alongside `--worktree`); `ah checkouts`
  lists repositories, overlaps, and storage, with `ah checkouts gc [--dry-run]`,
  `ah checkouts check <id>`, and `ah checkouts pin <id> [--unpin]`.
