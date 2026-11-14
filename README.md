# ah — agent hub

A self-hosted control plane for persistent terminal and coding-agent sessions.
**tmux owns the processes; ah owns the experience.**

Start a Claude Code / Codex / Muse / shell session at your desk, approve its next command
from your phone, and pick it up on your iPad. Everything runs on your own machines, inside
tmux, reachable only over your tailnet.

```
phone / iPad / laptop ──https (tailscale serve)──▶ ah ──pty──▶ tmux ──▶ agents & shells
                                                     └──/h/<host>──▶ ah on your other machines
```

## Run it

```bash
pnpm install          # builds node-pty (needs gcc/make/python3)
pnpm build            # web UI → dist/
pnpm start                      # ah on 127.0.0.1:7681 — loopback only, always
node bin/ah.js setup tailscale  # once: `tailscale serve` → https://<machine>.<tailnet>.ts.net
```

ah never listens anywhere but loopback and never changes its own exposure: reaching it
from other devices is Tailscale's job. `setup tailscale` writes a persistent Serve config
(tailscaled keeps it across reboots; `--off` removes it). The first time, Tailscale may ask
you to enable Serve for the tailnet. There is no plain-http fallback. On iPhone/iPad, use
Share → Add to Home Screen.

On Omarchy (or any freedesktop desktop), `node bin/ah.js setup desktop` puts ah in the app
launcher as a window of its own (also Settings → System → Desktop app), and `ah open` opens
the tmux window you are in, or any session you name, in that window.

After updating, **restart the server**: the page is served fresh from `dist/`, and a page
newer than the running server shows a "restart ah" banner.

