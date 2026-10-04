# ah — agent hub

A web control plane for persistent tmux shells and coding-agent sessions.
**tmux owns the processes; ah owns the experience.**

Start a Claude Code / Codex / Muse / shell session from your desktop, pick it up on your
iPad, answer a permission prompt from your phone. Everything runs on one machine, inside
tmux, reachable only over your tailnet.

```
phone / iPad / laptop ──https (tailscale serve)──▶ ah (127.0.0.1:7681) ──pty──▶ tmux attach ──▶ agents
```

## Run it

```bash
pnpm install          # builds node-pty (needs gcc/make/python3)
pnpm build            # builds the web UI into dist/
pnpm start            # → http://127.0.0.1:7681
tailscale serve --bg 7681   # HTTPS on https://<machine>.<tailnet>.ts.net, tailnet-only
```

Then open `https://<machine>.<tailnet>.ts.net` on any device. The first `tailscale serve`
asks you to enable Serve/HTTPS for the tailnet once, via a login.tailscale.com link.

No `tailscale serve`? Listen on the Tailscale IP directly (plain HTTP inside WireGuard;
clipboard, notifications and home-screen install need HTTPS, though):

```bash
pnpm start --host 127.0.0.1,tailscale     # → http://100.x.y.z:7681 (note: http, not https)
``` On iOS, use Share → Add to Home
Screen for a full-screen app (and notifications).

Keep it running with the systemd user unit in [`contrib/ah.service`](contrib/ah.service).

Development: `pnpm dev` (server with `--watch` + Vite on :5173, proxied).

### Agent status hooks (recommended)

```bash
node bin/ah.js hooks install    # Claude Code hooks + Codex notify; backs up both files
node bin/ah.js hooks status
node bin/ah.js hooks uninstall
```

Without hooks, status is inferred from terminal activity. With them you get exact
**working / waiting for you / done** states, plus each conversation's native id, which is
what makes resume exact.

## What it does

- **Sidebar** of every tmux window, grouped by git project or by tmux session, with the
  agent detected from the process tree (node-based CLIs included).
- **Status**: working (pulsing), waiting for you (ringing), finished since you last looked
  (amber), quiet. Browser notifications when something needs you.
- **Live terminal** in the browser. Each device gets its own grouped tmux session, so
  your phone and laptop can look at different windows at once. Whoever typed last decides
  the window size (`window-size latest`).
- **New session**: pick an agent preset, a directory, a name and a tmux session. Optionally
  continue the last conversation in that directory.
- **Ended sessions**: every agent session goes in a registry
  (`~/.local/state/ah/sessions.json`). When its window dies (or tmux does, e.g. after a
  reboot), it appears under *ended* with **Resume**, which runs the harness's own resume
  (`claude --resume <id>`, `codex resume <id>`) in the original directory.
- **Phone/iPad**: sticky Ctrl/Alt key bar, swipe to scroll tmux history, a **Compose** box
  (dictation, autocorrect, multi-line prompts sent as one bracketed paste), **Text** view
  of the scrollback for native selection/copy, and file upload: paste, drop or attach an
  image and its path on the host is typed in for the agent.
- **⌘K / Ctrl+Shift+K** quick switcher.
- If ah crashes or restarts, nothing is lost: `tmux ls` still has everything.

## Security model

Opening ah is equivalent to having a shell as your user. The design leans on Tailscale
rather than home-grown auth:

- Binds to `127.0.0.1` by default and refuses `0.0.0.0` unless forced. Expose it with
  `tailscale serve` (tailnet-only HTTPS). **Never use Tailscale Funnel.**
- Host header allowlist (localhost, this hostname, its Tailscale name and IPs) against
  DNS rebinding.
- WebSocket and mutating requests require an allowlisted `Origin`. Mutations also need an
  `X-AH` header, which can't be sent cross-site without a CORS preflight that ah never
  approves.
- No generic "run command" endpoint: sessions start only from configured presets.
- Strict CSP, an audit log of create/kill/resume/upload on stdout (with the Tailscale
  login when behind `tailscale serve`), and uploads are written `0600`.

Restrict which of your devices can reach the port with Tailscale ACLs if needed.

## Configuration

`~/.config/ah/config.json` (all optional):

```json
{
  "port": 7681,
  "host": "127.0.0.1",
  "defaultSession": "agents",
  "projectRoots": ["~/code"],
  "allowedHosts": [],
  "idleAfter": 4,
  "presets": [
    { "id": "shell", "name": "Shell", "command": "" },
    { "id": "claude", "name": "Claude Code", "command": "claude",
      "resume": "claude --continue", "resumeId": "claude --resume {id}", "match": "^claude$" },
    { "id": "codex", "name": "Codex", "command": "codex",
      "resume": "codex resume --last", "resumeId": "codex resume {id}", "match": "^codex" }
  ]
}
```

`match` is tested against the basenames of `argv[0]`/`argv[1]` of processes under each pane.
Presets whose command isn't on tmux's `PATH` are hidden. Any CLI can report status with
`bin/ah-hook.js <preset-id> <working|waiting|done> [session-id]`.

## Layout

```
server/   main.ts (HTTP + WS, security) · tmux.ts · sessions.ts (status, detection)
          terminal.ts (pty ⇄ websocket) · registry.ts · procs.ts · config.ts
web/      React + xterm.js UI
bin/      ah.js (CLI) · ah-hook.js (agent hooks → tmux window options)
```

## Roadmap

- Multi-machine: a tiny daemon per host connecting out to a hub, one sidebar for all.
- Web Push, so notifications arrive with the tab closed.
- Git status/diff and a file browser per project.
- Splits / multiple terminals side by side.
