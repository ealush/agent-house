# 05 · Workspace

How sessions share the screen on a desktop or iPad. Everything here is
**device-local** (localStorage), keyed by session uid, and stored as ratios so
a layout moves between a 32" monitor and an 11" iPad. Phones show one session
at a time; a split's panes become tabs.

## WS-1 · Split — shipped

Split right (⌃⇧\\) or below (⌃⇧-), from the session menu, the palette, or pane
mode. Each pane is an independent viewer of one tmux window, never tmux's own
split-pane. Dividers drag to resize. Panes are placed flat, so terminals stay
live through split / close / maximize, and animate from their old tile
(FLIP). The focused pane wears the accent border.

A split bar above the panes says "Split view · N panes" with **Exit split**.

## WS-2 · Pane chooser — shipped

A new or replaced pane asks what goes in it, **inside the pane** (never a
modal): New shell (same project), New session…, or any session not already on
screen. Type to filter, arrows, Enter; Esc cancels (a split's chooser closes,
a replace restores what was there). **One session is never shown twice**: two
viewers of one tmux window fight over its size.

## WS-3 · Replace, move, close — shipped

- **Replace pane** (⌃⌥P, or p in pane mode): the chooser in place.
- Pick a session in the sidebar to replace the focused pane; drag one onto a
  pane's edge to split there.
- **Move pane** (Shift+h j k l in pane mode), **Flip split**, **Close pane**
  (the session keeps running), **Maximize** (⌃⇧F).

## WS-4 · Open as a new pane — shipped

⌃⇧O, ⌃↵ in the switcher, or the palette's "Open as a new pane": splits the
focused pane along its longer side.

## WS-5 · Workspaces 1–9 — shipped

Hyprland style. Alt+N switches (the old one is saved, the new one restored;
they slide sideways); Alt+Shift+N sends the focused session to workspace N as
a new tile.

## WS-6 · Pane mode — shipped

⌃⇧Space enters a submap: h j k l focus, Shift+h j k l move, v / s split,
x close, f maximize, t flip, r resize, o open a session as a new pane,
p replace, 1–9 workspaces, Esc leaves. The which-key overlay shows it.

## WS-7 · Resize mode — shipped

⌃⇧R: arrows move the nearest divider (and the side panel), Esc leaves.

## WS-8 · Scratchpad — shipped

⌃⇧`: a shell that floats over anything, like Hyprland's special workspace,
shown and hidden with the same chord.

## WS-9 · Focus between panes — shipped

⌃⇧ + arrows move focus to the next pane; from the composer they first select
words, and move to the next pane once the caret reaches the edge of the text.
