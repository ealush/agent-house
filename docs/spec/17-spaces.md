# 17 · Spaces (`SPC`)

A Space is a place sessions belong to: a collection of conversations, from any number of
projects, sharing preferences, a memory, artifacts, a history and (optionally) a Chief of
Staff. Asked for by the owner on 21 November 2026 ("an option to delete old spaces from there,
and also create projects that are not repo based, basically a collection of sessions
with shared memory, preferences and history"), after the Inbox's menu filled with probe
folders and worktrees that no longer existed.

Revised on 24 November 2026 (`spaces` 3), asked for by the owner: "Spaces are like their own
place, like a virtual folder or virtual space. They should not be tied to a given work tree,
and they can combine multiple sessions from multiple projects. They should not be bound to a
given GitHub repository or to a given folder." So:

- **A Space is one you made** (New Space…): a folder in the Spaces folder (`~/spaces/<name>`
  unless `spaces.root` says otherwise) holding its preferences (`AGENTS.md`), its memory
  (`memory/`) and its deliverables (`artifacts/`). A repository or a folder is a **project**,
  never a Space; a worktree is its repository's project (`.worktrees/<repo>/<slug>` reads as
  `<repo>`), and so is a worktree that's gone.
- **Projects attach to a Space** (SPC-8): a session started in an attached project is in that
  Space. A project is attached to one Space at most.
- **A session can be put in any Space by hand** (New session's Space, Move to Space…), which
  wins over its project's; or taken out of every Space. A session in no Space is listed under
  *Not in a Space*.
- Within one host, the name is the Space's identity; another host's Space of the same name is
  another Space (the Inbox shows the host beside it). Each Space also has a stable `id`
  (`sp-xxxxxxxx`).

The state's `space` on a session (and on a History entry) is the Space it is in, worked out by
the host: the one it was put in, else its project's, else absent. A client never falls back
to the session's `project` for this on a `spaces` 3 host (an older host sends `space` only for
a session put in one, and its clients grouped the rest by `project`).

The routes follow the conductor's contract rules ([13](13-conductor.md#contract-rules-all-of-cnd)):
`api` stays 28, the capability is `spaces` in `features`, errors are `{ error, code? }`,
every route is behind sign-in. A host without `spaces` still has projects in the Inbox's
menu, made from its sessions and History; a client offers none of the below.

| Feature | Version | Routes |
|---|---|---|
| `spaces` | 1 | `GET`/`POST /api/spaces`, `POST /api/spaces/remove`, `POST /api/spaces/restore`, `GET`/`PUT /api/spaces/:name/preferences`, `GET /api/spaces/:name/memory`, `PUT`/`DELETE /api/spaces/:name/memory/:file` |
| `spaces` | 2 | Adds `PUT /api/sessions/:uid/space`, `POST /api/spaces/:name/knowledge/promote`, `GET /api/spaces/:name/brief`, `GET /api/spaces/:name/context`, Space-owned `contextPath`, stable `id` & `roots`, optimistic concurrency (`expectedUpdatedAt` → `409 space_conflict`), and automatic harness Space context & artifacts injection |
| `spaces` | 3 | Only made Spaces are listed (a repository or folder is a project); `PUT /api/spaces/:name/projects` and `POST /api/spaces` `projects`; `space` on sessions and History is the Space each is in; `PUT /api/sessions/:uid/space` `''` takes a session out of every Space |

## SPC-1 The list

`GET /api/spaces` answers `{ root, spaces, removed }`:

- `root`: the Spaces folder, as a short path (`~/spaces`).
- `spaces`: every Space made in the Spaces folder (a folder there that is a git repository is a
  project, not a Space), empty or not, sorted by name. Each is `{ id, name, kind: "space",
  path, contextPath, projects, roots, exists, live, conversations, lastActivityAt }`: `path`
  its folder (short), `projects` the projects attached to it (SPC-8), `roots` the folders its
  sessions work in besides its own, `live` the sessions in it, `conversations` the History in
  it, `lastActivityAt` seconds (0 for an empty Space).
- `removed`: the Spaces taken off the list (SPC-5), newest first, each
  `{ name, kind, path, removedAt, conversations, archived }`.

## SPC-2 A new Space

`POST /api/spaces` `{ name, preferences?, projects? }` makes `<root>/<name>` (and attaches
`projects`, SPC-8) and answers **201**
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

A Space keeps them in `<space>/AGENTS.md`; a project's own files are never touched. A name
that is no Space: **404 `space_not_found`**.

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

A session in the Space reads them wherever it works: its harness gets `--add-dir` to the
Space's folder and the Space's pointer (SPC-7), so nothing is written into a project.

## SPC-5 Removing and restoring

`POST /api/spaces/remove` `{ name }` takes a Space off the Inbox's menu, New session's
folders and the list, and its conversations out of History. Nothing is deleted:

- Its conversations are hidden, not forgotten: a transcript stays on disk, an ended
  session's record stays in the registry. The removal keeps which conversations it hid.
- A plain Space's folder moves to `<root>/.archive/<name>` (`<name> 2`, `<name> 3`… when
  that's taken), files and memory with it.
- A repository or a folder is never touched.

A Space with a session running in its own folder is **409 `space_busy`** (end them first);
its sessions working in projects just leave it. A removed Space attaches no projects until
it's restored. The answer is
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

- **The Inbox's menu** lists *All sessions*, then the Spaces (an empty one too, each with
  its projects beside it), then *Not in a Space* when a session is in none; then **New
  Space…** (a name, the projects to attach, optional preferences; then the new Space is the
  one shown) and, with a Space shown, **Space settings…**. A project, a worktree or a cache
  folder is never an entry.
