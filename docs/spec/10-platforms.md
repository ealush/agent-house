# 10 · Platforms

One web app, shaped by the device it runs on. "Narrow" (a phone, portrait or
sideways) is one media query shared by script and CSS.

## PLT-1 · Desktop — shipped

Floating glass sidebar beside a main area with the same 16 px corners; split
workspace; keyboard first; hover reveals row actions; popovers grow from their
button.

## PLT-2 · iPad — shipped

Laid out by the window's width, as iPadOS apps are by size class, so an 11"
iPad in landscape, in portrait, in Stage Manager and in Split View each get
the layout that fits:

- **1100 px and wider** (landscape, a large window): the desktop layout, the
  sidebar beside the page.
- **761–1099 px** (portrait, a Stage Manager window, a narrow desktop window):
  the page keeps the width; the sidebar **slides over it** from the rail's
  button, Ctrl+Shift+E, or a drag in from the left edge, over a dimmed page.
  Picking anything, a drag to the left, Escape or a tap on the page puts it
  away.
- **760 px and narrower** (Split View, Slide Over): the phone's layout.

Touch sizing throughout: 44 px menu rows, 36 px segments and chips.

**A hardware keyboard** (a Magic Keyboard) makes the iPad a keyboard device.
ah notices one by the first key iPadOS's on-screen keyboard can't send
(Escape, an arrow, Ctrl, ⌘ or Option) and forgets it when the on-screen
keyboard rises over a field; this device remembers. With one: key hints show
in menus, the palette, the sidebar and buttons; a session takes the keyboard
as it opens, as on a desktop; the terminal's on-screen key bar steps aside
(the session menu still shows it). Every chord works either way.

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
