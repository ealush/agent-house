# 12 · Review

Reviewing, fixing and merging your own pull requests, one layer at a time.
Written back from `main` at fefea5f (18 October 2026). The design, its
reasons and the data model are in [docs/stack-review.md](../stack-review.md);
this file is the list of what Review does, with IDs, so changes and findings
can point at it.

Words: a **stack** is PRs in review-and-merge order on one trunk; a **layer**
is one PR in it, labelled by role (`H0`, `F2`); a **finding** is a concern
owned by the layer that should change; the **reviewer** is the model that
reads the stack with you (a chat subscription, never an agent session).

## REV-1 · The Review page — shipped

Large title "Review." with a tagline ("1 stack in review · 1 needs you").
*In review*: one card per stack with a segment per layer and what needs you.
*Start from a project*: one card per project with open PRs, its chains not yet
in review named. *New stack* opens the picker (REV-2). Reached from the
sidebar, the palette and Ctrl+Shift+4; on a phone from the Inbox, a session
and Search (no tab). → A-33, A-36

## REV-2 · Making a stack — shipped

Three sources: **GitHub's chain** (a PR and every PR based on its head; new
PRs on its branches join), **by hand** (the picker: a project's open PRs with
checkboxes, chains grouped with *Select the chain*, a PR above its base is
refused), and **a stack on GitHub** (*Review this stack*; the review follows
it). A chain that isn't a stack on GitHub can be made one (*Make it a stack on
GitHub*, with a confirm). *Add pull requests* and *Take out of the stack*
change a stack later; nothing on GitHub changes. → A-34

## REV-3 · The stack — shipped

A spine of layers (trunk on top, one status dot each) beside **Up next** (the
one thing to do, ⌘↵ on its button), the merge order as a table (layer, PR,
status, findings, checks), and cards: **Made in** (the session that built the
stack), **Fixes go to**, **Plan** (a plan file, else the first PR's
description) and **Decisions** (pinned statements the reviewer and agent are
held to). *Ask the reviewer* opens the stack's thread in a drawer.
→ A-31

## REV-4 · A layer — shipped

Header: breadcrumb, previous / next, ···, *Message agent* and the one primary
action (*Mark reviewed*, *Send*, *Accept fixes* or *Merge & next*). A band says
what's new. The diff reads **This PR**, **Since review** or **From
<trunk>**, at a pinned revision. The **briefing** (written by the briefing
subscription: what it does, how it fits, what to look at, tests) sits behind
a toggle. The merge gates are a row of marks under the diff. A side column
holds Findings and the Reviewer. On a phone: Findings, Diff and Reviewer tabs
and a glass bar. → A-31

## REV-5 · The reviewer — shipped

One thread per stack and per layer. It reads exact revisions, the plan, the
decisions and the session that made the stack, and can propose findings (kept
or dismissed by you). Starters on an empty thread; follow-ups under a reply
(ask more, or send to the agent). The subscription it uses is picked in the
thread's chip and kept per thread (SET-6). → A-35

## REV-6 · Findings — shipped

From you (a diff line or the add box), the reviewer, or a GitHub thread.
Owner layer, severity (blocking / should / nit), state (open, sent, fixed,
not fixed, won't fix, dismissed) with who changed it and at which revision.
Only blocking findings stop the merge; waiving one needs a reason. A finding
open when its layer merges follows to the next open layer.

## REV-7 · GitHub's review threads — partial

*Bring in GitHub threads* imports a layer's review threads once each (bots
included; resolved ones arrive fixed). The first comment gives the title and
severity (a P0–P3 badge), the rest is the body, replies under it, with a link
to the thread. A closed finding offers *Reply & resolve on GitHub*.
Gap: the body is shown as plain text, with GitHub's HTML and images removed.
→ A-30, A-32

## REV-8 · Sending to the agent — shipped

*Message agent* drafts one message from the selected findings, decisions and
the layers above, to the session that made the stack (listed first, resumed
if ended), another session, or a new agent session in a worktree at the
layer's head. Fixes always go through an agent session, never a subscription.
The message uses `gh stack` when the host has it. → A-35

## REV-9 · Re-review — shipped

A push after a send brings the layer back with the reviewer's verdict per
finding (fixed, partly, not) and anything it changed that wasn't asked for;
*Accept fixes* settles them.

## REV-10 · Merge & next, and GitHub's own stacks — shipped

A layer merges only at its reviewed head, through GitHub. In a stack on GitHub
the merge goes through GitHub's stack merge (with the layers under it, all or
none), a gate checks those layers too, the base gate reads *Lands in
<trunk>*, and *Needs a restack* means the branch no longer sits on the one
under it. A merge dialog says what lands and how.

## REV-11 · Where Review shows up — shipped

A session whose branch is a layer has an "F2 in review" pill in its header.
A session in a git checkout has a **Stack** tab in its side panel, beside
Diff: the stack it is building (gh stack's, else the PR chain, else the last
seen), each branch with its PR, and *Review this stack* / *Open in Review*. On
a phone the Stack tab shows while the branch is in review, else from the
session menu. The Inbox has three Review cards (re-review ready, finished
without pushing, ready to merge), which badge and notify. → A-36, A-37
