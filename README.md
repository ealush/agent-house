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
pnpm serve            # ah on 127.0.0.1:7681 + `tailscale serve` → https://<machine>.<tailnet>.ts.net
```

`pnpm serve` runs `tailscale serve` alongside ah, so the tailnet HTTPS endpoint lives
exactly as long as ah does. The first time, Tailscale asks you to enable Serve for the
tailnet (one link); until then ah also listens on the Tailscale IP over plain HTTP.
`pnpm start` is localhost-only. On iPhone/iPad, use Share → Add to Home Screen.

After updating, **restart the server**: the page is served fresh from `dist/`, and a page
newer than the running server shows a "restart ah" banner.

Keep it running with the systemd user unit in [`contrib/ah.service`](contrib/ah.service).
Development: `pnpm dev`. Tests: `pnpm test`.

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
- **Sessions.** A real terminal (xterm.js on a tmux client) with an inline composer:
  messages are typed in now if the agent is idle, **queued** until it's free if it's
  working, and the session is **resumed** first if it's dead. Diff and Files sit beside it
  (tabs on a phone). Each device views independently; whoever typed last sizes the window.
- **History.** Every session ah has run, plus past Claude Code and Codex conversations
  found on disk. Resume continues the same conversation (`claude --resume <id>`, …).
- **Files.** Browse the host, upload from any device into any folder, download, preview,
  and insert a path into the session (as an `@mention` for agents).
- **Review.** Uncommitted changes per session; click a line to send the agent a comment
  anchored to that file and line.
- **Worktrees.** Start a session on its own branch in its own checkout; see dirty/ahead
  state and clean up orphans.
- **Notifications.** Web Push for "needs you" / "finished", per device, even with ah closed
  (HTTPS + home-screen app on iOS).
- **Multi-host.** Run ah on every machine; the one you open finds the others on your
  tailnet and proxies them, so one inbox covers all of them.
- **Phone-first touches.** Bottom tabs, big targets, key row with sticky Ctrl/Alt, swipe to
  scroll tmux, dictation-friendly composer, scrollback as selectable text.
- **⌘K / Ctrl+Shift+K**: jump to any session or resume any conversation;
  filters `h:` host/harness, `s:` status, `p:` project, `m:` model.

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

Opening ah is equivalent to having a shell as your user, so it leans on Tailscale rather
than home-grown auth:

- Binds to `127.0.0.1` (refuses `0.0.0.0`); reach it via `tailscale serve`. **Never Funnel.**
- Requests arriving through Serve from a Tailscale user other than the machine's owner
  are refused.
- Host allowlist (DNS rebinding), Origin checks on WebSockets and writes, plus an `X-AH`
  header that can't be sent cross-site without a CORS preflight ah never grants.
- Sessions start only from configured presets; Approve/Deny re-checks that the session is
  still waiting before typing anything.
- The file browser is confined to home and `/tmp` (symlinks resolved); every file response
  is CSP-sandboxed with `nosniff`, so nothing served can run script on ah's origin.
- Audit log of create/kill/resume/send/answer/upload on stdout.

## Configuration

`~/.config/ah/config.json` (all optional):

```json
{
  "port": 7681,
  "host": "127.0.0.1",
  "defaultSession": "agents",
  "projectRoots": ["~/code"],
  "peers": "auto",
  "idleAfter": 4,
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

`host` takes a comma list (`127.0.0.1,tailscale`). `peers` is `"auto"` (your own online
tailnet machines running ah), `[]`, or `[{ "name", "url" }]`. Presets whose command isn't
on tmux's `PATH` are hidden. Any CLI can report status with
`bin/ah-hook.js <preset> <working|waiting|done> [session-id]`.

State lives in `~/.local/state/ah/` (registry, prompt history, push subscriptions);
uploads in `~/.cache/ah/uploads/`.

## Layout

```
server/  main.ts (HTTP/WS, security, routing) · core.ts (ticker, launch/resume/send/answer)
         sessions.ts (status, detection, history) · registry.ts · discovery.ts · tmux.ts
         terminal.ts · peers.ts · push.ts · files.ts · git.ts · procs.ts · config.ts
web/     React + xterm.js: Inbox, Session, History, Files, Git, Composer, Switcher, …
bin/     ah.js + cli.js (CLI) · ah-hook.js (agent hooks → tmux window options)
```

See [BACKLOG.md](BACKLOG.md) for what's done, what isn't, and the design decisions.
