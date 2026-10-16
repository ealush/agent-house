# Consistency audit — 17 October 2026

How well ah's features agree with one another. Method: the spec was written
back from the code, then every surface was driven in Chromium against a
throwaway ah (its own tmux socket, state and port) with stand-in Claude agents
in each state (needs you on a command, needs you on a question, working with a
plan, done with a table and a widget), shells, a dev server, past
conversations and dirty git checkouts: 35 desktop screens at 1440×900 and 10
iPhone 15 Pro screens, in the dark theme.

Severity: **S1** wrong or broken · **S2** the same thing behaves or is reached
differently depending on where you are · **S3** the same thing looks or reads
differently.
Resolution: **fix** (code, now) · **design** (the redesign settles it) ·
**call** (a product decision for the owner).

## Parity matrix

Where each session action is reachable. ✓ yes · — not there · n/a doesn't
apply there.

| Action | Sidebar row ··· | Session ··· (desktop) | Action sheet (phone) | Palette | Chord | Inbox | History ··· | CLI |
|---|---|---|---|---|---|---|---|---|
| Open | click | n/a | n/a | Go to | Alt+↑/↓ | Open | n/a | `attach` |
| Answer (approve / deny / pick) | — | n/a | n/a | ✓ | ⌃⌥↵ ⌃⌥⌫ digits | ✓ | n/a | `answer` |
| Reply | — | n/a | n/a | ✓ | ⌃⌥R | Open + reply | n/a | `send` |
| Stop the turn | — | — | — | ✓ | ⌃⌥X, Esc | — | n/a | `stop` |
| Rename | — **A-24** | ✓ | ✓ | ✓ | ⌃⌥N | — | — | `rename` |
| Pin | — **A-24** | ✓ | ✓ | ✓ | — | — | — | `pin` |
| Branch | — | ✓ | ✓ | ✓ | — | — | — | — |
| Fork | ✓ | ✓ | ✓ | ✓ | ⌃⌥F | — | ✓ | `fork` |
| Continue in | — | ✓ | ✓ | ✓ | — | — | — | — |
| Send to | — | ✓ | ✓ | ✓ | ⌃⌥T | — | — | — |
| Model / effort / mode | — | — | — | ✓ | ⌃⌥M ⌃⌥E | — | — | `new --model` only |
| Queue: send now / cancel | — | ✓ | ✓ | ✓ | ⌃⌥S | — | — | `queue --clear` |
| Panels (diff…preview) | — | ✓ | tabs | ✓ | ⌃⌥1–6 | — | — | `snapshots`, `rollback` |
| Split / replace / close | drag to edge | ✓ | n/a | ✓ | ✓ | — | — | n/a |
| Terminate | ✓ (+ hover ✕) | ✓ | ✓ | ✓ | — | — | — | `terminate` |
| Resume | n/a | Ended: Resume | Ended: Resume | Go to | ⌘↵ on ended | empty Inbox | ✓ (tap) | `resume` |
| Hide from History | n/a | n/a | n/a | — | — | — | ✓ | — |
| Worktrees | footer button | — | palette | palette | — | — | — | `worktrees` |
| Search page | sidebar | — | palette | palette | ⌃⇧5 | — | — | — |

## Vocabulary drift

The same command, named differently by the surfaces that show it (A-12):

Settled in the catalog; the session menu now reads its labels from it.

| Catalog / palette / shortcut table (before) | Session menu (before) | Side panel tab | Now |
|---|---|---|---|
| Panel: Side chat | Chat | Chat | **Chat** |
| Panel: Queue | Queued messages (n) | Queue | **Queue** |
| Send the next queued message now | Send next queued now | — | **Send next now** |
| Pin or unpin | Pin to top | — | **Pin** / **Unpin** (stateful) |
| Hide / show steps | Hide steps / Show steps | — | stateful, as the menu |
| Copy attach command | Copy "ah attach c43ce2df" | — | **Copy attach command** |
| Terminal / GUI | (header: GUI · Terminal) | GUI / Terminal tab | **View: GUI / Terminal** |

