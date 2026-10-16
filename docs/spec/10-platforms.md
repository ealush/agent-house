# 10 · Platforms

One web app, shaped by the device it runs on. "Narrow" (a phone, portrait or
sideways) is one media query shared by script and CSS.

## PLT-1 · Desktop — shipped

Floating glass sidebar beside a main area with the same 16 px corners; split
workspace; keyboard first; hover reveals row actions; popovers grow from their
button.

## PLT-2 · iPad — shipped

The desktop layout with touch sizing: 44 px menu rows, 36 px segments and
chips, no key hints on touch-only devices; a narrow page drops the Inbox's
Detail column (portrait). Hardware keyboards get every chord.

## PLT-3 · Phone — shipped

- Floating glass **tab bar**: Inbox, Sessions, History, and Commands (ATT-8).
- **Large titles** that collapse into a frosted bar on scroll.
- Sessions push in and pop out like an iOS navigation stack; **swipe back**
  from the edge (the page underneath follows the finger; commits past ⅓ or on
  a flick; never starts in a text field; iOS's own edge gesture is blocked so
  only one runs).
- **Sheets** for every modal except confirmations: rise from the bottom,
  scroll inside, grabber and ✕, drag down to close. New session and Settings
  are sheets.
- **Action sheet** for the session menu (VIEW-3).
- Agents open in the **GUI** unless you chose the terminal for that session.
- 44 pt minimum targets; 16 px fields (no zoom); safe areas and the keyboard
  offset respected; edge fades on scrolling strips.

## PLT-4 · Desktop app — shipped

`ah setup desktop` or Settings → System: an Omarchy web app (or a freedesktop
entry elsewhere) that opens ah in its own window, from the app launcher
(Super+Space); a Hyprland bind to copy; `ah open` opens the tmux window you
are in.

## PLT-5 · Home-screen app (PWA) — shipped

Manifest and icons; Share → Add to Home Screen on iOS. Required for Web Push
on iOS; badges its icon (CON-7).

## PLT-6 · Omarchy — shipped

Appearance → Omarchy (SET-2); Run in project (SES-4) mirrors Omarchy's launcher;
the palette is shaped like Omarchy's menu; workspaces and pane mode follow
Hyprland.

## PLT-7 · Accessibility and motion — shipped

Every control is named; focus is managed after every action (KEY-6); reduced
motion removes transitions; Reduce Transparency and Increase Contrast make
glass solid; light-theme secondary text meets AA (tested).
