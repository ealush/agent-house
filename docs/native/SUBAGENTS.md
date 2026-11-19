# Subagents

When a session's agent spawns agents of its own, each child is a session the app shows
under its parent: counted on the chip above the box, listed as a tree, opened in the same
session screen as any session, read-only, with its way back up. Asked for by the owner on
20 November 2026 ("subagents should feel like sessions, not like debug logs attached to
sessions"). Host contract: `../ah/docs/spec/16-subagents.md` (`features.subagents` 1).

## Where it comes from

The host is the authority: it reads what Claude Code and Codex write about their children
(Claude's `subagents/agent-<id>.jsonl` and sidecar, Codex's spawned rollouts), keeps
nothing of its own, and gives each child a ref (`claude:<session>:<agent>`,
`codex:<thread>`). The app never reads a harness's files or parses its output.

| What | Wire | App |
|---|---|---|
| Counts on a session's row, every pass | `windows[].subagents` `{total, active, completed, failed, rev}` | `SessionDTO.subagents`, `SessionModel.subagentSummary` |
| The tree | `GET /api/sessions/:ref/subagents` | `APIClient.subagents`, `SubagentsModel` |
| A child's conversation | its ref's `feed`, `feed/stream`, `feed/prompts` | the usual `FeedStream`, by the child's ref |

## Identity

A child's key is `sub:<ref>` on the hub and `sub:<host>/<ref>` on a peer (`SubagentKey`).
Like a note's key it never parses as a `SessionKey`, so nothing takes a child for a live
window; routes, panes, the scene journal and restoration carry it as any key. The same
child is the same key on every launch and every device: the host's ref is a function of
the harness's own ids.

## Keeping current without polling

The tree is asked for when someone looks: the browser opening, a child's screen, an ended
session's screen (to know if it had any), a Delegate card tapped. After that only when the
row's `rev` changes (the host's pass saw something), coalesced to one ask per burst
(`SubagentsModel.rowChanged`); a change that arrives while an ask is out gets one more. A
child's screen follows its root's row the same way. A child's transcript is its own feed
stream, live while it works. Nothing polls, and closing a session stops its asks.

## The experience

- **Chip.** "Subagents" in the row of chips over the box, built with the same
  `SettingChipLabel` as Model, Effort and Mode. It says "Subagents 3 active" while any work
  (a still dot in the working color: nothing pulses), "4 done", "2 done · 1 failed",
  "1 done · 2 stopped" (stopped: neither finished nor running as far as the host knows, never
  called done), or "Subagents" with none yet. Counts cover every level below the session.
  While the settings are folded the chip stands on its own over the box (a chip-sized host
  above the dock, `SubagentsChipFloat`, so the transcript keeps its touches), and only for a
  session that has any; opened, it's the first of the chips. Its count changes in place:
  nothing moves, the dock's height doesn't change, the transcript isn't laid out again.
- **Browser.** A sheet on a phone (half height, grabber), a popover pointing at the chip on
  an iPad. The tree, parents first, siblings as spawned, folding by parent; each row its
  state (glyph and word in its color), name, kind of agent, what it's doing or did last,
  how long it ran, and how many are nested and active. Empty, loading, failed (Try Again),
  unsupported, and offline ("as last known", running ones drawn muted) states.
- **A child.** Opens where sessions open: pushed over its parent on a phone (so Back goes up
  to it, the parent's scroll and transcript as they were), the focused pane on an iPad, or
  beside the parent (Open Beside This One). Its transcript is the same renderer, its first
  message the instructions its parent gave it, a working row while it runs. Where the box
  would be, a bar says how it is and that it's read-only ("its parent agent runs it"), with
  Back to the parent, its own Subagents chip when it has children, and Continue as Own
  Session for a finished Codex thread whose tree has stopped. The header (iPad) and bar
  subtitle (phone) say "Subagent of …"; the session menu has Open Parent and Subagents.
- **From the parent's transcript.** A Delegate card (the Agent/Task call) has Open Subagent:
  its child, by the call that spawned it.

## What it can't do, and why

Neither harness lets a supervisor of its terminal UI reach one child of a running agent
(ah's docs/spec/16-subagents.md, SUB-4): there's no box on a child, and no Stop. To steer a
child, message its parent. Stopping the parent stops its turn and its foreground children.
A Codex thread can go on as a session of its own (`codex resume`) once its tree has stopped;
that's the one action a child has.

## Layout

Nothing about the box changes: the chip host stands on the dock's top edge with
constraints to the box's text edge (centred at the readable width on a wide screen), sized
by its content (`sizingOptions = .intrinsicContentSize`), no keyboard arithmetic of its own;
it rides the dock as the keyboard moves it. A child's dock holds its bar instead of the
composer and is measured and placed the same way (`ComposerDock`).