Elsewhere: status pills and project / agent / model chips are set in
lowercase monospace ("needs you", "claude code", "opus 5.5") while the
sidebar, header and History say "Claude Code" and "Opus 5.5" (A-20).

## Findings

| # | Sev | Finding | Where | Resolution |
|---|---|---|---|---|
| A-14 | S1 | A hash link does nothing while a split is open: the URL becomes `#settings` (or `#history`), the split stays. Side chat's "Add one under Settings → Subscriptions" is such a link. | `App.tsx` route ↔ workspace | **fix** → **fixed: a page link leaves the split** |
| A-15 | S1 | Push notifications are titled with the tmux window name ("claude needs you") instead of the session title ("Fix Safari login flash needs you"), and the body doesn't say what it needs. | `server/push.ts` | **fix** → **fixed: title, and what it asks** |
| A-03 | S2 | One ask, three renderings: the Inbox card shows the raw screen in monospace ("Bash command / pnpm test… / Do you want to proceed?"); the GUI shows "Do you want to proceed?" with the command only in the tool row above and the screen behind "Terminal text"; the terminal's answer card shows "Wants to run a command" without the command. | `Inbox.tsx`, `AskPanel.tsx` | **design** (one Ask component: what, the command or question, options), then fix → **fixed: AskSummary in all three** |
| A-05 | S2 | A tool waiting on you reads differently by tool: the Bash row says "Waiting for you"; the AskUserQuestion row says "Running…" while the question waits below it. | `web/gui/tools.tsx` | **fix** → **fixed: every ask marks its call** |
| A-07 | S2 | Worktrees is reachable only from the desktop sidebar's footer: not on a phone, not in the palette. | `Sidebar.tsx`, `palette.ts` | **fix** (palette command; Settings → System link) → **fixed: palette command** |
| A-08 | S2 | Branch switching has no palette command, and the desktop session menu lacks the Branch row the phone has. | `Session.tsx`, `palette.ts` | **fix** → **fixed: palette command, desktop menu row** |
| A-10 | S2 | The Search page is reached only through the switcher's "See all results" (no sidebar, tab bar or palette entry), and its scope, speaker and date fields are unstyled native controls. | `SearchView.tsx` | **fix** (palette entry) + **design** → **reach fixed: sidebar, palette, ⌃⇧5** |
| A-11 | S2 | Side panel tabs don't fit six at the default width ("Previe" is clipped), and the strip changes with the panel (Chat drops Preview and adds a history icon). | `Session.tsx` side panel | **design** |
| A-19 | S2 | Six renderings of "a session in a list", with different subtitles: sidebar (title + model label), Inbox table (detail column), switcher (monospace "project · detail"), pane chooser ("Agent · project · branch"), History ("Agent · Model · project"), phone Sessions (detail + pill). | many | **design** (one session row with defined slots) |
| A-21 | S2 | The fork dialog names the session by its window name ("Copies "claude"…", name "claude (fork)") instead of its title. | `ForkDialog.tsx` | **fix** → **fixed: the title everywhere** |
| A-24 | S2 | Row menus disagree: the sidebar row's ··· has Fork and Terminate only; Rename and Pin are only in the session's own menu. | `Sidebar.tsx` | **design** (one session menu, everywhere) |
| A-09 | S2 | The CLI can't answer a prompt, stop a turn, terminate, rename or pin, which agents driving agents need. | `bin/cli.js` | **call** (CLI parity is an addition during a freeze) → **decided: added answer, stop, terminate, rename, pin** |
| A-17 | S2 | Two token layers: `styles.css` (amber, Inter, radius 12) and `site-theme.css` over it (pink, Rubik, radius 10); components are styled in both. | CSS | **design** → one token file → **fixed: web/tokens.css** |
| A-01 | S3 | Part of the HTTP API is addressed by tmux window id (diff, branches, pull, side chat, rename, kill, capture), the rest by session uid. Invisible to users, but a resume between a request and its answer targets a dead window. | `server/main.ts` | **fix** (uid routes, keep window routes as aliases) → **fixed: /api/sessions/:uid/…** |
| A-02 | S3 | The tagline folds done and limited into "idle" ("4 idle") while the section is "Idle and done". | `web/status.ts` | **fix** → **fixed: one count per word** |
| A-04 | S3 | The phone header shows the view twice: icons in the glass capsule and the first tab. | `Session.tsx` | **design** |
| A-06 | S3 | Two looks for "choose one": a widget's choices are bold outlined buttons stacked loosely; an agent's question is numbered option rows. Question option descriptions are bold. | `widgets.tsx`, `AskPanel.tsx` | **design** → **fixed: one option row** |
| A-12 | S3 | The same command is named differently in the catalog, the session menu and the panel tabs (table above). The menu repeats labels instead of reading the catalog. | `Session.tsx`, `shortcuts.ts` | **fix** → **fixed: menus read the catalog** |
| A-13 | S3 | Keycaps draw Mac glyphs (⌃ ⌥) on Linux while tooltips, the README and the palette's search say "Ctrl+Alt". | `shortcuts.tsx` | **call** (glyphs everywhere, or words off Mac) → **decided: words off a Mac** |
| A-16 | S3 | The stale-server banner says to run `pnpm serve` rather than offering Settings → System's Restart. | `App.tsx` | **fix** → **fixed: the banner restarts** |
| A-18 | S3 | "This device" is a card in both Security (name) and System (reload). | `Security.tsx`, `System.tsx` | **fix** → **fixed: Reload joins Server** |
| A-20 | S3 | Status pills and the Inbox card's agent / model / project chips are lowercase monospace; everywhere else these are sans and title case ("Opus 5.5"). | CSS | **design** → **fixed: pills and tags in the UI face** |
| A-22 | S3 | The fork dialog shows an informational note (uncommitted changes stay behind) as a red error. | `ForkDialog.tsx` | **design** |
| A-25 | S3 | The composer's Effort chip shows no value at the default, while Model shows the model in use. | `Composer.tsx` | **fix** ("Effort: auto" or the level) → **fixed: Effort: Default** |
| A-26 | S3 | New session opens on Shell for a device with no history, though agents are the product's point; the Project field starts at the projects root on desktop and `~` on a phone. | `NewDialog.tsx` | **call** → **decided: Agent, the latest project** |
| A-27 | S3 | Files panel: the toolbar's icons are unlabeled, the roots select truncates to "Roots…", Insert sits beside every row. | `Files.tsx` | **design** |
| A-29 | S3 | The app icon, manifest and apple-touch icon are still in the retired amber palette while the app is pink. | `web/public/icon.svg` | **design** (redrawn in the design system's Logo group) → **fixed: icon, PNGs, theme color, terminal** |
| A-28 | S3 | Settings sections have icons in the palette but none in the page's section list. | `Settings.tsx` | **design** |

## Already open (from earlier passes, still true)

- Sidebar title vs model label width at 260 px (polish audit).
- The Inbox permission card's Bash command isn't monospace after the screen
  loses its indentation (now part of A-03).
- Real-device checks: iOS keyboard and safe areas, swipe back, iPad hardware
  keyboards.

## Plan

1. **Fix now** (behaviour, no design needed): A-14, A-15, A-05, A-07, A-08,
   A-21, A-02, A-12, A-16, A-18, A-25, A-01, A-10's palette entry.
2. **Redesign** in Claude Design, one system for every screen: A-03, A-04,
   A-06, A-10, A-11, A-17, A-19, A-20, A-22, A-24, A-27, A-28, A-29.
   Design system: https://claude.ai/artifact/2T5PJyjouhLem3Gmh6JFtz ·
   canvas: https://claude.ai/artifact/XKVpwYoyvXQ8299qmPE4Sx
3. **Owner calls**: A-09 (CLI parity during the freeze), A-13 (keycap glyphs
   off Mac), A-26 (New session's default).
