# 11 · Design system

How ah looks, as one system. This file records the system as built; the
redesign (see the end) replaces its values, not its rules.

## DS-1 · Principles

1. **Status is the loudest thing on screen.** Only *needs you* uses the
   brand colour as a fill; everything else is quiet until it changes.
2. **One thing, one look.** A session row, a status pill, an option to pick,
   a keycap, a project chip: each has exactly one component, used everywhere.
3. **Words, not terminal.** No raw screen text, tool JSON, upload paths or
   lowercase monospace labels where prose can say it. Monospace is for code,
   commands, paths and the terminal only.
4. **Native on each device.** iOS conventions on a phone (tab bar, sheets,
   large titles, swipe back), keyboard first on a desktop, the same tokens on
   both.
5. **Motion explains.** Things arrive from where they come from; nothing moves
   for decoration.

## DS-2 · Tokens — shipped

One file, `web/tokens.css`, sets every value from the design system: dark and
light, the glass, depth, type stacks, radii and motion. `styles.css`,
`site-theme.css` and `gui.css` only read it. The app's working names
(`--bg`, `--raised`, `--text`, `--accent`…) carry the values, because
Appearance → Omarchy overrides them at runtime; the design system's names
(`--ground`, `--surface-raised`, `--ink`, `--accent-fill`…) are aliases of
them for new code.

| Role | Dark | Light |
|---|---|---|
| Ground / surface / raised / sunken | `#191a25` `#202231` `#2a2c3e` `#15161f` | `#eef0f4` `#ffffff` `#f5f6f9` `#eceef3` |
| Text / text-2 / muted / faint | `#ffffff` `#c9cad3` `#a2a4b3` `#8d8fa3` | `#1c1d27` `#474a58` `#5f6272` `#686b7a` |
| Brand (marks) / accent (text) / accent-strong (fills) | `#e91e63` `#f47199` `#d81b60` | `#e91e63` `#c2185b` `#d81b60` |
| Working / done / limited / danger | `#4dd9ea` `#81d88a` `#f5b84b` `#ff8a80` | `#00737d` `#276b2b` `#8a5a00` `#c62828` |
| Agents | `--c-<agent>`: one tint each, logos are the agents' own | darker tints |
| Type | `--ui` Rubik Variable, `--mono` JetBrains Mono | bundled; no third-party fonts (CSP) |

The app icon, the PWA's theme color and the terminal's palette (sunken
ground, pink cursor) use the same values.

## DS-3 · Scales (enforced by `test/design.test.ts`)

- **Type**: 11, 12, 13, 14, 15, 16, 17, 20, 22, 24, 28 px. Large titles on
  root pages with the pink full stop ("Inbox."). Tabular figures for counts
  and times; balanced headings.
- **Weight**: 400, 500, 600, 700.
- **Radius**: 0, 2, 4, 6, 8, 10, 12, 16, 999. Concentric corners come from
  padding, not new radii.
- **Targets**: no control under 32 px anywhere (smoke test on desktop, iPad,
  iPhone); 44 pt on a phone.

## DS-4 · Material

- **Liquid glass** for floating chrome (sidebar, tab bar, bar buttons, nav
  capsules, menus): `--glass-fill` over a transparent 1 px border,
  `--glass-blur`, `--glass-depth` before the elevation shadow; pressed glass
  swells (1.08) and springs back. Never put a view-transition-name, filter,
  opacity or mask on a glass element's ancestor (it stops the blur).
- **Elevation**: two steps (`--elev-1` menus, popovers, toasts; `--elev-2`
  dialogs); one scrim.
- Reduce Transparency / Increase Contrast: glass turns solid.

## DS-5 · Motion

One curve (`--ease`), two durations (120 ms state, 200 ms arrival). Views
arrive from where they are (down/up the sidebar, iOS push/pop, workspaces
sideways); one gliding selection per list (Glide); rows FLIP between sections;
menus grow from their button; sheets rise; toasts rise and sink. Reduced
motion leaves only a 1 ms scrim fade.

## DS-6 · Components (as built)

Buttons (primary pink, secondary outline, ghost, danger, icon, glass circle),
segmented control (capsule, lens thumb, slide to choose), chips, status pill
(the UI face, a capsule, one tint per status; only *needs you* filled), tags
(agent, model, project: names in the UI face), status dot, keycap, agent mark,
session row (one line, `sessionLine.tsx`), the ask summary and option rows
(`AskSummary`, OptionList), panel tabs (icons, the open one named), setting
chips (a quiet name and the value), fields (words by default, `.mono` for
paths, commands and keys), the info note (`.note`), cards
(`sec-card`), the ask card / panel, tool row, widget set, composer, menu /
action sheet, dialog / sheet, toast, empty state, large title, tab bar, side
panel tabs.

## DS-7 · Voice

Sentence case everywhere (tabs and buttons included). Say what will happen
("Restarts this session with it"), not what the code does. Plurals are right
("1 conversation"). Errors say what happened and what ah does next. Touch
devices never name keys.

## DS-8 · Redesign (October 2026)

The full system is redesigned in Claude Design as one cohesive, functional,
premium look:

- **Design system "ah"** — https://claude.ai/artifact/2T5PJyjouhLem3Gmh6JFtz:
  one token set for both themes (contrast-checked), Rubik and JetBrains Mono,
  the icon set, the agents' marks, the app icon in the brand colors, and 28
  components (`ah-` classes in one stylesheet) that settle the audit's design
  findings: one SessionRow, one AskCard, one OptionList, one ToolRow, one
  session Menu, Notice, styled Fields, PanelTabs that always fit.
- **Redesign canvas** — https://claude.ai/artifact/XKVpwYoyvXQ8299qmPE4Sx:
  every screen built from those components: 12 desktop screens (Inbox,
  session needing you with Diff, working with a queue, terminal with the ask
  bar, split workspace, palette, switcher, New session, Fork, History, Search,
  Settings), 7 phone screens (Inbox, session, action sheet, Sessions, New
  session, History, Settings), and the light theme.

The design system is the source for DS-2 to DS-6; implementing it replaces
`styles.css` + `site-theme.css` with one token file (A-17).
