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
  away. A drag moves it with the finger (its edge under the finger coming
  in, the page dimming as far), and the release settles it: open past 40%
  of its width, shut short of it, and a flick either way decides alone. A
  finger can take it again while it settles.
- **760 px and narrower** (Split View, Slide Over): the phone's layout.

Touch sizing throughout: 44 px menu rows, 36 px segments and chips.

**A hardware keyboard** (a Magic Keyboard) makes the iPad a keyboard device.
ah notices one by the first key iPadOS's on-screen keyboard can't send
(Escape, an arrow, Ctrl, ⌘ or Option) and forgets it when the on-screen
keyboard rises over a field; this device remembers. With one: key hints show
in menus, the palette, the sidebar and buttons; a session takes the keyboard
as it opens, as on a desktop; the terminal's on-screen key bar steps aside
(the session menu still shows it). Every chord works either way.

**Menus, as iPadOS's.** A finger held still on a session row, or a secondary
click (two fingers on a trackpad, a right click), opens the row's menu; the
lift opens nothing, and a drag that starts instead still reorders. Menus are
placed against the screen: under their button when they fit, over it when
that fits, else on the roomier side as tall as the room, scrolling inside
(44 px rows make long menus).

**Window buttons.** In a Stage Manager window iPadOS 26 draws its window
buttons over the top-left corner. A native app gets a 32 pt strip at the top
for them; a home-screen web app gets none (its top inset reads 0), so ah
takes the strip itself whenever it is a home-screen app on an iPad in a
window (narrower than the screen, or clearly shorter), and gives it back in
full screen. Settings → Appearance → Window buttons: *In a window* (the
default), *Always* or *Never*. `?vh=1` shows the numbers it decides by.

**Pointer and finger.** Hover is the pointer's — the trackpad's, a mouse's,
the Pencil hovering — never a finger's: a tap made Safari count a hover and
keep it, which left a button lit and a session row's Terminate showing a tap
away. `<html data-touch>` is set while the last pointer was a finger, and
every `:hover` rule is scoped `:where(:root:not([data-touch]))` (no added
specificity; a stylesheet test keeps new ones scoped). With the trackpad, a
row shows ··· and Terminate under the pointer, as on a desktop (no grips: a
row is dragged by itself, and they would shift the list between finger and
trackpad).

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
- **Context menus**, as iOS lists have: a finger held on a session row
  (Inbox, Sessions) or a History row lifts it out over the blurred page with
  its actions in a menu under it (over it near the bottom; the row moves up
  when neither fits). A session row offers Open, Rename, Pin/Unpin, Send to,
  Fork and Terminate (the desktop row menu's choices); pin, fork and
  terminate act in place. History offers Resume, Fork and Hide. The lift
  opens nothing; a tap elsewhere or Escape puts it back. Touch screens only
  (an iPad's Inbox rows too).
- **Swipe actions**, as Mail's: a session row swipes left to **Pin** and
  **Terminate**, a History row to **Fork** and **Hide**. Past half the
  actions it stays open; past 60% of the row, letting go runs the outermost
  (Terminate still asks). One row open at a time; a tap on it, or anywhere
  else, closes it. Only a sideways drag counts, so lists still scroll.
- **Settings as iOS Settings**: the sheet opens on a grouped list (*This
  device*: Appearance, Shortcuts, Notifications; *This host*: Security,
  Agents, Subscriptions, Environment, Search, System), each row a colored
  tile, its name and a chevron. A section is a page of its own, named in the
  sheet's bar with Back to the list. A link to a section (`#settings/agents`)
  opens it, and Back returns to the list. A desktop's `#settings` is still
  Security beside the section list.
- **Switches** for on/off settings everywhere (notifications, the agents New
  session offers, content search, snapshots, New session's options, a secret
  variable, @mention): the words first, the switch at the row's end. Safari
  draws its own `<input type="checkbox" switch>`; other browsers get a drawn
  one. Picking items stays checkboxes.
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
