# 17 · Spaces (`SPC`)

A Space is where sessions belong: a repository, a folder, or a plain Space that is
nothing but a place for conversations to share preferences, a memory and a history.
Asked for by the owner on 21 November 2026 ("an option to delete old spaces from there,
and also create projects that are not repo based, basically a collection of sessions
with shared memory, preferences and history"), after the Inbox's menu filled with probe
folders and worktrees that no longer existed.

Every project the Inbox's menu lists is a Space; there is one word for it. Three kinds:

| Kind | What it is | Preferences and memory |
|---|---|---|
| `space` | A folder ah made in the Spaces folder (`~/spaces/<name>` unless `spaces.root` says otherwise), with no repository | ah's: `AGENTS.md`, `memory/`, and `artifacts/` in the Space folder (SPC-3, SPC-4) |
| `repo` | A git checkout's root (a worktree belongs to its repository's Space) | The repository keeps its own files untouched; ah keeps Space-owned `AGENTS.md`, `memory/`, and `artifacts/` under `~/.local/state/ah/spaces/<id>/` (`spaces` 2) |
| `folder` | Any other folder sessions ran in (`~`, `~/Work`, `~/.config`) | Space-owned `AGENTS.md`, `memory/`, and `artifacts/` under `~/.local/state/ah/spaces/<id>/` (`spaces` 2) |

A Space is named as the Inbox names a project: the repository's name, else the folder's
(`Home` for `~`). Within one host, the name is the Space's identity; another host's Space
of the same name is another Space (the Inbox shows the host beside it). With `spaces` 2,
each Space also gets a stable server-side `id` (`sp-xxxxxxxx`), optional explicit session
membership (`PUT /api/sessions/:uid/space` / `POST /api/windows` `space`) so sessions in
different folders or repos can reside in one virtual Space, Space-owned context (`contextPath`)
for all Space kinds, knowledge promotion (`POST /api/spaces/:name/knowledge/promote`), and
server-generated Chief kickoff briefs (`GET /api/spaces/:name/brief`).

The routes follow the conductor's contract rules ([13](13-conductor.md#contract-rules-all-of-cnd)):
`api` stays 28, the capability is `spaces` in `features`, errors are `{ error, code? }`,
every route is behind sign-in. A host without `spaces` still has projects in the Inbox's
menu, made from its sessions and History; a client offers none of the below.

| Feature | Version | Routes |
|---|---|---|
| `spaces` | 1 | `GET`/`POST /api/spaces`, `POST /api/spaces/remove`, `POST /api/spaces/restore`, `GET`/`PUT /api/spaces/:name/preferences`, `GET /api/spaces/:name/memory`, `PUT`/`DELETE /api/spaces/:name/memory/:file` |
| `spaces` | 2 | Adds `PUT /api/sessions/:uid/space`, `POST /api/spaces/:name/knowledge/promote`, `GET /api/spaces/:name/brief`, `GET /api/spaces/:name/context`, Space-owned `contextPath` for all Space kinds, stable `id` & `roots`, optimistic concurrency (`expectedUpdatedAt` → `409 space_conflict`), and automatic harness Space context & artifacts injection |

## SPC-1 The list

`GET /api/spaces` answers `{ root, spaces, removed }`:

- `root`: the Spaces folder, as a short path (`~/spaces`).
- `spaces`: every Space with something in it — a live session, a conversation in History —
  and every plain Space in the Spaces folder, empty or not, sorted by name. Each is
  `{ name, kind, path, exists, live, conversations, lastActivityAt }`: `path` its folder
  (short; `null` when no session says where it is), `exists` whether that folder is there
  now, `live` its running sessions, `conversations` its History, `lastActivityAt` seconds
  (0 for an empty Space).
- `removed`: the Spaces taken off the list (SPC-5), newest first, each
  `{ name, kind, path, removedAt, conversations, archived }`.

## SPC-2 A new Space

`POST /api/spaces` `{ name, preferences? }` makes `<root>/<name>` and answers **201**
`{ space }`. A name is 1–64 characters of letters, digits, spaces, `.`, `_` and `-`, not
starting with `.` or a space and not ending with a space (`invalid_space_name`, 400). A name
that is already a Space on this host (whatever its case), a removed Space's (restore it
instead), or a folder already in the Spaces folder is **409 `space_exists`**.

The folder gets four files, so every agent reads the same preferences and keeps the same
memory without ah in the middle:

