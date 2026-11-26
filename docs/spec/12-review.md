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
*Start from a Space*: one card per Space with open PRs, its chains not yet
in review named. *New stack* opens the picker (REV-2). Reached from the
sidebar (a stack icon), the palette and Ctrl+Shift+4; on a phone from the
Inbox, a session and Search (no tab). → A-33, A-36 (fixed)

## REV-2 · Making a stack — shipped

Three sources: **GitHub's chain** (a PR and every PR based on its head; new
PRs on its branches join), **by hand** (the picker: a project's open PRs with
checkboxes, chains grouped with *Select the chain*, a PR above its base is
refused), and **a stack on GitHub** (*Review this stack*; the review follows
it). A chain that isn't a stack on GitHub can be made one (*Make it a stack on
GitHub*, with a confirm). *Add pull requests* and *Take out of the stack*
change a stack later; nothing on GitHub changes. → A-34 (fixed)

## REV-3 · The stack — shipped

A spine of layers (trunk on top, one status dot each) beside **Up next** (the
one thing to do, ⌘↵ on its button), the merge order as a table (layer, PR,
status, findings, checks), and cards: **Made in** (the session that built the
stack), **Fixes go to**, **Plan** (a plan file, else the first PR's
description) and **Decisions** (pinned statements the reviewer and agent are
held to). The reviewer sits beside it (REV-5).
→ A-31

## REV-4 · A layer — shipped

Header: breadcrumb, previous / next, ···, *Message agent* and the one primary
action (*Mark reviewed*, *Send*, *Accept fixes* or *Merge & next*). A band says
what's new. The diff reads **This PR**, **Since review** or **From
<trunk>**, at a pinned revision. Two cards sit behind toggles on the diff bar, one at a
time: the PR's **description**, read from GitHub when opened and shown as
GitHub shows it (REV-7), and the **briefing** (written by the briefing
subscription: what it does, how it fits, what to look at, tests). The merge gates are a row of marks under the diff. The layer's
findings sit above the diff and fold to one line; each has *Discuss*. On a
phone: Overview and Diff tabs and a glass bar with a Reviewer button. Overview
opens on what the layer changes (files, +/−, its branches) and its Description
and Briefing cards, then its findings and gates.

## REV-5 · The reviewer — shipped

A panel on the right of the overview and of every layer, full height, which
stays put (and keeps your draft) as you move; it folds to a rail, and where
the page is under 900px wide it floats over the right edge when you open it.
The composer shows the layer you're on as a chip (take it off to ask about the
whole stack) and anything you brought with *Discuss* on a finding. On a phone
it's a sheet over the overview or the layer (the Reviewer button in the
layer's bar, or *Discuss*): half the screen, so what you're asking about stays
in view above it, pulled up to full height, dragged down to put away, and above
the keyboard while you type. The layer's tabs are Overview and Diff. In the diff, a
clicked line (Shift+click for a range, removed lines too) offers *Ask the
reviewer* beside *Add finding*, taking the lines as the diff shows them and
what you wrote; each file's header has *Discuss* for the file's whole change. By
touch, a tap picks a line and a second tap stretches the range to it; a bar
above the tab bar says which lines and offers *Ask reviewer* and *Add finding*.
One conversation per stack, which follows you between layers: each question
records the layer it was asked on (or the whole stack) and what you attached
to it (findings, lines of a diff, a file), and the reviewer gets those spelled
out (a file as the layer changes it). The threads layers used to have read as
part of it. It reads exact revisions, the plan, the decisions and the session
that made the stack, and can propose findings (kept or dismissed by you). Starters on an empty thread; follow-ups under a reply
(ask more, or send to the agent). The subscription it uses is picked in the
thread's chip and kept for the stack (SET-6). → A-35 (fixed)

## REV-6 · Findings — shipped

From you (a diff line or the add box), the reviewer, or a GitHub thread.
Owner layer, severity (blocking / should / nit), state (open, sent, fixed,
not fixed, won't fix, dismissed) with who changed it and at which revision.
Only blocking findings stop the merge; waiving one needs a reason. A finding
open when its layer merges follows to the next open layer.

## REV-7 · GitHub's words — shipped

*Bring in GitHub threads* imports a layer's review threads once each (bots
included; resolved ones arrive fixed). The comment's own bold heading is the
title (else its first sentence), a P0–P3 badge the severity; the rest stays
GitHub's markdown, each reply its own comment under who wrote it and when, with
a link to the thread. A closed finding offers *Reply & resolve on GitHub*.

Everything from GitHub (these comments, a layer's description, the plan when
it is the first PR's description) is shown as GitHub shows it: GFM and
GitHub's safe HTML (`<details>`, `<sub>`, tables, task lists), a
` ```suggestion ` block as the change it suggests. Images on GitHub (a
repo's files, uploads) come through ah, read with the host's `gh` login,
because the page only loads images from ah; any other image is its alt text
as a link. → A-30, A-31, A-32 (fixed)

## REV-8 · Sending to the agent — shipped

*Message agent* drafts one message from the selected findings, decisions and
the layers above, to the session that made the stack (listed first, resumed
if ended), another session, or a new agent session in a worktree at the
layer's head. Fixes always go through an agent session, never a subscription.
The message uses `gh stack` when the host has it.

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

**Merge the stack** (the merge order's button, the stack's and a layer's ···,
and Up next once every layer is reviewed) merges bottom up in as few steps as
GitHub allows: a run of layers in one GitHub stack through one stack merge,
any other layer through its own, each at its reviewed head and re-checked
just before. Its dialog lists every layer as landing, held (by what), waiting
behind a held one, or needing a restack, and picks the method (merge commits,
squash, rebase: the stack keeps it). Layers you haven't marked reviewed are
marked at their current heads as it merges (*Mark reviewed & merge*); a
blocking finding, a failing check or a conflict still holds the layer, and
the merge lands what's below it. Squash or rebase on a chain lands one step:
what sat on it then needs a restack, which ah leaves to the agent. It stops at
the first step GitHub refuses or hasn't finished, and says where. On a phone the
dialog is a sheet: each layer's title over its note, a full-width method
switch, and the actions one above the other.
*Ask the agent…* in the same dialog drafts a message instead (REV-8): the
layers up to the first one a gate holds, each at its reviewed head, how each
lands (gh stack merge for a run of a GitHub stack, else the stack merge API;
gh pr merge for the rest, with the retarget and, after a squash or rebase,
the restack before each), and to stop before a held layer. Its own method
switch redrafts the message, unless you have edited it. That merge is done
when the last layer it covers has merged; the layer reads *Agent merging*
meanwhile, and the Inbox says so if the agent finished without merging.

## REV-11 · Where Review shows up — shipped

A session whose branch is a layer has an "F2 in review" pill in its header.
A session in a git checkout has a **Stack** tab in its side panel, beside
Diff (the palette's *Stack*, ⌃⌥7): the stack it is building (gh stack's, else the PR chain, else the last
seen), each branch with its PR, and *Review this stack* / *Open in Review*. A branch with no pull request yet offers *Create pull request*; that opens it on GitHub (based on the branch under it, else the trunk) and the review of it here. On
a phone the Stack tab shows while the branch is in review, else from the
session menu. The Inbox has three Review cards (re-review ready, finished
without pushing, ready to merge), which badge and notify. → A-37 (fixed)
