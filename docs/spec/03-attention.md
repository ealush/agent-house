# 03 · Attention

Where ah tells you what needs you, and how you get to any session or
conversation. Every list here sorts and labels sessions the same way (FND-8).

## ATT-1 · Sidebar (desktop and iPad) — shipped

A floating glass panel, top to bottom:

1. **ah.** mark, the host chip (this host's name, online dot), collapse button
   (⌃⇧E toggles the sidebar).
2. **Search or jump to** (opens the switcher, ATT-6).
3. **Handoff card** when another device was just using a session (CON-3).
4. **Inbox** with the needs-you count, **Review**, **History** with its count,
   **Search** (⌃⇧5), **Settings**.
5. **Projects +** (New project), then sessions grouped by project; with
   several hosts, by host. On a single host, tmux sessions can group instead.
   Each row: agent mark, status dot (needs you / working only), title, model
   label; ··· with Fork session… and Terminate session; hover ✕ terminates.
   Pinned rows lead their group; rows drag to reorder (SES-13); a row dragged
   onto a pane's edge splits there (WS-3).
6. **New session** (⌃⇧↵), **Worktrees**.

Alt+↑ / Alt+↓ walk sessions in sidebar order; ⌃⇧0 focuses the list; arrows move;
Esc or ⌃⇧9 returns to the session. One gliding highlight marks the current row.

## ATT-2 · Inbox — shipped

The home page. Large title "Inbox." and the status tagline.

- **Group by** Status | Host | Project (segmented, per device). Status is
  the default and the only one on a phone.
- **Needs you**: one card per waiting session: title, agent mark, time; the
  ask's summary (VIEW-6: what it wants, the command as code with its
  description, or the question; "Show terminal text" on request); the
  options as numbered rows (digits work from anywhere on the card); agent,
  model and project tags; **Open**. Answering keeps focus on the card (SES-7).
- **Working**: a table: Session, Detail (what it is doing now), Status ·
  Project, Active (time).
- **Idle and done**: the same table, quieter.
- Empty: "All quiet." and the most recent conversations to resume.
- Rows glide between sections as status changes (P25).


## ATT-3 · Sessions (phone) — shipped

The phone's second tab: every live session grouped by project, each row with
title, what it is doing, and its status pill. **+** starts a session. Empty:
says what to do.

## ATT-4 · History — shipped

"Ended sessions and past conversations. Resuming continues the same
conversation." A filter (title, project, agent; `/` focuses it), then rows:
agent mark, title, "Agent · Model · project" (or "· ended"), time flush right
that swaps to actions on hover. Tap or Enter resumes (SES-9); ··· has Resume,
Fork…, Hide. Rows use content-visibility for long lists.

## ATT-5 · Search — shipped

Full text over transcripts and side chats, on every host (`server/search.ts`,
SQLite FTS, incremental, fingerprinted per source). The page: query, scope
(transcripts and chats / transcripts / chats), speaker (any / you / agent),
from and to dates; results grouped by session, paginated, each opening the
conversation **at the matching turn**. Reached from the switcher's "See all
results", the sidebar, the palette and ⌃⇧5. Can be switched off (drops the
index) in Settings → Search. → A-10: its selects and date fields are unstyled
native controls.

## ATT-6 · Switcher (⌘K / ⌃⇧K) — shipped

"Jump, resume, or search conversations." Live sessions first (status dot,
agent mark, project · detail), then history, then content matches. Filters:
`h:` host or agent, `s:` status, `p:` project, `m:` model, `in:chats`,
`role:`, time ranges. Enter opens or resumes; ⌃↵ opens as a new pane (WS-4);
open-at-message for content hits. Works while a text field or another dialog
is open.

## ATT-7 · Handoff card — shipped

See CON-3. Sidebar top on desktop, Inbox top on a phone: "Continue from
iPhone · 2m", the session's title, dismiss ✕.

## ATT-8 · Phone tab bar — shipped

A floating glass capsule above the home indicator: **Inbox** (needs-you badge),
**Sessions**, **History**, and apart from them a round **Commands** button
(the palette). Slide a finger along it to choose. Settings is reached from the
Inbox's gear and opens as a sheet over the current page.