**First sign-in:** the server prints a one-time setup code at startup. Open ah, enter
it, and create a passkey. See [Security model](#security-model).

Keep it running with the systemd user units in [`contrib/ah.service`](contrib/ah.service) and [`contrib/ah-tmux.service`](contrib/ah-tmux.service) (the second owns the tmux server, so ah restarts never touch live sessions).
Development: `pnpm dev`. Tests: `pnpm test`; the page in a real browser (Chromium or Chrome): `pnpm test:ui`.

### Agent hooks (recommended)

```bash
node bin/ah.js hooks install    # Claude Code hooks + Codex notify (backs both files up)
node bin/ah.js hooks status | uninstall
```

With hooks, ah knows exactly when an agent is working, waiting for you (and on *what* —
the command or question), or done, and each conversation's id. Without them it falls back
to terminal rules and output activity, and matches live agents to their transcripts.

## What you get

- **Inbox.** What's blocked on you first, as cards showing the exact command or question,
  with one-tap **Approve / Deny / Reply**. Then what's running (live activity per session),
  then idle and done. Group by status, host or project.
- **Sessions.** A real terminal (xterm.js on a tmux client), and a GUI with an inline composer:
  messages are typed in now if the agent is idle, **queued** until it's free if it's
  working, and the session is **resumed** first if it's dead. Diff and Files sit beside it
  (tabs on a phone). Review queued follow-ups and cancel individual messages from the
  session menu. Each device views independently; whoever typed last sizes the window.
- **Continuity.** Pick up on any device where you left off. Opening ah offers the session
  you were just using on another device (*Continue from iPhone*); an unsent message
  follows you too, kept on the host until you send it. Links, layouts and notifications
  point at a session, not a tmux window, so they survive resumes and restarts; a session
  that ends stays where it was, with its conversation and Resume (⌘↵), and typing a
  message resumes it. Phones and tablets open agents in the GUI; an installed app badges
  its icon with what needs you.
- **Split workspace.** Split right or below from a session's menu, resize the divider,
  and replace a pane from the sidebar or by dragging a session onto it. Closing a pane
  keeps its session running. Layouts stay on each device; phones show panes as tabs.
- **Launch choices.** Choose a model version (including an exact custom model ID),
  reasoning effort, and permission mode, or add quoted CLI arguments. The composer
  also offers model, effort, and permission controls: direct changes where supported,
  otherwise the agent's native terminal picker. Busy agents queue setting changes.
  Selecting terminal text automatically copies it to the clipboard; use Shift-drag
  when the running TUI captures the mouse (Option-drag on macOS).
  Sidebar sessions can be dragged to reorder them across your devices.
- **GUI view.** Flip a Claude Code or Codex session from its terminal to a GUI built
  from the agent's own transcript: markdown, tool calls with diffs and output, plans,
  approvals, and widgets the agent can ask for (choices, tables, stats, charts).
  Same live session, no restart. See [docs/gui.md](docs/gui.md).
- **History.** Every session ah has run, plus past Claude Code and Codex conversations
  found on disk. Resume continues the same conversation (`claude --resume <id>`, …).
- **Files.** Browse the host, upload from any device into any folder, download, preview,
  and insert a path into the session (as an `@mention` for agents).
- **Preview.** A session's dev server (Storybook, Vite, Next…) in a browser pane, served
  from the host: the Preview tab (Ctrl+Alt+6) offers the ports the session's processes
  listen on. ah proxies it on a port of its own behind the same sign-in, published on
  your tailnet as `https://<node>.ts.net:<port>`, so a phone sees what the host serves.
  Live reload works through it. One preview per session; it survives ah restarts.
- **Diff.** Uncommitted changes per session; click a line to send the agent a comment
  anchored to that file and line.
- **Review.** Your pull request stacks, one layer at a time (Ctrl+Shift+4). Review the
  bottom PR of a tree and the whole stack comes along, in a merge order you can change;
  a plan file labels the layers (H0, F1…) and holds the reviewer to its contracts. Each
  layer has a briefing, its patch (this PR, since your review, or from the trunk), and a
  reviewer that reads the exact revisions with read-only tools, on any subscription.
  Turn what you disagree with into findings (on a line, from the reviewer, or from
  GitHub's threads, bots included) and send them to the agent that owns the stack in one
  drafted message, restack of the layers above included. When it pushes, the layer comes
  back for a re-review of only what changed, with the reviewer's verdict on each finding.
  Merge & next merges through GitHub only if the head is still the one you reviewed,
  points the layers above at the trunk, and opens the next. The Inbox tells you when a
  layer needs you. See [docs/stack-review.md](docs/stack-review.md).
- **Worktrees.** Start a session on its own branch in its own checkout; see dirty/ahead
  state and clean up orphans.
- **Notifications.** Web Push for "needs you" / "finished", per device, even with ah closed
  (HTTPS + home-screen app on iOS).
- **Multi-host.** Run ah on every machine; the one you open finds the others on your
  tailnet and proxies them, so one inbox covers all of them.
- **Phone-first touches.** Bottom tabs, big targets, key row with one-tap Ctrl/Alt/Shift
  and clipboard Paste, swipe to scroll tmux, dictation-friendly composer, scrollback as
  selectable text. Shift+Enter sends multiline input; pasted screenshots upload to the host.
- **Keyboard first.** Everything has a keyboard path; the mouse is optional.
  Ctrl+Shift+P opens the command palette, a tree like Omarchy's menu: categories
  (Go to, Session, Workspace, Help, and below them Answer, Turn and queue, Model
  and effort, Panels…) with live branches for open sessions, each queued message
  (Send now / Edit / Cancel), and the session's models and effort levels. ↑↓ move,
  → or Enter opens, ← or Backspace goes back, typing searches everything below
  where you are, categories included; chords sit on their rows. Ctrl+Shift+K (⌘K on a Mac) jumps to any session or resumes a
  conversation, with filters `h:` host/harness, `s:` status, `p:` project, `m:` model.
  Session actions are Ctrl+Alt chords that also work from the composer: R reply
  (into the agent's question or picker when it is waiting), Enter / Backspace
  approve / deny, X stop the turn (or Esc in an empty composer), S send the next
  queued message now, M / E model / effort, N rename, F fork, T send to, C copy
  the last reply, 1–7 the Diff / Files / Chat / Queue / Snapshots / Preview / Stack panel, `.` the
  session menu. Pane and workspace chords work from the composer too; the
  Ctrl+Shift+arrows still select words there and move to the next pane once the
  caret reaches the edge of the text. In a question form, digits pick, arrows move, Space toggles,
  Ctrl+Enter submits. Lists (sidebar, inbox, history, menus, pickers, queue) move
  with the arrow keys; Ctrl+Shift+0 focuses the sidebar and Escape (or
  Ctrl+Shift+9) returns to the session. Alt+↑ / Alt+↓ moves through sessions in
  sidebar order; in a split, Ctrl+Shift+arrows moves between panes.
  Hold Ctrl+Alt or Ctrl+Shift (⌘⇧ on a Mac) for a moment and a which-key overlay shows
  what each key does there right now. Ctrl+Shift+/ opens the shortcut table (also under Settings → Shortcuts), where
  each binding can be changed on this device. ⌘↵ (Ctrl+↵) presses the main
  button wherever you are — Start, Terminate, Fork, Send, Unlock — and each such
  button shows it.
- **Hyprland-style workspace.** Workspaces 1–9 (Alt+N; Alt+Shift+N sends the
  focused session there as a new tile). Pane mode (Ctrl+Shift+Space) is a
  submap: h j k l focus, Shift+h j k l move, v / s split, x close, f maximize,
  t flip, r resize, o open a session as a new pane, 1–9 workspaces, Esc leaves.
  Resize mode (Ctrl+Shift+R), maximize (Ctrl+Shift+F), open as a new pane
  (Ctrl+Shift+O, or Ctrl+Enter in the switcher; it splits along the focused
  pane's longer side), and a scratchpad shell that floats over anything
  (Ctrl+Shift+`). The focused pane wears the accent border.
  Splitting never shows one session twice (two viewers fight over a tmux
  window's size): the new pane asks what goes in it, inside the pane — another
  session, a new shell, or a new session. Replace pane (Ctrl+Alt+P, or p in
  pane mode) uses the same chooser; Esc keeps what was there. New session is
  never a modal: it takes the space the session will occupy.
- **Omarchy.** Settings → Appearance → Omarchy wears the host's current Omarchy
  theme and monospace font on every device, terminal included, and follows it
  when you switch themes on the desktop. Palette → Run in project starts any
  agent or a shell in one of your projects in two keystrokes.

### CLI

The CLI is another view over the same daemon, and lets agents drive agents:

```bash
ah list                       ah history
ah new claude --cwd ~/code/x  ah resume "fix flaky"
ah attach <id|name>           ah read <id> -n 200
ah send reviewer "review the diff" && ah wait reviewer && ah read reviewer
```

(`node bin/ah.js …`, or `pnpm link --global` for a bare `ah`.)

## Security model

Opening ah is equivalent to having a shell as your user, so it has two locks:

**1. Network: Tailscale.** ah only listens on loopback — no flag changes that — and is
reached through `tailscale serve`, never Funnel. A request addressed to the machine's
ts.net name can only have come through Serve, which strips client-sent identity headers
and sets them for user-owned devices; ah then requires the machine owner's identity and
fails closed (tagged devices, other users, or an unknown owner all get 403). Requests to
`localhost` don't consult identity at all. To shrink who can even reach the port,
restrict it in your tailnet policy (admin console → Access controls), e.g.:

```jsonc
"grants": [
  // Only your own (non-tagged) devices may reach ah's HTTPS port on this machine.
  { "src": ["you@example.com"], "dst": ["omarchy"], "ip": ["443"] }
]
```

**2. People: passkeys.** Every device must sign in before it can see or touch anything:
API, event stream, terminals, files. Nothing loads but the lock screen until then.

- **Passkeys** (Face ID, Touch ID, Windows Hello, security keys): phishing-resistant, and
  nothing secret is stored on the server. iCloud/Google-synced passkeys work across your
  devices without re-enrolling.
- **New devices** need a one-time setup code that only the host can produce. It's printed
  when the server starts with nobody enrolled, or run `node bin/ah.js auth code` on the
  host, or use Security → *Create setup code* on a signed-in device. Codes last 10 minutes
  and work once. This also covers **recovery**: if you lose every passkey, get a code on the
  host.
- **Master password** (optional, scrypt): a fallback for browsers without passkeys. Set it
  on the host only:
  `node bin/ah.js auth password`.
- **Sessions** are HttpOnly, `SameSite=Strict`, `__Host-` cookies on https. A device is
  signed out after 24h unused and after 30 days regardless (`auth.idleHours`,
  `auth.maxDays`). **Security** lists passkeys, signed-in devices (revoke one, or sign out
  everywhere else), and recent activity. Revoking a device also closes its open terminals.
- **Throttling:** guessable secrets (master password, setup codes) are throttled per
  source and per mechanism, with a global ceiling. Failed passkey attempts are never
  throttled — nobody can lock you out of passkey sign-in.
- **Machine access:** the local CLI authenticates with a token the server writes to
  `~/.local/state/ah/local-token` (mode 0600). Other hosts get their own revocable tokens:
  run `ah auth token <hub>` on the peer, then `ah peers trust <peer> <token>` on the hub.
- `"auth": { "mode": "off" }` disables sign-in; the server says so loudly when it starts.

Plus:
- Host allowlist (DNS rebinding), Origin checks on WebSockets and writes, and an `X-AH`
  header that can't be sent cross-site without a CORS preflight ah never grants.
- Strict CSP with no third-party origins (fonts are bundled), `nosniff`, no framing,
  COOP/CORP same-origin, HSTS.
- Sessions start only from configured presets; Approve/Deny re-checks that the session is
  still waiting before typing anything.
- The file browser is confined to the configured `files.roots` (home is opt-in, symlinks resolved); every file response
  is CSP-sandboxed, so nothing served can run script on ah's origin.
- An audit log of sign-ins, failures, enrollments and session actions in
  `~/.local/state/ah/audit.log`.

What it can't protect against: anything already running as your user on the host can
drive tmux directly, so treat ah's security as protecting *remote* access.

## Configuration

`~/.config/ah/config.json` (all optional):

```json
{
  "port": 7681,
  "host": "127.0.0.1",
  "defaultSession": "agents",
  "projectRoots": ["~/code"],
  "peers": [],
  "auth": { "mode": "passkey", "idleHours": 24, "maxDays": 30 },
  "files": { "roots": ["~/code", "~/.cache/ah/uploads", "/tmp"] },
  "promptHistory": 60,
  "idleAfter": 4,
  "preview": { "ports": [47600, 47699] },
  "uploads": { "maxBytes": 4294967296, "maxTotalBytes": 21474836480, "minFreeBytes": 1073741824 },
  "presets": [
    { "id": "shell", "name": "Shell", "command": "" },
    {
      "id": "claude", "name": "Claude Code", "command": "claude",
      "resume": "claude --continue", "resumeId": "claude --resume {id}",
      "match": "^claude$",
      "waitingPatterns": ["Do you want to (proceed|make this edit)"],
      "approveKeys": ["Enter"], "denyKeys": ["Escape"]
    }
  ]
}
```

`host` must be loopback (`127.0.0.1` or `::1`). `peers` is `[]` (default),
`[{ "name", "url" }]` with https URLs, or `"auto"` (your own online tailnet machines
running ah). `uploads` caps one upload, the total kept in ah's upload folder, and the free
space an upload must leave (bytes); uploads stream to disk, so large screen recordings
fit. `files.roots` limits the file browser; add `"~"` deliberately if you want your
whole home. `promptHistory: 0` keeps no prompt history. `preview.ports` is the range
preview proxies listen on and publish with `tailscale serve` (ah needs Tailscale's
operator permission, the same as for `tailscale serve` itself). Presets whose command isn't
on tmux's `PATH` are hidden. Any CLI can report status with
`bin/ah-hook.js <preset> <working|waiting|done> [session-id]`.

State lives in `~/.local/state/ah/` and uploads in `~/.cache/ah/uploads/`, all owner-only.
See [SECURITY.md](SECURITY.md) for the threat model, the tested invariants, and what each
state file holds.

### Native iPhone/iPad app

The native app (a separate project, `ah-native`) signs in with a device key it enrolls
using the same one-time code as a new browser (`node bin/ah.js auth code`, or Settings →
Security on a signed-in device). Its notifications go through Apple's APNs, which needs
an APNs key from the Apple Developer account that signs the app:

```json
{ "apns": { "teamId": "ABCDE12345", "keyId": "KEY1234567", "keyFile": "~/.config/ah/AuthKey_KEY1234567.p8", "topic": "<the app's bundle id>" } }
```

Keep the `.p8` file owner-only (`chmod 600`). Without `apns`, the app works but can't
register for notifications. Web Push for browsers is unaffected either way.

Native device sign-in, streams and terminals ship in the same build as the mobile
web app. See the [26 October release verification](docs/releases/2026-10-26-mobile-native.md)
for native-client integration results, mobile screenshots and remaining device-test limits.

## Layout

```
server/  main.ts (HTTP/WS, security, routing) · core.ts (ticker, launch/resume/send/answer)
         sessions.ts (status, detection, history) · registry.ts · discovery.ts · tmux.ts
         terminal.ts · peers.ts · push.ts · files.ts · git.ts · procs.ts · config.ts
web/     React + xterm.js: Inbox, Session, History, Files, Git, Composer, Switcher, …
bin/     ah.js + cli.js (CLI) · ah-hook.js (agent hooks → tmux window options)
```

See [BACKLOG.md](BACKLOG.md) for what's done, what isn't, and the design decisions.
