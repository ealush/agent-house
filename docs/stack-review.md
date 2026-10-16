# Stack review

Design for reviewing, fixing and merging your own pull requests in ah, one
layer at a time. It reviews the whole stack together but merges one PR at a time.
Status: proposal, 16 October 2026. Nothing here is built yet.

## Why it belongs in ah

This workflow already exists, but you do it by hand. Take the Vest schema-relationships work:

- A plan file (`~/code/schema-relationships-feature-stack-plan.md`) with an
  owner table (H0, F1, F2… → PR, responsibility, base), contracts, budgets and
  a merge order.
- A handoff file that records each PR's head, base, checks, and the bot threads that were fixed or
  left open, rewritten after every review round.
- One agent session in one checkout that switches branches, fixes a layer,
  rebases the four layers above it and force-pushes them with leases.
- Merges you plan to do in order, by hand, someday ("No PR was merged by this
  work").

ah already has most of the pieces: sessions that resume, a durable
queue, BYOK side chat with read-only repo tools, `gh` PR metadata and checks, a
diff view with click-a-line comments, the Inbox, push notifications, full-text search
over side chats, and refs that `git gc` won't collect. Stack review connects
them. The Phase 7 rule "no new features unless something is seriously
missing" is the bar this has to clear. It clears it because it replaces the two
markdown files and the copy-and-paste between GitHub, the side chat and the
agent. It doesn't add a separate product.

**The loop:** read the stack → review the lowest open PR → turn what you
disagree with into findings → send them to the agent that owns the branch →
re-review only what changed → merge → next.

## What the real stack looks like (and what that rules out)

`gh pr list` on Vest today:

```
latest ← #1351 H0 ─┬─ #1353 F1 ← #1354 F2 ← #1355 F3 ← #1358 F5 ← #1359 F6 ← #1360 O10
                   ├─ #1356 O13
                   ├─ #1357 O14
                   └─ #1363 O15
latest ← #1352     (redundant H0, "do not merge both")
F4                 (local branch, no PR, deferred)
```

What this means for the design:

1. **A stack is a tree, not a line.** Independent fixes branch off the base
   layer. The UI and the merge order can't assume "PR n+1 sits on PR n".
2. **The trunk isn't always `main`.** Vest's is `latest`. Read it from the repo's
   default branch, or from the stack root's base.
3. **Merge order is a decision, not the topology.** The plan says H0, then
   O13/O14, then F1…F6, then O10. The topology only constrains it.
4. **Some PRs aren't meant to be merged.** That covers redundant ones, drafts,
   and PRs that are deferred.
5. **Vest merges with merge commits and keeps head branches** (merge commits
   allowed, `deleteBranchOnMerge: false`). GitHub won't retarget the
   children after a merge. Merging F1 while it still targets H0's branch lands
   it in that branch, not in `latest`. This already happened once:
   #1337 merged into `fx/p0-parity-baseline`.
6. **One session usually owns the whole stack**, in one checkout, and it switches
   branches. "The worktree for this PR" often doesn't exist.
7. **Bots review too.** `chatgpt-codex-connector` and CodeRabbit leave
   threads, and the handoff tracks which ones were fixed, replied to or left open.

## Concepts

| Concept | What it is | Stored where |
|---|---|---|
| **Stack** | A trunk, a set of PRs in one repo, their merge order, a plan file (optional), an owner conversation. | `ReviewStack` |
| **Layer** | One PR in the stack: role label (`F2`), position in merge order, state (open, merged, skipped), owner override. | `ReviewLayer` |
| **Revision** | One exact `(baseSha, headSha)` of a layer, its patch id, checks, and cached summary. | `ReviewRevision` + `refs/ah-review/…` |
| **Finding** | A concern with a location, an owning layer, a severity and a state. It comes from you, the reviewer, or a bot thread. | `ReviewFinding` |
| **Dispatch** | Findings sent as one message to a conversation, with the revision they were sent against. | `ReviewDispatch` |
| **Decision** | A short accepted statement about the stack ("planner stays pure; n4s owns execution"). Only you add it. | `ReviewDecision` |
| **Thread** | A reviewer conversation: one per stack and one per layer. | `ChatMessage` under `review:` keys |

A single PR is a stack of one, so nothing in this design is stack-only.

## Reading at a pinned revision

This is the main technical change, and everything else depends on it.

The side chat's tools read the session's **working tree** (`read_file` with
`ref: 'working'`, `git diff HEAD`). For review that's wrong. The agent may be
on another branch, halfway through a fix, or rebasing. The reviewer has to read
the exact revision you're reviewing and never touch a checkout.

- **Fetch, don't check out.** On every refresh, ah runs
  `git fetch origin +refs/pull/<n>/head:refs/ah-review/<stack>/<n>/<headSha>`
  in the main repo (`mainRepo(dir)`). Worktrees share its object store, so
  nothing in any checkout moves. This uses the same idea as
  `refs/ah-snapshots/`: a ref keeps the commits alive through a force-push
  and `git gc`, which `range-diff` needs later.
- **Every read names its revisions.** Diffs come from
  `git diff <baseSha>...<headSha>`, and files come from `git show <sha>:<path>`. The current
  `ToolEnv` (working/HEAD/base thunks) becomes a revision-backed env. The
  session-scoped side chat keeps its own env.
- **Patch identity.** `git patch-id --stable` over the layer's diff gives a
  fingerprint that survives rebases. Same patch id, new SHAs means "rebased,
  nothing to re-review". A different patch id means re-review with
  `git range-diff <oldBase>..<oldHead> <newBase>..<newHead>`. That's Git's own
  answer to "what changed in this PR since I looked", and it handles a rebased
  stack correctly.
- **Old revisions are pruned** when the stack closes, like snapshot refs are.

## The reviewer

It extends `server/sidechat.ts` and doesn't add a second agent runtime.
Subscriptions, the provider call, the JSON reply envelope and the tool loop all
stay. What changes:

- **Tools take a scope.** The loop accepts a tool set and an env instead of
  hard-coding `REPO_TOOLS`. Review tools, all read-only and all pinned:
  - `stack_map`: one line per layer with role, title, state, base, files,
    ±lines, and open findings.
  - `layer_diff(pr, mode, paths?)`: `mode` is `this` (against its parent),
    `cumulative` (against the trunk), `since_review` (range-diff), or `next`
    (how the layer above uses it).
  - `read_file(path, at)`: `at` is a layer's head or base, or the trunk.
  - `plan`: the plan file, by section.
  - `findings(pr?)`, `decisions`
  - `pr_threads(pr)`: review threads from GitHub, bots included.
- **Look-ahead is just a tool call.** "Does F2 hold up given how F3 and F5 use
  it?" means `layer_diff(1355, 'this')` and `layer_diff(1358, 'this')`. It doesn't need a
  mode or a button. A premade follow-up can ask for it.
- **Context is assembled, not dumped.** Each request gets the plan's
  first sections (capped), the accepted decisions, the stack map, this layer's
  cached summary and its open findings. Diffs come through tools when the
  model asks for them, which is how side chat already works. Ten full diffs never go
  into one request.
- **Replies can propose findings.** The envelope gets an optional
  `findings: [{title, body, severity, path, lines, owner}]` next to
  `followups`. They show as cards under the answer with **Keep** / **Dismiss**,
  and nothing becomes a finding until you keep it. `followups` with
  `kind: 'session'` already means "send this to the agent", so one-tap
  send from a message is already built.
- **Threads are records.** Side chat keeps only the last 30 messages and
  rewrites the log on every reply. Review threads keep everything, send the
  model the last N plus a running summary, and are already indexed by
  `chat_fts`, so search finds them.
- **Long work runs in the background.** A layer's summary and a re-review
  can exceed the 90 s chat timeout. They run as jobs, store their result on the
  revision, and the page shows "Summarizing…" until they finish. The summary is
  cached per patch id. Reopening a layer, or opening it on a phone, is instant
  and costs nothing.
- **Models per job.** Settings → Subscriptions gets two defaults: *Review
  summaries* (cheap) and *Review chat* (strong). Each thread's model can still be changed from its
  header.

The reviewer can't merge, push, retarget, resolve threads or send to an agent.
It proposes. You decide by pressing a button.

## Findings

- **Sources:** you (click a diff line, as in the Diff panel today, but
  it files a finding instead of sending a comment), the reviewer (a kept card), or
  a GitHub thread (imported on refresh, `source: bot:<login>` or
  `gh:<login>`).
- **Owner layer:** a finding belongs to the layer that should change. It can be
  found while reviewing F5 and still be owned by F2. If the owner is already
  merged, the finding becomes a follow-up item on the stack (a new PR or the
  next open layer), never a rewrite of merged history.
- **States:** `open → sent → addressed | not addressed`, plus
  `won't fix` and `dismissed`. Every change records who made it and at
  which revision.
- **Severity:** `blocking` / `should` / `nit`. Only blocking findings stop
  Merge & next, and you can waive one with a reason that is recorded.
- **Thread sync:** when a finding imported from GitHub is closed, its card
  offers **Reply & resolve on GitHub** with the text prefilled. It doesn't happen
  automatically. This is the "three Codex bot threads still unresolved"
  step from the handoff.

## Sending to the agent

**Ownership is an explicit binding, never a guess.** The design rules in
`BACKLOG.md` say attachment follows conversation identity, never cwd or
recency. So the first time you send findings from a stack, ah asks which
session owns it, once, and binds the stack to that conversation's key
(`harness:harnessId`). The binding survives resume and re-adoption the way queues and side chats
do. You can override it per layer. Suggestions come from evidence, ranked:

1. a session whose `ah.worktree.branch` is the layer's head branch,
2. a live session whose checkout has the branch checked out,
3. full-text search hits for the branch name or `#<pr>` in transcripts (which
   conversation ran `gh pr create` for it).

**The message.** Selected findings become one plain, short instruction:

```
Review of #1354 F2 (feat/relationships-planner) at c4116a12. Please fix:

1. [blocking] Reuse the existing graph traversal instead of a second one.
   planner.ts:84–126, relationships.ts:41–90. Planning and discovery differ
   only in the visitor; share the walk.
2. [should] Add a cycle regression test. planner.test.ts.

Constraints: stay within F2; the parity golden must stay byte-identical.
Then restack F3 (#1355), F5 (#1358), F6 (#1359), O10 (#1360) on the new F2
in that order and push each with --force-with-lease against the heads above.
Reply with the new heads.
(ah review d-17)
```

The constraints come from the plan and the accepted decisions. The restack line
lists the layer's descendants with their current heads. That's the cascade
the agent ran by hand in the handoff. The message is shown before it's sent, and
you can edit it.

**Delivery:** `core.send(ref, text)`, the same path the composer uses. It goes in now if
the session is idle, is queued if it's busy, and resumes the session first if it has ended. The
dispatch keeps the queue item id, so its state is visible: queued, delivered,
working, done.

**Coming back:** ah watches two signals: the owner's turn ending (hooks or
screen rules) and the layer's head SHA changing (refresh).

