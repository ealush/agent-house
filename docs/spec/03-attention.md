# 03 · Attention

Where ah tells you what needs you, and how you get to any session or
conversation. Every list here sorts and labels sessions the same way (FND-8).

## ATT-1 · Sidebar (desktop and iPad) — shipped

A floating glass panel, top to bottom:

1. **ah.** mark, the host chip (this host's name, online dot), collapse button
   (⌃⇧E toggles the sidebar).
2. **Search or jump to** (opens the switcher, ATT-6).
3. **Handoff card** when another device was just using a session (CON-3).
4. **Inbox** with the needs-you count (its search field holds Search and
   History, ATT-5), **Review**, **Settings**.
5. **Projects +** (New project), then sessions grouped by project; with
   several hosts, by host. On a single host, tmux sessions can group instead.
   Each row: agent mark, status dot (needs you / working only), title (the
   model and folder are in its tooltip); ··· with the session menu's own rows
   (Open, Rename session, Pin, Send to…, Fork session…, Terminate session);
   hover ✕ terminates.
   Pinned rows lead their group; rows drag to reorder (SES-13); a row dragged
   onto a pane's edge splits there (WS-3).
6. **New session** (⌃⇧↵), **Worktrees**.

Alt+↑ / Alt+↓ walk sessions in sidebar order; ⌃⇧0 focuses the list; arrows move;
Esc or ⌃⇧9 returns to the session. One gliding highlight marks the current row.

## ATT-0 · A session in a list — shipped

Every list (the switcher, the pane chooser, the Inbox rows, History) gives a session the same line under its title
(`web/sessionLine.tsx`), chosen by state: what it needs from you ("Wants to
run `pnpm test`", or its question); else what it is doing now (a command as
code, else the words on its screen); else its agent and model. Ended and
saved conversations: agent · model · "ended". The project leads only where the
list isn't grouped by project, the host only with several hosts. Words are in
the UI face at 13px; commands are code.

## ATT-2 · Inbox — shipped

The home page. Large title "Inbox." and the status tagline, then the
**search field** (ATT-5), on a phone and a desktop.

- **Space** (was Project, [17](17-spaces.md)): a small chevron after the title (one button with it) opens a
  menu, an action sheet on a phone: **All Spaces**, then every Space with
  a live session or a past conversation, and every plain Space (empty ones too), by name; a Space is a name on a
  host ("name — host" with several hosts); then **Space settings…** (with one
  shown) and **New Space…** (SPC-6). The choice is checked, kept per
  device, and falls back to All Spaces when its Space is gone or removed. With one
  chosen, every list on the page is that project's: the cards of sessions
  that need you (review and job cards stay), the sections, the Project/Host
  blocks, and the search's Sessions, History and content hits. The title
  is its name in place of "Inbox" ("orbit-api." and the chevron, in the
  accent; a long name ends in an ellipsis), the tagline its counts ("On
  mac ·" first with several hosts), and an empty Inbox says "Nothing
  running in orbit-api.". New session, from the header or the empty state,
  starts in it: the folder of one of its live sessions, else of its newest
  conversation, on its host (the global ⌃⇧↵ stays as it was). All Spaces
  brings "Inbox." back. The tab badge and the sidebar's count stay the
  whole Inbox's.
  Arrows, Enter and Escape work the menu, as the app's other menus.

- **Group by** Status | Host | Project (segmented, per device; Host only
  with several hosts). Status is the default. On a phone the control has a
  row of its own under the title. **Needs you** leads in every grouping. By
  project or host the rest of the page is the sidebar's blocks in the
  sidebar's order (pinned first, then as arranged), one row per session,
  leaving out the sessions already on top as cards; a block that would be
  empty is not drawn. ah-native's Inbox does the same.
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
- **Searching**: from the field's first focus, or while it holds text, the
  page below it is Search's (ATT-5) and the grouping and Needs you step
  aside. **Cancel** beside the field, Escape on an empty field, or letting go
  of an empty field (not to press a result) puts the Inbox back. A session
  opened from the results comes back to the same search, as iOS's does.


## ATT-3 · Sessions (phone) — merged into the Inbox

The phone's Sessions tab was a second list of the same sessions. It is the
Inbox grouped by project now (ATT-2): the same blocks and order, each row
with title, what it is doing, and its status pill, under the Needs you cards
(whose sessions the blocks leave out). `#sessions` opens the Inbox.

## ATT-4 · History — shipped, in the Inbox's search

Ended sessions and past conversations are the **History** section of the
Inbox's search (ATT-5), not a page of their own; `#history` opens the Inbox
searching. Rows: agent mark,
title, "Agent · Model · project" (or "· ended"), time flush right that swaps
to actions on hover (Resume or Restore, Fork, Move, Hide). Tap or Enter
resumes (SES-9); on a touch screen ··· has Resume, Fork…, Move…, Hide (an
action sheet on a phone), a held finger the same menu, a swipe Fork and
Hide. Rows use content-visibility for long lists.

## ATT-5 · Search — shipped, in the Inbox

Search is the Inbox's field, not a page of its own: `#search` and `#history`
open the Inbox searching. Searching, before anything is typed, the page is
every session and conversation to scroll through:
**Sessions** (live, newest activity first, the Inbox's rows with their
swipes and held-finger menu) and **History** (ATT-4). Typing filters both
at once, in the page: every word must be in the row's title, project, agent,
model, host or folder. With nothing to list: one empty state; with nothing
found anywhere: "No matches". `/` focuses the field; ↓ or Enter from it
reaches the first row; Escape clears it, then leaves search. A link to
Search puts the keyboard in the field on a desktop only: a phone or iPad
comes to look through the list.

From two letters on, **In conversations** follows: full text over
transcripts and side chats, on every host (`server/search.ts`, SQLite FTS,
incremental, fingerprinted per source), results grouped by session,
paginated (Load more), each opening the conversation **at the matching
turn**; with a project chosen in the Inbox's title, that project's only.
Its own filters sit with it, labelled fields like every other form:
In (transcripts and chats / transcripts / chats), Who (any / you / agent),
From, To; on a phone they open from "Filter what was said". The switcher's
"See all results" opens the Inbox searching for its words; the palette's
Search and ⌃⇧5 show the Inbox with the keyboard in the field. Content
search can be switched off (drops the index) in Settings → Search; the
lists stay.

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

A floating glass capsule above the home indicator: **Inbox** (needs-you
badge; its search field holds every session and past conversation, ATT-5)
and **Review** (badge: layers waiting on you), and apart from them a round
**Commands** button (the palette). Slide a finger along it to
choose. Settings is reached from the Inbox's gear and opens as a sheet over
the current page; the Inbox's header has the gear and **+** (New session),
and no search button: the field is under it.
