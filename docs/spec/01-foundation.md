# 01 · Foundation

What every surface stands on: the daemon, how sessions are known, and how ah
decides what a session is doing.

## FND-1 · Host daemon — shipped

- One Node process per machine (`server/main.ts`), no build step, listening on
  `127.0.0.1` (or `::1`) only. No flag or config makes it listen elsewhere.
- A **ticker** (`Core.tick`, every 1.5 s) re-derives the whole state:
  tmux windows → session views → registry → history → queue delivery → push →
  subscribers. Clients get the full state once, then **patches of changed
  fields** over one SSE stream per host (`/api/events`).
- Restarting ah never touches a session. The tmux server is owned by
  `contrib/ah-tmux.service` (`exit-empty off`); ah also enforces that on boot.
- `API_VERSION` (now 23): a page newer than the running server shows a
  "restart ah" banner instead of misbehaving (CON-9).

## FND-2 · tmux as the source of truth — shipped

- Every process lives in a tmux window. ah's per-window metadata lives in
  tmux user options (`@ah-harness`, `@ah-harness-id`, `@ah-state`,
  `@ah-state-at`, `@ah-detail`, `@ah-ask`, `@ah-model`, `@ah-seen`).
- Each viewer is its own throwaway tmux session grouped with the target
  (`server/terminal.ts`), so devices look at different windows independently,
  and tmux reaps a viewer when its connection goes.
- **Multi-writer policy: last active wins.** `window-size latest` gives the
  window's size to whoever typed last. No locks or leases.

## FND-3 · Registry — shipped

Durable record of every session this host has run (`server/registry.ts`,
SQLite `ah.db` through Prisma, owner-only). Fields: uid, host, harness,
harnessId, cwd, model, title, status, lifecycle, created / lastActivity /
ended, tmux target, and `meta` (`ah.*` keys: order, pin, launch choices,
worktree, fork lineage, queue, known transcripts).

- **Register on sight.** Every window is registered the first time it is seen,
  including shells and windows ah did not start.
- A failed load stops ah rather than starting empty (an empty registry would
  re-register live windows under new uids).

## FND-4 · Session identity — shipped

- A session's key is its **uid** (8 hex chars locally, `host/uid` on a peer).
  It outlives the tmux window: resume, relaunch and a tmux restart keep it.
- Old links keyed on window ids (`@12`) are upgraded once the windows are
  known (`web/sessionKeys.ts`).
- The HTTP API names sessions by uid: `/api/sessions/:uid/…` (send, answer,
  queue, feed, diff as `changes`, `branches`, `pull`, `chat`, `capture`,
  `name`, `terminate`…). The server resolves the window the session has now;
  the older `/api/windows/@N/…` routes stay as aliases for scripts.

## FND-5 · Conversation identity — shipped

- A conversation's key is `harness:harnessId`, the agent's own id.
- Hooks report the id (Claude Code, Codex). Resume and fork pass it
  explicitly. A session ah launched snapshots the ids known at launch
  (`ah.knownTranscripts`) and adopts only a **novel, unowned** id; never by
  recency, never by cwd. Windows ah did not launch fall back to recency.
- Transcripts, side chats and the queue attach to the conversation, and move
  with it when it is adopted or resumed under a new uid. Forks get a new id.

## FND-6 · Lifecycle — shipped

`starting → live → ended`, plus `unavailable` (its host is offline), with
`pendingResume` as an orthogonal flag. "Saved" is not a lifecycle state: it is
a conversation found on disk with no record (FND-11).

- An ended session keeps its harness id, cwd, title, pin, order and launch
  choices, and stays where it was in every list (CON-2).
- `exitCode` is always null: tmux does not keep it without `remain-on-exit`.

## FND-7 · Status detection — shipped (partial for F18/F20)

Sources, strongest first; each session records which it used (`statusSource`):

1. **Hooks** (`hook`): `@ah-state` written by `bin/ah-hook.js` — `working`,
   `waiting`, `done`, `idle`, `ended`. A Claude question dialog counts as
   waiting only while its dialog is on screen.
2. **Screen rules** (`screen`): per-preset `waitingPatterns` (permission
   prompts, question dialogs, cursor pickers, usage-limit notices).
3. **Activity** (`activity`): output in the last `idleAfter` seconds (4), or a
   live tool shell below the agent, means working.

Then:

- **Unread:** a session that finished while nobody was viewing it is
  `attention` (shown as `done` / `new output`) until a device views it.
  Viewing sets `@ah-seen`.
- **Usage limit:** Claude's session/weekly and Codex's usage-limit notices
  make a stopped session `limited`, with the reset time, until that time
  passes.
- **Needs you is conservative:** only permission and question prompts.
  Idle nags and anything unknown read as done. No model classifier.
- **Background work:** a silent command in a tool shell keeps the agent
  working; a persistent service on its own does not. (partial: commands that
  replace their tool shell rely on hooks/activity)
- **Screen-rule audit:** while hooks run, every prompt a hook reports also
  tests the screen rules; misses are kept per harness with the last missed
  screen (Settings → System). (partial: no scheduled audit)

