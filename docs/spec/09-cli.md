# 09 · CLI

`ah <command>` (`bin/ah.js`, `bin/cli.js`): another view over the local daemon,
authenticated by the 0600 `local-token` the server writes. It is also how
agents drive agents (`ah send reviewer "…" && ah wait reviewer && ah read
reviewer`). Global `--host <peer>` (or `AH_TARGET_HOST`) routes any command
through `/h/<peer>/…` to a trusted peer host. Inside an `ah` session, the CLI
automatically sends `X-AH-Session: <uid>` so the audit log attributes every
cross-session action and external guardrails apply. `<target>` is `self` (the
session running the command, via `AH_SESSION_UID` or tmux `@ah-uid`), a session
id, a window id (`@12`), a title or a window name, or the start of one (titles
first; an ambiguous one is refused, never guessed), or a session's link as Copy
Link makes it (`https://…/#<uid>`; another host's is refused: run it there).
`ah list` shows titles and the shared status words. Most commands accept `--json`
for structured scripting and orchestration.

A session's link in a message sent to an agent (it can't open the link, which
is behind a sign-in) gets a line after the message: `[ah: <link> is the ah
session "<title>". Print its conversation with: ah conversation <uid>]`, with
the full path to `bin/ah.js` when `ah` isn't on PATH. Transcripts are read back
without that line, so lists, bubbles and delivery see the message as typed.