- `AGENTS.md`: the Space's preferences (SPC-3): `preferences` if given, else a starting
  text that says what the Space is for and how its memory works.
- `CLAUDE.md` and `GEMINI.md`: `@AGENTS.md`, so Claude Code and Gemini (agy) read it too.
- `memory/MEMORY.md`: the memory's index (SPC-4).

It's a plain folder: New session offers it like any project (the Spaces folder is one of
the project roots), and its sessions are the Space's history.

## SPC-3 Preferences

`GET /api/spaces/:name/preferences` answers `{ text, file: "AGENTS.md", updatedAt }`;
`PUT` `{ text, expectedUpdatedAt? }` writes the whole file (at most 65 536 characters, else
**413 `preferences_too_long`**; stale `expectedUpdatedAt` returns **409 `space_conflict`**)
and answers the same. A session already running reads it again when its agent does (most
read instructions when a conversation starts or compacts).

With `spaces` 2, every Space kind (`space`, `repo`, `folder`) has ah-managed preferences:
plain Spaces store them in `<space>/AGENTS.md`; repositories and folders store them in
Space-owned context (`~/.local/state/ah/spaces/<id>/AGENTS.md`) so the repository's own
files remain untouched. A name that is no Space: **404 `space_not_found`**.

## SPC-4 Memory

The memory is Markdown files in `memory/`, written by the agents (the starting
`AGENTS.md` tells them to read `memory/MEMORY.md` first and keep durable facts there, one
topic a file, never a secret) and by the person.

- `GET /api/spaces/:name/memory` answers `{ files }`: each `.md` file in `memory/` as
  `{ name, text, bytes, updatedAt }`, `MEMORY.md` first then by name, at most 200 files;
  a file over 262 144 bytes comes back cut to that, with `truncated: true`.
- `PUT /api/spaces/:name/memory/:file` `{ text, expectedUpdatedAt? }` writes one (at most
  262 144 characters, **413 `memory_too_long`**; stale `expectedUpdatedAt` returns **409
  `space_conflict`**); `DELETE` removes one (`MEMORY.md` can't be removed: **409
  `memory_index`**). A file name is 1–80 letters, digits, `.`, `_`, `-`, ending in `.md`
  (`invalid_memory_file`, 400); one that isn't there to remove is **404 `memory_not_found`**.

With `spaces` 2, all Space kinds support Space-owned memory (stored outside git for
repositories and folders, just like preferences).

## SPC-5 Removing and restoring

`POST /api/spaces/remove` `{ name }` takes a Space off the Inbox's menu, New session's
folders and the list, and its conversations out of History. Nothing is deleted:

- Its conversations are hidden, not forgotten: a transcript stays on disk, an ended
  session's record stays in the registry. The removal keeps which conversations it hid.
- A plain Space's folder moves to `<root>/.archive/<name>` (`<name> 2`, `<name> 3`… when
  that's taken), files and memory with it.
- A repository or a folder is never touched.

A Space with a running session is **409 `space_busy`** (end them first). The answer is
`{ removed }`, as listed in SPC-1.

`POST /api/spaces/restore` `{ name }` puts it back and answers `{ space }` (`null` when
nothing is left to list: a folder Space with no conversations): its conversations return to History,
a plain Space's folder comes back from the archive (**409 `space_exists`** if a folder of
that name was made since). Not removed: **404 `space_not_found`**.

A removed Space comes back by itself when it's used again: a session starts in its folder
(at or after the removal), or a conversation appears in it that the removal didn't hide.
Its hidden conversations come back with it. Removing hides what was there; it doesn't stop
the Space from being used.

Removals are kept in `spaces.json` beside the registry (`~/.local/state/ah`).

## SPC-6 The clients

- **The Inbox's menu** lists Spaces (an empty plain Space too) and ends with **New
  Space…** (a name, optional preferences, then the new Space is the one shown) and, with a
  Space shown, **Space settings…**.
- **Space settings** (web: a dialog; app: a sheet): the Space's name, kind and folder, its
  live sessions and conversations; for a plain Space, Preferences (the text of `AGENTS.md`,
  saved on demand) and Memory (each file, opened, edited or deleted); **Remove Space…**
  with what it does and doesn't touch, said before it does it.