## FND-8 · Status vocabulary — shipped

One mapping, `web/status.ts`, used by rows, pills, headers, sections,
taglines, the switcher and notifications:

| Internal | Shown | Colour role | Sort |
|---|---|---|---|
| `waiting` | **needs you** | accent (pink) | 1 |
| `busy` | **working** | info (cyan) | 3 |
| `attention`, agent | **done** | success | 2 |
| `attention`, shell | **new output** | success | 2 |
| `idle` | **idle** | none | 4 |
| any stopped + limit | **limited** | warning | 2 |

Tagline: one count per word, in this order: "2 sessions need you. 2 working.
1 limited. 1 done. 3 idle." or "All quiet."

## FND-9 · What a session is doing — shipped

Every live session carries one line of **detail** (hook activity such as
"Editing src/x.ts" or "$ pnpm test", else the last meaningful line on
screen; for an idle shell, the command it last ran) and, when waiting, an
**ask**:

| `ask.kind` | Source | Rendered as |
|---|---|---|
| `command` | Bash permission (hook or screen) | the command, then the picker's options |
| `tool` | another tool's permission | the tool in words, then options |
| `choice` | Claude's AskUserQuestion | a form: questions, options, free text |
| `question` | an elicitation | the question, Reply |
| `screen` | anything else read off the screen | the screen text, unwrapped |

`answerable` is true when one-tap Approve/Deny applies (a permission prompt
with known keys).

## FND-10 · Agents (harnesses and presets) — shipped

- A **preset** describes how to run an agent: `command`, `resume`
  (continue last), `resumeId` (`claude --resume {id}`), `match` (detection
  regex on the process), `waitingPatterns`, `approveKeys` / `denyKeys`,
  modes, models, effort flags, and `feed` (GUI adapter).
- Built in: Shell, Claude Code, Codex, Gemini, Grok, Muse, Hermes, opencode,
  Cursor Agent, Copilot, Crush, pi. Presets whose command is not on tmux's
  PATH are hidden. Hosts can hide any agent and add any CLI (SET-5).
- **Detection:** the window's process tree (`/proc`), so `node …/claude`
  reads as Claude; agents that `exec` over their shell are still found.
- **Settings follow the CLI** (`server/harnesses.ts`): each installed CLI's
  `--version` is checked at start and hourly; a new version's `--help` is read
  and its mode and effort choices replace the written ones.
- **Live model catalogs** (`server/catalog.ts`): each agent's models and
  configured defaults, read from the CLI's own files and commands.
- **Transcript adapters** (`server/feed/adapters`): Claude Code, Codex,
  Gemini, Grok, Muse, opencode, Hermes. Cursor, Copilot, Crush and pi are
  terminal-only (no GUI).

## FND-11 · Discovery — shipped

`server/discovery.ts` reads each agent's on-disk store for past conversations
(title, cwd, model; ~20 ms cold, cached per file), so a conversation ah never
started, or whose record is gone, still appears in History and resumes.

## FND-12 · Hooks — shipped

`ah hooks install` (or Settings → System) adds Claude Code hook entries and
Codex's notify program, each pointing at `bin/ah-hook.js`; backs both files up,
touches only its own entries. The hook writes state, conversation id, model,
what the agent is doing, and what it is blocked on into the window's options.
It works with ah down and never fails loudly. Any CLI can report:
`ah-hook.js <preset> <working|waiting|done> [id]`.

## FND-13 · Hosts — shipped (F31 open)

- Every machine runs the same daemon. The one you open (the hub) proxies the
  others under `/h/<host>/`; the browser talks to one origin.
- `peers`: `[]`, a list of `{ name, url }` (https only), or `"auto"` (your own
  online tailnet machines running ah).
- Peers trust with revocable tokens: `ah auth token <hub>` on the peer,
  `ah peers trust <peer> <token>` on the hub.
- The Inbox, sidebar, switcher and History merge every host; keys are
  `host/uid` for peers.
- Open: resuming a conversation on another host, and moving a session between
  hosts (F7, F31).

## FND-14 · Configuration and state — shipped

- `~/.config/ah/config.json`: port, host (loopback only), defaultSession,
  projectRoots, spaces.root, peers, auth, files.roots, promptHistory, idleAfter,
  preview.ports, presets.
- `~/.local/state/ah/` (owner-only): `ah.db` (registry, prompts, chats,
  subscriptions, environment, snapshots index, search index), `auth.json`,
  `local-token`, `peer-tokens.json`, `push.json`, `vapid.json`, `drafts.json`,
  `harnesses.json`, `hidden.json`, `spaces.json` (removed Spaces), `audit.log`.
- `~/.cache/ah/uploads/`: files sent from devices.

## FND-15 · Security — shipped

Summarised here, specified in [SECURITY.md](../../SECURITY.md):
loopback only; Tailscale Serve (never Funnel) with the owner's identity
required; passkeys per device, setup codes from the host, optional master
password; HttpOnly `__Host-` cookies (24 h idle, 30 days max); Origin + `X-AH`
on writes; strict CSP; files confined to `files.roots`; audit log; sessions
start only from presets.
