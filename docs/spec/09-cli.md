# 09 · CLI

`ah <command>` (`bin/ah.js`, `bin/cli.js`): another view over the local daemon,
authenticated by the 0600 `local-token` the server writes. It is also how
agents drive agents (`ah send reviewer "…" && ah wait reviewer && ah read
reviewer`). `<target>` is a session id, a window id (`@12`), a name, or the
start of a history title.

| Command | Does | Web equivalent |
|---|---|---|
| `serve [--port N]` | run the daemon on loopback (default) | — |
| `open [id\|name]` | open this tmux window, or that session, in ah's desktop window | — |
| `setup tailscale [--off]` | `tailscale serve` for ah, once | — |
| `setup desktop [--off]` | add ah to the app launcher | Settings → System → Desktop app |
| `list [--json]` | live sessions | sidebar, Inbox |
| `history [--json]` | ended and saved conversations | History |
| `new <agent> [--cwd] [--name] [--session] [--continue] [--mode] [--model] [--args]` | start a session | New session |
| `attach <target>` | open a session in this terminal | — |
| `send <target> <text\|-> [--no-enter]` | type now, queue if busy, resume if ended | composer |
| `read <target> [-n LINES]` | the screen and scrollback | Scrollback as text |
| `wait <target> [--timeout]` | block until the agent stops working | — |
| `resume <target>` | bring a conversation back | Resume |
| `fork <target> [--name] [--prompt]` | fork into a new worktree | Fork session… |
| `queue <target> [--clear]` | show or drop queued messages | Queue panel |
| `worktrees [--json] [--orphans]`, `worktrees clean --orphans [--force-dirty] [--yes]` | managed worktrees, sizes, clean-up (dry run unless `--yes`) | Worktrees |
| `snapshots <target>` | per-turn snapshots | Snapshots panel |
| `rollback <target> --to TURN [--interrupt]` | restore files to before a turn | Restore |
| `hooks install\|uninstall\|status` | wire agent status hooks | Settings → System → Agent hooks |
| `auth code` | one-time setup code | Security → Add a device |
| `auth password [--remove]` | master password | — (host only, by design) |
| `auth token <name>` | token for another host | — |
| `auth status` | passkeys, devices, activity | Security |
| `peers trust <peer> <token>` | use a peer's token | — |

→ A-09: the CLI can't answer a prompt, stop a turn, terminate, rename or pin,
which an agent driving another agent needs.
