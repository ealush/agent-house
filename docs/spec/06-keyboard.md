# 06 · Keyboard and commands

## KEY-1 · One command catalog — shipped

Every app action is a **command** in `web/shortcuts.ts` (id, group, label,
detail, chords, scopes, search terms): 84 commands in three groups
(Navigate, Session, Workspace; the last includes workspace 1–9 and send to
workspace 1–9). Menus,
the palette, the shortcut table, which-key and chord hints all read labels
and chords from it (`commandLabel`), so a command reads the same everywhere:
"Diff", "Queue", "Pin", "Send next queued now", "Copy attach command".

Rules:

- A chord needs Ctrl, Alt or Super, so a plain letter always reaches the
  agent.
- Matching uses the character the layout produces (Colemak works), except
  digits and punctuation, which stay on the physical key.
- **Scopes**: `app`, `terminal`, `field`, `dialog`, `ask`. Ctrl+Alt session
  chords work from the composer too; a question form owns its keys.
- Platform-aware keycaps: ⌘ ⌥ ⌃ ⇧ on a Mac; Ctrl, Alt, Shift and Super
  elsewhere, as the keys and tooltips say. ↵, Esc and arrows are glyphs
  everywhere. Touch-only devices show no key hints.

## KEY-2 · Command palette — shipped

⌃⇧P (⌘⇧P). A tree like Omarchy's menu: New session, New project, Search or
jump, Scratchpad shell, **Run in project**, **Go to**, **Session** (Answer,
Turn and queue, Model and effort, Panels, View, Manage, Continue in…),
**Workspace** (Open as a new pane, Split, Focus pane, Move pane, Workspaces,
Resize), **Settings** (theme, reload, restart, rebuild, clear uploads, and the
pages), **Help**. Live branches: open sessions, each queued message (Send now /
Edit / Cancel), the session's models, efforts and modes, agents to continue
in, projects. ↑↓ move, → or Enter opens, ← or Backspace goes back, typing
searches everything below where you are; chords sit on their rows; rows
carry agent marks. The palette only offers what can run now.

## KEY-3 · Session chords — shipped

Ctrl+Alt (⌃⌥) + R reply · ↵ approve · ⌫ deny · X stop · S send next queued now
· M model · E effort · N rename · F fork · T send to · C copy last reply ·
P replace pane · H hide steps · B browse messages · End jump to latest ·
1–7 panels · `.` session menu. Esc in an empty composer
stops the turn.

## KEY-4 · Navigation chords — shipped

⌃⇧P palette · ⌘K / ⌃⇧K switcher · ⌃⇧↵ new session · ⌃⇧1/3/4/5 Inbox /
Settings / Review / Search (History is in Search; ⌃⇧2 is free) · ⌃⇧0 sidebar ·
⌃⇧9 or Esc back to the session · Alt+↑/↓ previous / next session · ⌃⇧E sidebar · ⌃⇧G Terminal / GUI · ⌃⇧J side panel · ⌃⇧/ shortcut
table.

## KEY-5 · ⌘↵ presses the main button — shipped

Start, Fork, Terminate, Send, Resume, Unlock… Every main button registers
while mounted and shows its keycap; ⌘↵ (⌃↵) presses the newest one in the
current dialog or screen. Anything that owns ⌃↵ itself (a question form, a
diff comment, the switcher) wins; a terminal keeps the key.

## KEY-6 · Lists move with arrows — shipped

Sidebar, Inbox, History, menus, pickers, the queue (`data-rove`). Tab moves in
and out. Arrows enter an unfocused page's list. Focus lands where you are
after every action (dialogs give it back; a session claims the keyboard until
it lands; lists keep your place when an item goes).

## KEY-7 · Which-key — shipped

Hold ⌃⌥ or ⌃⇧ (⌘⇧ on a Mac) for a moment: an overlay shows what each key does
there right now. Pane mode and resize mode show theirs.

## KEY-8 · Shortcut table — shipped

⌃⇧/ or Settings → Shortcuts: every command with its binding, where it works
(When), and whether it is the default; search; rebind any command on this
device (`ah.shortcuts.v1`), with conflicts shown.
