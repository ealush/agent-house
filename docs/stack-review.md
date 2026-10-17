# Stack review

Reviewing, fixing and merging your own pull requests in ah, one layer at a
time. It reviews the whole stack together but merges one PR at a time.
Status: R0–R3 built on 16 October 2026 (`server/review/`, `web/review/`),
taken off `main` for a redesign, and landed again on 17 October.
Hand-picked stacks and the redesign (below) were added on 17 October, then
built to the canvas, with the spec's waivers, finding history and follow-ups.
R4–R5 open. Where the build differs from the first proposal, this document
says what was built. Backlog: "Stack review" in `BACKLOG.md`. The screens were
designed on a Claude Design canvas first: https://claude.ai/artifact/Ff8Aqv3XSLzTiGQ1e2dUca

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

## Two ways to make a stack

**From GitHub's chain.** Pick the bottom PR and the stack is it plus every PR
whose base branch is another's head (`source: "tree"`). New PRs opened on a
layer's branch join by themselves.

**By hand, like a stack of diffs.** *New stack* opens a project's open PRs with
checkboxes (`source: "manual"`). You tick the PRs, put them in review-and-merge
order and start. This is the Meta-style stack without the tooling: at Meta a
stack is commits in one branch, each one a diff (Phabricator, then Sapling's
`sl`), reviewed on its own and landed bottom-up. Here a stack is PRs you group
yourself, and they needn't sit on each other's branches. A docs PR, a fix and
a feature can be reviewed and merged as one ordered stack.

- PRs built on each other's branches are grouped in the picker as a chain, and
  *Select the chain* takes all of them. A PR ticked after its base goes right
  under it.
- A PR placed above the PR its branch is built on is flagged, and Start stays
  off until it moves (or *Order by bases* fixes it). The server checks the same
  rule. A PR built on one that isn't in the stack is only noted.
- A picked stack never takes PRs in by itself. *Add pull requests* (the stack's
  ··· menu, or under the merge order) opens the same picker and appends.
- *Take out of the stack* removes a PR and its findings, nothing on GitHub. A
  GitHub-chain stack you trim becomes a picked one, so the PR doesn't rejoin.
- Merging is the same either way: one layer at a time, only at the reviewed
  head. PRs on a merged layer's branch are retargeted to the trunk. Independent
  PRs need no retarget; GitHub's mergeability shows when an earlier merge
  conflicts with a later one.

*Supporting the real thing.* Sapling and ghstack aren't installed here. Each
already pushes one PR per commit with stacked branches, which is the GitHub
chain above. The part ah could add is what Sapling writes into each PR's
description: the list of the stack with the current one marked, so the stack
is visible on GitHub too. That edits PR bodies, so it would be an explicit
action, not a side effect. It's in the backlog.

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
  model the last 24 messages (the stack's context, plan and decisions carry the
  rest), and are already indexed by `chat_fts`, so search finds them.
- **Long work runs in the background.** A layer's summary and a re-review
  can exceed the 90 s chat timeout. They run as jobs, store their result on the
  revision, and the page shows "Summarizing…" until they finish. The summary is
  cached per patch id. Reopening a layer, or opening it on a phone, is instant
  and costs nothing.
- **Models per job.** Settings → Subscriptions picks the subscription for
  briefings and re-checks (a cheap one will do). The reviewer chat uses the
  default, and each thread can switch to another from its composer.

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
  `won't fix` and `dismissed`. Every change records who made it (you, the
  reviewer, GitHub) and at which revision (`stateBy`, `stateRevId`); a card
  shows it when opened ("Fixed by the reviewer at f9b99cc, 4m ago").
- **Follow-ups:** a finding still open when its layer merges shows on the next
  open layer as a follow-up, selectable there. Sending it moves it to that
  layer, and the message says it was found on the merged one.
- **Severity:** `blocking` / `should` / `nit`. Only blocking findings stop
  Merge & next. *Waive…* on a blocking one asks why; the server refuses a
  waiver without a reason, and the reason stays on the finding.
- **Thread sync:** when a finding imported from GitHub is closed, its card
  offers **Reply & resolve on GitHub** with the text prefilled. It doesn't happen
  automatically. This is the "three Codex bot threads still unresolved"
  step from the handoff.

## Sending to the agent

**Ownership is an explicit binding, never a guess.** The design rules in
`BACKLOG.md` say attachment follows conversation identity, never cwd or
recency. A stack is bound to a conversation's key (`harness:harnessId`), and
the binding survives resume and re-adoption the way queues and side chats do.
It's set in one of three ways:

1. when the stack is created and exactly one agent session has one of its
   branches checked out (that is evidence, not a guess),
2. by the first send, from the send dialog's session list,
3. by Change on the overview's owner card.

The session list ranks agents on one of the stack's branches first, then
agents in the same repo. A layer can have its own owner (the server supports
it). Transcript search as a third source of evidence is left for later.

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