- **Space Portal** (web and native iOS/iPad/Mac): selecting a Space in the Inbox enters
  that Space's workspace portal with tabs for **Sessions** (including its Chief(s) of Staff
  strip, active Chief Wakes pills with pause/resume, one-click *Start Chief of Staff* with
  optional adoption of existing unmanaged sessions and unidirectional `Chief > worker`
  control), **Notes** (filtered to this Space; *New note* files automatically under the
  Space, can hand off directly to its Chief of Staff, and can promote to Space Knowledge),
  **Files & Artifacts** (rooted at the Space's folder when present, with upload, hidden-file
  toggle, send-to-Chief, and quick jumps to `artifacts/` and `memory/`), **Tasks**
  (Space-scoped fleet task ledger with reassignment and status controls), and **Knowledge**
  (inline `AGENTS.md` and `memory/` for all Space kinds on `spaces` 2 hosts), plus a
  **Context** inspector showing the live bundle injected into harnesses. One Chief of Staff
  per Space is the default, not a restriction—multiple Chiefs per Space or fleet-wide Chiefs
  work too.
- **Session mentions & Chief sub-sessions** (web and native): typing `#` in a chat composer
  autocompletes live sessions (ranking managed sub-sessions and same-Space sessions first)
  and inserts `#<uid> `; full session URLs, `#<uid>`, and bare `<uid>` render as clickable
  session-name chips and expand on send into a session reference for the agent. Chief
  sessions show their managed sub-sessions bar directly above the transcript.
- **Settings → Spaces**: the Spaces folder and the removed Spaces, each with **Restore**.
- **New session** offers plain Spaces among the projects; the Spaces folder is a root.

## SPC-7 Harness context & artifacts injection

Every session started, resumed, or forked in a Space automatically receives access to that Space's
preferences (`AGENTS.md`), shared memory (`memory/`), artifacts (`artifacts/`), and Space notes
without modifying any git repository:

- **Context bundle:** Before launch/resume/fork (and whenever preferences or memory change), ah
  writes `<contextDir>/.ah-space-context.md` (alongside `CLAUDE.md` and `GEMINI.md` pointing at
  `@AGENTS.md` inside `contextDir`).
- **Environment variables:** All harnesses receive `AH_PORT`, `AH_SPACE`, `AH_SPACE_DIR`,
  `AH_SPACE_MEMORY_DIR`, `AH_SPACE_ARTIFACTS_DIR`, `AH_SPACE_CONTEXT_FILE`, plus `AH_ROLE` and
  `AH_MANAGED_BY` when supervised.
- **Native CLI, MCP & hook injection:** Harnesses with verified flags receive
  `--add-dir <contextDir>` (`claude`, `codex`, `gemini`/`agy`, `grok`), a compact Space + role
  pointer (`claude` `--append-system-prompt`, `codex` `-c developer_instructions=...`, `grok`
  `--rules`), and Agent House's built-in stdio MCP server (`node bin/ah.js mcp`) with role-scoped
  tools (`claude` `--mcp-config` + `--allowedTools mcp__ah__*`, `codex` `-c mcp_servers.ah.*`).
  Claude Code's `SessionStart` hook (`ah-hook.js`) additionally re-injects the role playbook and
  `AH_SPACE_CONTEXT_FILE` via `hookSpecificOutput.additionalContext` on start, resume, and
  compaction.
- **Auto-subscribed Space Chiefs:** Starting a Chief of Staff in a Space automatically registers
  Space-scoped event-wake jobs (`waiting` and finished turns, `ifLive: true`, excluding the Chief
  itself), rekeyed across relaunches and cancelled automatically when the Chief ends.
- **API & CLI:** `GET /api/spaces/:name/context` returns the full bundle (preferences, memory
  index/entries, artifacts inventory, Space notes, paths, and rendered markdown). Agents and users
  can also run `ah space context [space]`, `ah space artifacts [space]`, and
  `ah space artifacts add <file> [space]` (defaulting to `$AH_SPACE`).

## Wording

*Space* replaces *project* (README's vocabulary) everywhere a person reads it: the Inbox's
menu and its Space grouping, New session's Space field and New Space, the sidebar's Spaces,
a note's Space, Run in Space, Review's Start from a Space, Settings, the CLI's SPACE
column. What programs read keeps its name, so installed apps and scripts go on working:
the API's `project` fields, `/api/projects`, the `new-project` command id, the switcher's
`p:` token.

## Not yet in scope

Renaming a Space, a Space spanning multiple hosts, and full-text memory search.
