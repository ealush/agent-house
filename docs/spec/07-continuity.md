# 07 · Continuity

ah follows you between devices, restarts and resumes. This is the part of the
product that makes it one thing rather than a set of screens.

## CON-1 · Stable links — shipped

A URL is `/#<uid>` (or `#history`, `#settings/<section>`, `#search`). Links,
layouts, workspaces, scratchpad, notifications and drafts point at a session
uid, so they survive resume, relaunch, tmux restarts and reboots and never
point at a different window. Pages and sessions are history entries: the Back
chevron, the edge swipe and the Settings sheet go through `history.back()`.
→ A-14: a hash link does nothing while a split is open.

## CON-2 · Ended in place — shipped

A session that ends, or a link to one, shows in place with Resume (⌘↵),
instead of bouncing to the Inbox. Panes after a reboot offer the same.

## CON-3 · Handoff — shipped

Each device reports the session it is on (`/api/focus`). Opening ah on another
device offers it: "Continue from iPhone · 2m" with the title, at the top of
the sidebar or the phone's Inbox, until you open it, dismiss it, or use this
device.

## CON-4 · Drafts follow you — shipped

Unsent composer text is kept per session on the host (debounced, owner-only,
dropped after 14 days untouched). The box you are typing in always wins; the
other side pulls on focus and says which device a draft came from.

## CON-5 · Presence — shipped

A session knows which devices are viewing it (per page, however many
connections it holds); the header says "On Desk too" when another device is
looking. Viewing marks a session seen (clears done). The GUI counts as
viewing.

## CON-6 · Notifications — shipped

Web Push per device, opt-in per event: **needs you** (high urgency) and
**finished** (a working session that stopped while nobody watched; "hit its
usage limit" when that is why). A 1-tap notification opens the session.
Restarting ah never replays alerts; a cooldown stops repeats. HTTPS required;
on iOS, the home-screen app. → A-15: notifications are titled with the tmux
window name, not the session title.

## CON-7 · App badge — shipped

The installed app's icon carries the needs-you count (service worker), and
the Inbox nav item and tab show it.

## CON-8 · Reconnect — shipped

One SSE stream per host with exponential backoff and an immediate retry on
wake / online; terminals reattach (tmux repaints the screen, so a reattach is
always consistent). The open session is restored from the URL. Unreachable
hosts read as such, in every browser's wording ("Can't reach the host").

## CON-9 · Updates — shipped

The page is served fresh from `dist/`. A page newer than the running server
shows a banner. Settings → System → Restart / Rebuild and restart; the page
reconnects on its own. → A-16: the banner tells you to run `pnpm serve`
instead of offering the Restart it links to.

## CON-10 · What is whose — shipped

| Host-wide (every device sees the same) | This device only |
|---|---|
| sessions, titles, order, pins | theme, Omarchy mode |
| queue, drafts, prompt history | split layouts, workspaces 1–9 |
| side chats, subscriptions | Terminal / GUI choice per session |
| environment, agents shown in New session | hide steps, on-screen keys |
| search index, snapshots | shortcut bindings |
| device names, passkeys | notification opt-in |
| | sidebar group order, Inbox grouping |
| | most-used agents in New session |

## CON-11 · Instant first paint — shipped

The session list paints from an encrypted cache before the stream answers;
the GUI paints its last page from IndexedDB (VIEW-5). Terminal, markdown,
passkeys and Settings load on demand (main script ~147 KB gz).