| Command | Does | Web equivalent |
|---|---|---|
| `serve [--port N]` | run the daemon on loopback (default) | — |
| `open [id\|name]` | open this tmux window, or that session, in ah's desktop window | — |
| `setup tailscale [--off]` | `tailscale serve` for ah, once | — |
| `setup desktop [--off]` | add ah to the app launcher | Settings → System → Desktop app |
| `list [--status S] [--agent A] [--space P] [--role R] [--managed-by TARGET] [--tag T] [--waiting\|--busy\|--idle] [--exclude-self] [--json]` | live sessions (with optional status/agent/space/supervision filters) | sidebar, Inbox |
| `show <target> [--json]` (also `inspect`, `status`) | full session state, supervision metadata, busy duration, permission mode + harness capabilities, queue, last reply and pending prompt | Session header, Inbox card |
| `whoami [--json]` | the current session's uid and state (when run inside an `ah` session) | — |
| `hosts [--json]` | configured peer hosts and their online/auth status | Host switcher |
| `harnesses [--json]` | configured harnesses, availability, permission modes (with canonical levels), models and capabilities | New session, Settings → Agents |
| `history [--json]` | ended and saved conversations | History |
| `new <agent> [--cwd] [--name] [--session] [--continue] [--worktree\|--no-worktree] [--mode] [--model] [--effort] [--trust] [--prompt] [--role R] [--managed-by TARGET] [--mute-alerts] [--escalate-after DUR] [--tag T] [--args] [--json]` | start a session (accepts harness mode ids or canonical levels `plan\|ask\|edits\|auto\|bypass` and optional supervision metadata) | New session |
| `attach <target>` | open a session in this terminal | — |
| `send <target> <text\|-> [--no-enter] [--id ID] [--now\|--urgent] [--wait [--timeout]] [--json]` (also `write`) | type now, queue if busy (or interrupt & send with `--now`), resume if ended; `--id` deduplicates retries | composer, Send now |
| `read <target> [-n LINES] [--screen] [--last] [--feed [--before SEQ]] [--conversation] [--json]` | the screen and scrollback, visible screen only, last reply, structured transcript feed, or portable conversation | Scrollback, GUI feed |
| `conversation <target\|link> [-n MESSAGES] [--json]` | what was said and what ran, oldest first, as text or JSON (the last 50; `-n 0` all); live or ended | the conversation |
| `watch [target…] [--events status,ask,reply,started,ended] [--once] [--timeout] [--json]` | stream live fleet events over SSE (`/api/events?delta=1`) | live state stream |
| `wait <target> [target…] [--until settled\|idle\|waiting\|ended\|any] [--timeout] [--no-grace] [--json]` | block over SSE until a session settles, needs input, or ends | — |
| `mode <target> [mode\|level] [--relaunch] [--json]` | inspect or change a session's permission level (harness id or `plan\|ask\|edits\|auto\|bypass`), live or via relaunch | Mode switcher |
| `switch <target> (--model M \| --effort E) [--relaunch] [--json]` | switch model or effort live (or relaunch with `--relaunch`) | Model / effort picker |
| `relaunch <target> [--mode M \| --model M \| --effort E] [--json]` | restart an idle session in the same conversation | Relaunch |
| `resume <target> [--json]` | bring a conversation back | Resume |
| `fork <target> [--name] [--prompt] [--mode] [--model] [--effort] [--json]` | fork into a new worktree | Fork session… |
| `continue <target> --in AGENT [--fork] [--worktree] [--name] [--preview] [--json]` | carry the conversation into another agent, with lineage (CND-2) | Continue in… |
| `portable <target> [--out FILE]` | the conversation as a portable document | — |
| `lineage <target> [--json]` | where the conversation came from and what came from it | the ↪ pill |
| `move <target> --to HOST [--cwd DIR] [--preview] [--yes] [--json]` | move a stopped session to another host (CND-3) | History → Move |
| `migrations [--json]`, `migrations retry\|cancel <id>` | moves between hosts and how far they got | the Move dialog |
| `jobs [--json]` | scheduled work: next, running, waiting on you | Jobs |
| `usage [target] [--days N] [--by …] [--json]`, `usage limits`, `usage export [--json]` | host usage, per-session usage (`usage <target>`), estimates and limit windows (CND-6) | Usage |
| `recovery [target] [--retry\|--pause\|--resume\|--cancel] [--auto on\|off]` | limits, provider errors, crashes, and what ah does about them (CND-5) | the ↻ pill, session menu |
| `restore [target \| --all \| --incident ID] [--no-note] [--dismiss]` | sessions cut off by a tmux stop, a host restart or a closed window: list, restore (mid-turn first, told where they stopped), dismiss (CND-8) | the Interrupted card, History → Restore |
| `job add --name N (--launch … \| --send … \| --decide --title …) [trigger] [policy] [--json]` | schedule agent work, interval heartbeats (`--every`), fleet session watches (`--when-waiting\|--when-idle\|--when-ended\|--when-stalled TARGET\|* [--after DUR] [--repeat]`), overlap watches (`--when-overlap [REPO]`), or user decisions (CND-4) | Jobs → New job |
| `job edit <id> …`, `job show\|pause\|resume\|cancel\|run <id> [--json]`, `job decide <run> yes\|no`, `job resolve <run> resend\|leave` | inspect, edit, control and answer jobs and runs | Jobs, Inbox |
| `heartbeat <target> --every <dur> [--text "…"] [--allow-busy] [--wake-ended] [--json]`, `heartbeat list\|stop\|pause\|resume` | periodic heartbeat wakes on a session (skips if busy or ended by default) | Jobs |
| `wake <target> (--in \| --at \| --every \| --cron \| --when-idle \| --when-waiting \| --when-ended \| --when-stalled TARGET\|* [--after DUR] \| --when-overlap [REPO]) [--repeat] [--text "…"] [--json]` | schedule a wake message to a session on time, fleet events, stalls or checkout overlaps | Jobs |
| `supervise <target> [--role chief\|worker\|reviewer\|none] [--managed-by TARGET\|none] [--mute\|--unmute] [--escalate-after DUR] [--tag T] [--clear-tags] [--json]` | set supervision role, owner, fail-open alert muting and tags on a session | — |
| `audit [--session TARGET] [--event NAME] [-n N] [--json]` | inspect recent audited host and cross-session actions (with `actorUid` attribution) | Security → Activity |
| `mail send <target\|siblings\|*> <body\|-> [--subject S] [--kind message\|directive\|report\|blocker\|handoff] [--thread ID] [--wake]`, `mail broadcast <body\|-> [--fleet]`, `mail inbox [target\|*] [--all]`, `mail show\|ack\|delete <id>` | durable cross-session asynchronous mailbox (SQLite-backed; enforces unidirectional hierarchy: child sessions communicate up or broadcast to siblings) | — |
| `tasks [--status S] [--assigned TARGET] [--owner TARGET] [--space P] [--json]`, `task add\|show\|update\|delete …` | durable fleet task ledger (status, priority, assignee, dependencies, verification command & result) | — |
| `diff <target> [--file PATH] [--all] [--json]` (also `changes`) | git status, changed files and diff in a session's workspace | Changes drawer |
| `branches <target> [--json]` | git branches in a session's workspace | Branch picker |
| `pr <target> [--json]` | open pull request for a session's branch (via `gh`) | PR pill |
| `terminal <target> [--open\|--close\|--send CMD\|--read\|--resize C R] [--json]` | manage and inspect a session's attached sidecar terminal | Sidecar terminal |
| `verify <target> <command…> [--timeout S] [--task TASK_ID] [--json]` | run a verification command in a session's sidecar terminal, capture exit code & output, and optionally record it on a fleet task | Sidecar terminal |
| `subagents <target> [--tree\|--read CHILD_REF] [--json]` | list subagent tree or read a subagent's transcript | Subagents drawer |
| `spaces [--json]`, `space new\|chief\|show\|prefs\|memory\|remove\|restore …` | inspect and manage Spaces, launch a Space Chief of Staff (`space chief <space> [--adopt] [--global]`), preferences and memory | Space Portal, Spaces |
| `notes [--space SPACE] [--json]`, `note show\|new [--space SPACE]\|edit\|handoff\|export\|delete …` | inspect, edit, export and hand off scratchpad notes (global or scoped to a Space) | Space Portal → Notes, Notes |
| `search <query> [--all] [--host H] [--space P] [--role R] [--in transcripts\|chats] [--lineage REF] [-n N] [--json]` | full-text search across transcripts and chats (local or all peers) | Search |
| `answer <target> (<yes\|no\|N\|KEY> \| --pick I[,I] \| --answers JSON \| --text "…" \| --chat \| --gate-text "…" \| --gate-back \| --gate-callback URL) [--prompt ASK_ID] [--json]` | answer any prompt: approve/deny, picker (digit, hotkey or cursor), question dialog, gate, or free text | the ask's options / dialog / gate |
| `forward <target> [--title "…"] [--note "…"] [--decide [--then-send TARGET TEXT]] [--wait [--timeout]] [--json]` | forward a session's live prompt to the user's devices (push + lock-screen actions, or Inbox decision card with `--decide`) | Push alert, Inbox |
| `decide --title "…" [--body "…"] [--then-send … \| --then-launch …] [--wait [--timeout]] [--json]` | ask the user for a decision in Inbox + push, optionally waiting for their answer | Inbox → Needs you |
| `stop <target> [--json]` (also `interrupt`) | stop / interrupt the agent's current turn | Stop |
| `terminate <target> [--json]` (also `kill`) | end the session; the conversation stays in History | Terminate session |
| `forget <target> [--json]` | remove an ended session from History | Forget |
| `rename <target> <name…> [--json]` | rename the session | Rename session |
| `pin <target> [--off] [--json]` | pin to the top of its group, or unpin | Pin |
| `queue <target> [--unsent] [--clear \| --remove ID \| --send-now ID \| --move ID POS] [--json]` | inspect, reorder, drop, or send queued messages now | Queue panel |
| `worktrees [--json] [--orphans]`, `worktrees clean --orphans [--force-dirty] [--yes]` | managed worktrees, sizes, clean-up (dry run unless `--yes`) | Worktrees |
| `snapshots <target>` | per-turn snapshots | Snapshots panel |
| `rollback <target> --to TURN [--interrupt]` | restore files to before a turn | Restore |
| `hooks install\|uninstall\|status` | wire agent status hooks | Settings → System → Agent hooks |
| `auth code` | one-time setup code | Security → Add a device |
| `auth password [--remove]` | master password | — (host only, by design) |
| `auth token <name>` | token for another host | — |
| `auth status` | passkeys, devices, activity | Security |
| `peers trust <peer> <token>` | use a peer's token | — |