- **Space settings** (web: a dialog; app: a sheet): the Space's name and folder, its
  **Projects** (attach one from the projects sessions have used, or any folder; detach),
  its live sessions and conversations, Preferences (the text of `AGENTS.md`, saved on
  demand) and Memory (each file, opened, edited or deleted); **Remove Space…** with what it
  does and doesn't touch, said before it does it.
- **Space Portal** (web and native iOS/iPad/Mac): selecting a Space in the Inbox enters
  that Space's workspace portal: **Sessions** (with its Chief(s) of Staff strip, active Chief
  Wakes pills with pause/resume, and *Start Chief of Staff*, which starts the Chief in the
  Space's own folder, with optional adoption of the Space's unmanaged sessions and
  unidirectional `Chief > worker` control), **Notes** (filtered to this Space and its
  projects; *New note* files automatically under the Space, can hand off directly to its
  Chief of Staff, and can promote to Space Knowledge), **Files & Artifacts** (rooted at the
  Space's folder, with upload, hidden-file toggle, send-to-Chief, and quick jumps to
  `artifacts/` and `memory/`), **Tasks** (Space-scoped fleet task ledger with reassignment
  and status controls), and **Knowledge** (inline `AGENTS.md` and `memory/`), plus a
  **Context** inspector showing the live bundle injected into harnesses. One Chief of Staff
  per Space is the default, not a restriction—multiple Chiefs per Space or fleet-wide Chiefs
  work too.
  - **Both clients** keep the Space's sessions first, right under the search: a **Sessions ·
    Notes** switch (each with its count) is all that stands between them, so a Space's notes
    are a tap away instead of after every session (the app's whole Inbox has the same switch
    when it has notes; there it sits beside the search, each side a glyph and its count, and
    the Inbox's summary sits beside its title while both fit). Everything else is the Space's own menu in the header (the app: the
    bar, beside More; the web: beside New session, an action sheet on a phone), its folder
    at its head: Files, Tasks, Knowledge and Context (each a sheet), New note (web),
    *Start Chief of Staff…* (*Another Chief of Staff…* once it has one) and *Space
    Settings…* (its projects, preferences, memory, Remove). The title's menu only switches
    Spaces (and New Space…). With no Chief there is no Chief card in the list (a Space
    needn't have one; New Session can start one too); a Chief it has shows over its sessions.
  - **The app** keeps a Chief quiet: it's one session that reaches down to others, not the
    Space's centrepiece. Its row in a list has a small crown by its name and nothing else;
    its workers' rows and headers say nothing of being managed (the Chief's own header lists
    them). Over the Space's sessions, a Chief is one line (its crown, name, workers and
    status; a tap opens it, with *Adopt N* beside it while the Space has unmanaged sessions)
    and its box: the session's own composer, lean (dictation, pasted and attached media,
    @files, # sessions and / commands), whose messages go as they would from its screen.
    Its wakes are in Jobs.
- **Session mentions & Chief sub-sessions** (web and native): typing `#` in a chat composer
  autocompletes live sessions (ranking managed sub-sessions and same-Space sessions first)
  and inserts `#<uid> `; full session URLs, `#<uid>`, and bare `<uid>` render as clickable
  session-name chips and expand on send into a session reference for the agent. Chief
  sessions show their managed sub-sessions bar directly above the transcript.
- **Move to Space…** on a session: any Space, its project's (when attached), or none.
- **Settings → Spaces**: the Spaces folder and the removed Spaces, each with **Restore**.
- **New session** has a **Space** beside the folder: picking a Space proposes its first
  project (or its own folder); picking a folder proposes the Space its project is attached
  to. A Space different from the folder's is the session's own choice (`space`); "No Space"
  sends `space: ""`.

## SPC-7 Harness context & artifacts injection

Every session started, resumed, or forked in a Space (put in it, or started in a project
attached to it) automatically receives access to that Space's preferences (`AGENTS.md`),
shared memory (`memory/`), artifacts (`artifacts/`), and Space notes without modifying any
git repository:

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

## SPC-8 Projects

`PUT /api/spaces/:name/projects` `{ projects }` replaces the projects attached to a Space and
answers `{ space }` (as SPC-1 lists it). Each is a folder's path, absolute or `~/…`
(`invalid_project`, 400); a worktree's path is its repository's; at most 50
(`too_many_projects`, 400). A project attached to another Space moves to this one. A Space
that isn't there: **404 `space_not_found`**. `ah space projects <space> [add|remove <folder>…]`
does the same from a terminal.

A session's Space, worked out each pass: the one it was put in (`ah.space`: by New
session's `space`, `PUT /api/sessions/:uid/space` `{ space }`, a Chief scoping its workers,
or a fork inheriting its parent's), else the Space its project is attached to, else none.
`PUT /api/sessions/:uid/space` `{ space: "" }` takes it out of every Space (its project's
too); `{ space: null }` returns it to its project's. Putting one in a Space that isn't there:
**404 `space_not_found`**. Resume, relaunch and fork keep the choice.

## Wording

*Space* replaces *project* (README's vocabulary) everywhere a person reads it: the Inbox's
menu and its Space grouping, New session's Space field and New Space, the sidebar's Spaces,
a note's Space, Run in Space, Review's Start from a Space, Settings, the CLI's SPACE
column. What programs read keeps its name, so installed apps and scripts go on working:
the API's `project` fields, `/api/projects`, the `new-project` command id, the switcher's
`p:` token.

## Not yet in scope

Renaming a Space, a Space spanning multiple hosts, a project in more than one Space, and full-text memory search.