| Turn ended | Head changed | Result |
|---|---|---|
| yes | yes | The layer moves to **Re-review**. An Inbox card and a push say "F2 updated: 2 findings to check". |
| yes | no | Inbox card: "Agent finished without pushing F2", with a link to the session. |
| no | yes | Nothing yet. The agent may still be restacking. |

Descendants whose patch id is unchanged keep their review status. Those whose
patch changed are marked for re-review, so a restack never quietly carries an
old approval forward.

## Re-review

When a layer has a reviewed revision and a new one arrives:

- **Default diff mode becomes *Since review*** (range-diff), with
  *This PR* and *Cumulative* still one tap away.
- **A re-review job** sends the reviewer the range-diff and each finding that was sent,
  asks for `addressed / partly / not` with evidence, and asks it to flag
  changes no finding asked for. The result shows as a short list at the top of the layer:

  > Since your review at c4116a12 (+38 −12, 3 files):
  > ✓ Shared traversal: addressed, planner.ts:80–101
  > ✓ Cycle test: addressed, planner.test.ts:212
  > ! Unrequested: `describe()` output order changed, relationships.ts:140

- **You accept the verdicts** with one action, or adjust them one by one.
  Findings only change state when you accept.

## Merge & next

The main button on a layer that's ready (⌘↵, as everywhere else). Before
it's enabled, a checklist shows each condition, with the reason when one fails:

- **Reviewed revision is current.** Head and base SHAs match. If they differ
  but the patch id matches, the item passes and says "rebased since review, same patch".
- **No open blocking findings** (or each one waived with a reason).
- **Checks green** (`prMeta` checks: no fail, no pending).
- **Mergeable** per GitHub, and not a draft. A draft offers *Mark ready*.
- **Base is the trunk.** If the layer still targets a merged parent's branch, a
  *Retarget to latest* step runs first.
- **It's next in merge order**, or you confirm going out of order.

On confirm:

1. `gh pr merge <n> --merge --match-head-commit <reviewedHeadSha>`. The
   `--match-head-commit` check is done server-side by GitHub, so a push
   that lands between your review and the click makes the merge fail
   instead of merging code you didn't see. The merge method is the stack's
   setting (default: the repo's, and *merge commit* for Vest).
2. **Retarget children.** Each direct child that targeted the merged branch
   gets `gh pr edit <child> --base <trunk>`. With merge commits the child's
   diff is unchanged, and ah confirms it by patch id, so its review carries over. With
   squash or rebase merges, the child now repeats its parent's commits.
   ah marks it **Needs restack** and offers a restack dispatch
   (`git rebase --onto <trunk> <oldParentHead> <child>`) to the owner. ah
   doesn't rewrite branches itself. The agent's checkout may have that branch
   checked out with work on it.
3. **Conflicts:** if GitHub then reports a layer as conflicting with the
   trunk, it gets a *Rebase on trunk* dispatch, and the layer is marked for re-review.
4. **Next layer opens** with its summary already prepared. The preparation started when
   you opened the previous layer and is redone if the next layer's patch id changed.

Every step is written to the activity log (`review.merge`, `review.retarget`,
`review.dispatch`), like the other actions there.

**Native GitHub stacks** (public preview since July 2026) behave differently.
Merging a higher layer merges everything below it as one operation, and GitHub
rebases the rest itself. The docs show no stack API yet, and Vest doesn't use
native stacks. ah should detect a native stack, merge only its bottom layer,
let GitHub run the cascade, and then verify patch ids. Don't build more than
that against a preview API.

## Where it shows up

**Desktop.** It's a page in the sidebar, *Review*, listing open stacks per
project. In the palette it's *Go to → Review*. The page has three columns:

```
┌ Stack ───────────┬ #1354 F2 · Dependency planner ─────────┬ Thread ─────────────┐
│ latest           │ This PR · Since review · Cumulative    │ You: why a second   │
│ ✓ H0  #1351      │ ──────────────────────────────────────  │ traversal?          │
│ ✓ O13 #1356      │ planner.ts                       +84    │ Reviewer: …         │
│ ✓ O14 #1357      │  84 ▌ export function plan(…)  ◆ 1      │  ┌ Finding ────────┐│
│ ● F1  #1353      │  …                                      │  │ Shared traversal ││
│ ◉ F2  #1354 ←    │                                         │  │ Keep · Dismiss   ││
│ ○ F3  #1355      │                                         │  └─────────────────┘│
│ ○ F5  #1358      │                                         │                     │
│ – #1352 skipped  │ Findings 2 open · Send 2 to Claude ⏎    │ Ask or request…     │
│ Plan · Decisions │ ✓ Checks ✓ Current ✗ 1 blocking  Merge  │                     │
└──────────────────┴─────────────────────────────────────────┴─────────────────────┘
```

- The stack rail uses the existing status vocabulary: *needs you* (re-review
  or a decision), *working* (the agent is fixing), *ready* (all checks pass), merged and
  skipped. Rows reorder by dragging, like the sidebar, and that sets the merge order.
- Findings show in the diff gutter (◆) and in a tray under the diff. The tray
  is where you select findings and send them.
- The stack's own thread opens from the rail's *Plan · Decisions*. It's the place for
  "does the overall shape hold up" before you start on the first layer.

**Inside a session.** When a session's branch belongs to a stack, the
session header's PR link reads `#1354 · F2 of Vest relationships`. While a dispatch is active, the
session shows a thin bar, "Fixing 2 findings from review", that links back to the layer.

**Inbox.** Stack review adds three kinds of card: *re-review ready*, *agent
finished without pushing*, and *ready to merge*. They're needs-you items, so
they badge the app and notify like everything else.

**Phone.** Reading diffs on a phone is poor, but the decisions are fine there. A
layer opens as a page with tabs (*Summary* · *Findings* · *Diff* · *Thread*)
and Merge & next in a bottom bar. A typical phone session: open the Inbox card, read the
re-review list, accept, merge, go to the next layer. No fifth tab: Review is
reached from the Inbox, from a session, and from History's search.

**Keyboard.** `]` / `[` next/previous file, `n` / `p` next/previous finding,
`f` file a finding on the focused line, `s` send selected, Alt+↓ / Alt+↑
next/previous layer, ⌘↵ the main button (Send, Accept or Merge, whichever
applies). Each one gets a row in the shortcut table and in which-key.

## The plan file is the brief

Codex proposed an AI-built "Stack Brief". You already write a better one. So:

- **The plan is a file, chosen once** per stack (any path under
  `files.roots`; the Vest plans live in `~/code`, outside the repo). It
  stays yours, and ah never edits it. The reviewer reads it through the `plan` tool,
  and its first sections go into every request.
- **Import reads the owner table.** A markdown table with a `#\d+` column
  assigns role labels (H0, F1…) and a first merge order. Rows the plan marks
  "do not merge" or "redundant" stay where they are, and you set *skip* yourself;
  ah doesn't try to interpret that prose.
- **Decisions are the only brief ah maintains.** They're short lines you accept,
  from a thread message (*Pin as decision*) or typed in. The reviewer
  can propose them, never add them. They go into every request and into the
  dispatch constraints.
- **No plan file?** The stack root's PR body serves as the plan.

## Data model

New Prisma models in `ah.db`, next to `Session`, `Snapshot` and `ChatMessage`:

```prisma
model ReviewStack {
  id          String  @id
  repoRoot    String            // main repo, not a worktree
  repo        String            // owner/name
  trunk       String            // "latest"
  title       String
  planPath    String?
  ownerKey    String?           // harness:harnessId conversation key
  mergeMethod String  @default("merge")
  state       String  @default("open")   // open | done | archived
  createdAt   Int
}

model ReviewLayer {
  stackId     String
  pr          Int
  role        String  @default("")   // "F2"
  position    Int                    // merge order
  state       String  @default("open")  // open | merged | closed | skipped
  ownerKey    String?                // per-layer override
  reviewedRev Int?                   // ReviewRevision.id
  @@id([stackId, pr])
}

model ReviewRevision {
  id        Int    @id @default(autoincrement())
  stackId   String
  pr        Int
  baseSha   String
  headSha   String
  patchId   String
  checks    String @default("{}")
  summary   String?              // cached per patchId
  seenAt    Int
  @@unique([stackId, pr, baseSha, headSha])
}

model ReviewFinding {
  id         Int     @id @default(autoincrement())
  stackId    String
  ownerPr    Int
  foundOnPr  Int
  revisionId Int
  path       String?
  lineStart  Int?
  lineEnd    Int?
  title      String
  body       String
  severity   String              // blocking | should | nit
  source     String              // you | reviewer | bot:<login> | gh:<login>
  ghThread   String?
  state      String  @default("open")
  waiver     String?
  dispatchId Int?
  updatedAt  Int
}

model ReviewDispatch {
  id         Int    @id @default(autoincrement())
  stackId    String
  pr         Int
  targetKey  String
  text       String
  fromRev    Int
  queueItem  String?
  state      String @default("queued")  // queued | delivered | done | no-push
  sentAt     Int
}

model ReviewDecision {
  id      Int    @id @default(autoincrement())
  stackId String
  text    String
  fromPr  Int?
  at      Int
}
```

Threads reuse `ChatMessage` with keys `review:<stackId>` and
`review:<stackId>:<pr>`, so `listChats`, History and search pick them up.

**Refresh:** one `gh pr list --state all --json
number,headRefName,baseRefName,headRefOid,state,isDraft,mergeable` per repo
with an open stack. It runs when you open the page, every 60 s while a dispatch is
active, and every 5 min otherwise. A new `headRefOid` triggers fetch, then patch id,
then a revision row. Checks come from `gh pr checks` only for layers that changed.
**Discovery** builds the base→head forest from the same call. Roots are PRs whose base
is the trunk. *Start review* on any PR takes in its descendants.

**Multi-host:** a stack lives on the host that has the repo, and other hosts reach it
through the existing `/h/<host>` proxy.

## What changed from the Codex draft, and why

| Codex | Here | Why |
|---|---|---|
| A stack is 10 sequential PRs | A tree with a merge order you choose | The real Vest stack branches off H0 and has a skipped PR. |
| AI-built Stack Brief, with "inferred vs accepted" | Your plan file + decisions you accept | You already write the plan, and an inferred layer is exactly what drifts. |
| "ah identifies the session responsible" | Explicit binding per stack, with evidence ranked as suggestions | The design rules forbid guessing by cwd or recency. One session owns the whole stack in practice. |
| Re-review via "patch fingerprints" | `patch-id` for identity, `range-diff` for review, pinned refs to keep old revisions | Named tools that exist, and they work across force-pushes. |
| "Verify the actual head" before merge | `gh pr merge --match-head-commit` | GitHub checks it at merge time, so a push in between can't slip through. |
| Merge, then "reconcile downstream" | Retarget children with `gh pr edit --base`; restack is an agent dispatch | With merge commits, retargeting is all it takes. With squash, rebasing belongs to whoever owns the checkout. |
| Two chat scopes plus a "Look ahead" action | Stack thread on the stack page, layer thread on the layer page; look-ahead is a tool | No mode to pick. Where you are decides the scope. |
| "Send to agent" from chat as a new feature | Already exists (`followups` with `kind: 'session'`) | Reuse it. |
| Native GitHub stacks via a stack-aware merge API | Detect, merge the bottom only, verify | The public docs show no such API. Don't build on a preview. |
| — | Bot threads become findings, closed with Reply & resolve | That's half of the current handoff file. |
| — | Inbox cards and pushes for re-review and ready | That's how ah gets your attention. |
| Mermaid in a later phase | Same, as a lazy-loaded `ah-widget` type whose nodes cite file:line | Keeps the boot lean (P19). Uncited diagrams make things up. |
| Stack completion report | Later, generated from findings, decisions and range-diffs | It costs little once the records exist. |

## Phases

Each phase is usable on its own and ships as small commits, like the rest of the backlog.

**R0 — Pinned reading** (no UI). Revision-backed `ToolEnv`, fetch into
`refs/ah-review/`, `patch-id` and `range-diff` helpers in `server/git.ts`, and
the tool loop takes a tool set. *Done when* side-chat tests still pass and
a test repo with a force-pushed PR still answers `layer_diff(mode:
since_review)`.

**R1 — Read and discuss.** Discovery, *Start review*, the Review page
(rail, diff modes, threads), plan import, cached summaries, and the two
subscription defaults. *Done when* the Vest stack shows up as the tree above,
and a question about F2 that needs F3's diff is answered through tools, with nothing changed on
disk.

**R2 — Findings, fix, re-review.** Findings from you, the reviewer and bot threads; the
owner binding; dispatch through the queue; the turn-end and head-change
watcher; Inbox cards; range-diff re-review; Reply & resolve on GitHub.
*Done when* a stand-in agent receives a dispatch, pushes, and the layer moves to
Re-review with verdicts, without anyone opening GitHub.

**R3 — Merge & next.** The checklist, `--match-head-commit` merge,
retargeting children, the needs-restack state, auto-advance, the activity log.
*Done when* on a throwaway GitHub repo, H0 → O13 → F1 merges in order, each
child keeps its review through the retarget, and a push made mid-review blocks
the merge.

**R4 — Breadth.** Native GitHub stacks (bottom-only merge), squash and
rebase repos, phone polish, decisions in dispatch constraints.

**R5 — Pictures and the record.** A `mermaid` widget for before/after flow
with cited nodes, and a completion report when a stack closes.

## Testing

- **Git layer:** unit tests against temporary repos for fetch, pin, patch id
  across a rebase, range-diff after a force-push, and children after a merge. No
  network.
- **`gh`:** a stand-in `gh` on PATH that serves recorded JSON. That's the same
  approach as the stand-in agent CLIs in `test/helpers.ts`. R3's real merge test runs
  against a throwaway GitHub repo, never Vest.
- **Reviewer:** a stub provider that returns scripted tool calls and
  envelopes. Assert that tools only read pinned revisions and that proposed
  findings stay proposals until kept.
- **UI:** the `test:ui` smoke suite gains a stack page on desktop and phone,
  run against a throwaway ah. It never runs against the live server or your tmux.

## Open decisions

1. **Restack by ah or by the agent?** This design says agent, always, in v1.
   ah could run a conflict-free `rebase --onto` itself in a temporary
   worktree. That's faster, but it moves a branch under a checkout that may hold
   unpushed work on it.
2. **A Review tab on the phone?** This design reaches Review through the Inbox and sessions instead.
3. **Who resolves bot threads?** You, through Reply & resolve, or the
   agent as part of its fix (it already did this in the handoff)?
4. **Stack thread scope:** keep it, or fold everything into layer threads plus
   pinned decisions?