- **You accept the verdicts** with one action (Accept fixes): addressed
  findings close and the rest go back to open. Findings only change state when
  you accept, and any of them can be reopened after.

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

### GitHub's own stacks

GitHub's stacked pull requests (generally available since 6 October 2026,
made with `gh stack` or the PR page) are a line of PRs that GitHub knows
about: it merges them bottom-up, retargets and rebases what's left after a
merge, and refuses `gh pr merge` on them. ah reads them from the Stacks API
(`GET /repos/{repo}/stacks`, reference: https://github.github.com/gh-stack/)
on every sync and records each layer's stack number and place
(`ghStack`, `ghPos`). A repo with stacks off answers 404, and nothing changes.

- **Merging goes through GitHub's stack merge** (`PUT
  /pulls/<n>/merge-async` with `sha` = the reviewed head, then polling). It
  merges the layer and every unmerged layer of its stack under it, all or
  none. ah doesn't retarget or restack the rest; GitHub does. Layers outside
  the GitHub stack that sat on what landed are retargeted as before.
- **One more gate: the layers under it can merge.** It appears on a layer with
  unmerged layers under it in GitHub's stack, and holds when each of them
  passes its own gates. A PR of the stack that isn't in this review fails it,
  so nothing lands unreviewed. *Merge out of order* on such a layer becomes
  *Merge with F1, F2*. GitHub only checks the head of the PR asked for; the
  ones under it are checked by ah's sync just before.
- **The base gate becomes "Lands in main"**: a stacked PR targets the branch
  under it, but lands in the stack's base.
- **Needs a restack** means something else here: the branch no longer sits on
  top of the one under it (a lower layer was pushed and the rest weren't
  restacked), and GitHub won't merge the stack until it does. ah doesn't
  report it for three minutes after a merge, while GitHub rebases.
- **Merging and queued.** GitHub's merge runs in the background. ah waits 90
  seconds, then the watcher takes over and pushes if it fails. Through a merge
  queue the layer shows *In the merge queue* until GitHub merges it or the
  queue lets go of it.
- **Messages to the agent use `gh stack`** when this host has it: commit on
  the layer, then `gh stack rebase --upstack` and `gh stack push` (after
  `gh stack checkout <pr>` if that checkout doesn't track the stack). Without
  it, the old by-hand restack list.

## Where it shows up

*As built after the redesign (17 October).* The list shows stacks in review,
each as a card with a bar of one segment per layer and what needs you, then
*Start from a project*: one card per project with its open PRs counted and its
chains not yet in review named. *New stack* opens the picker. A stack opens on
its overview: a spine of layers down the left, trunk on top, one status dot each,
and beside it **Up next** (the one thing to do, with ⌘↵ on its button), the
merge order as a table, and cards for who gets the fixes, the plan and the
decisions. *Ask the reviewer* opens the stack's reviewer in a drawer instead of a
fixed third column. A layer folds the spine into a column of labels so the
diff gets the room. Its header carries the breadcrumb, previous and next, and
the one primary action. A band says what's new (a fix came back, with the
reviewer's verdict per finding as chips). The briefing sits behind a toggle on
the diff bar, and the merge gates are a row of marks under the diff. On a phone
the stack is the spine under Up next. A layer has Findings, Diff and Reviewer tabs
and a glass bar: previous, the action, ···, next.

The first proposal's layout, kept for the record:

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

**Inside a session.** When a session's branch is a layer, its header shows
an "F2 in review" pill next to the PR link. While findings are with it, the
pill reads "Fixing 2 findings · F2". Either one opens the layer.

**Inbox.** Stack review adds three kinds of card: *re-review ready*, *agent
finished without pushing*, and *ready to merge*. They're needs-you items, so
they badge the app and notify like everything else.

**Phone.** Reading diffs on a phone is poor, but the decisions are fine there. A
layer opens as a page with tabs (*Summary* · *Findings* · *Diff* · *Thread*)
and Merge & next in a bottom bar. A typical phone session: open the Inbox card, read the
re-review list, accept, merge, go to the next layer. No fifth tab: Review is
reached from the Inbox, from a session, and from History's search.

**Keyboard.** Ctrl+Shift+4 opens Review. `j` / `k` walk the layers, and
lists and diff lines move with the arrows. Enter on a diff line files a
finding there, and ⌘↵ in its box adds it. ⌘↵ presses the main button: Send,
Accept fixes, Mark reviewed or Merge & next, whichever applies. Keys for
moving between files and findings are left for later.

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

Six Prisma models in `ah.db` (`prisma/schema.prisma`, migration
`20261016120000_stack_review`): `ReviewStack` (repo, trunk, plan path, owner
key, merge method), `ReviewLayer` (role, position, GitHub state, the current
and reviewed revisions, `approved`, `needs`: retarget, restack or conflict),
`ReviewRevision` (base, head, patch id, size, cached briefing, re-check
verdict), `ReviewFinding`, `ReviewDispatch` and `ReviewDecision`.

Threads reuse `ChatMessage` with keys `review:<stackId>` and
`review:<stackId>:<pr>`, so `listChats`, History and search pick them up.

**Refresh:** one `gh pr list --state all` per stack, with the check rollup
in the same call. It runs when you open a stale stack, every 60 s while a
dispatch is active, and every 5 min otherwise. Creating a stack returns at
once and its first sync fills the layers in (Vest's ten layers took ~25 s
the first time). A new `headRefOid` triggers fetch, then patch id,
then a revision row. Checks come from `gh pr checks` only for layers that changed.
**Discovery** builds the base→head forest from the same call. Roots are PRs whose base
is the trunk. *Start review* on any PR takes in its descendants.

**Multi-host:** a stack lives on the host that has the repo. The page shows the
host you opened; a peer's stacks through `/h/<host>` are R4.

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
| Native GitHub stacks via a stack-aware merge API | GitHub's stack merge, with a gate for the layers under it | The Stacks and async merge APIs went GA on 6 October. GitHub owns the line; ah owns the review. |
| — | Bot threads become findings, closed with Reply & resolve | That's half of the current handoff file. |
| — | Inbox cards and pushes for re-review and ready | That's how ah gets your attention. |
| Mermaid in a later phase | Same, as a lazy-loaded `ah-widget` type whose nodes cite file:line | Keeps the boot lean (P19). Uncited diagrams make things up. |
| Stack completion report | Later, generated from findings, decisions and range-diffs | It costs little once the records exist. |

## Phases

Each phase is usable on its own and ships as small commits, like the rest of the backlog.

**R0 — Pinned reading** (no UI). ✅ Revision-backed `ToolEnv`, fetch into
`refs/ah-review/`, `patch-id` and `range-diff` helpers in `server/git.ts`, and
the tool loop takes a tool set. *Done when* side-chat tests still pass and
a test repo with a force-pushed PR still answers `layer_diff(mode:
since_review)`.

**R1 — Read and discuss.** ✅ Discovery, *Start review*, the Review page
(rail, diff modes, threads), plan import, cached summaries, and the two
subscription defaults. *Done when* the Vest stack shows up as the tree above,
and a question about F2 that needs F3's diff is answered through tools, with nothing changed on
disk.

**R2 — Findings, fix, re-review.** ✅ Findings from you, the reviewer and bot threads; the
owner binding; dispatch through the queue; the turn-end and head-change
watcher; Inbox cards; range-diff re-review; Reply & resolve on GitHub.
*Done when* a stand-in agent receives a dispatch, pushes, and the layer moves to
Re-review with verdicts, without anyone opening GitHub.

**R3 — Merge & next.** ✅ (tested against a stand-in GitHub; the real-repo run was read-only) The checklist, `--match-head-commit` merge,
retargeting children, the needs-restack state, auto-advance, the activity log.
*Done when* on a throwaway GitHub repo, H0 → O13 → F1 merges in order, each
child keeps its review through the retarget, and a push made mid-review blocks
the merge.

**R4 — Breadth.** GitHub's own stacks: merged through GitHub's stack merge
with the layers under it, restacked with `gh stack` ✅ (17 October). Squash and
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

## Decisions

1. **ah never rewrites branches.** Restacks and rebases are dispatches to the
   agent that owns the checkout, and ah verifies the result by patch id. A
   conflict-free `rebase --onto` in a scratch worktree would be faster, but it
   would move a branch under a checkout that may have work on it.
2. **No Review tab on the phone.** Review is one tap from its Inbox cards, a
   session's "in review" pill, and the palette. A fifth tab would crowd the
   capsule for something you visit when it needs you.
3. **You resolve bot threads.** A finding from GitHub shows Resolve on GitHub,
   which posts your note (if any) as the reply and resolves the thread. The
   agent is never asked to touch the PR conversation.
4. **Both thread scopes stay.** The stack's thread is on its overview and a
   layer's thread is on the layer, so where you are decides the scope. Pinned
   decisions carry what one thread settles into every other one.
5. **A cheaper model for the background work.** Settings → Subscriptions picks
   the subscription that writes briefings and re-checks; the reviewer chat uses
   the default (or the one picked in the thread).
6. **A picked stack keeps its shape.** Only you add PRs to it; trimming a
   GitHub-chain stack turns it into a picked one. The alternative, a picked
   stack that also takes in children of its layers, makes the list change
   under you.
7. **Up next opens; it doesn't act.** The overview's button goes to the layer
   where the action is (Re-review, Open, Review). Merging and sending stay on
   the layer, next to the diff and the gates they depend on.
