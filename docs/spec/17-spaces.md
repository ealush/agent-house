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
| `space` | A folder ah made in the Spaces folder (`~/spaces/<name>` unless `spaces.root` says otherwise), with no repository | ah's: `AGENTS.md` and `memory/` in the folder (SPC-3, SPC-4) |
| `repo` | A git checkout's root (a worktree belongs to its repository's Space) | The repository's own `AGENTS.md` / `CLAUDE.md`; ah doesn't write into it |
| `folder` | Any other folder sessions ran in (`~`, `~/Work`, `~/.config`) | None of ah's |

A Space is named as the Inbox names a project: the repository's name, else the folder's
(`Home` for `~`). Within one host, the name is the Space's identity; another host's Space
of the same name is another Space (the Inbox shows the host beside it).

The routes follow the conductor's contract rules ([13](13-conductor.md#contract-rules-all-of-cnd)):
`api` stays 28, the capability is `spaces` in `features`, errors are `{ error, code? }`,
every route is behind sign-in. A host without `spaces` still has projects in the Inbox's
menu, made from its sessions and History; a client offers none of the below.

| Feature | Version | Routes |
|---|---|---|
| `spaces` | 1 | `GET`/`POST /api/spaces`, `POST /api/spaces/remove`, `POST /api/spaces/restore`, `GET`/`PUT /api/spaces/:name/preferences`, `GET /api/spaces/:name/memory`, `PUT`/`DELETE /api/spaces/:name/memory/:file` |

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
`PUT` `{ text }` writes the whole file (at most 65 536 characters, else **413
`preferences_too_long`**) and answers the same. A session already running reads it again
when its agent does (most read instructions when a conversation starts).

Only a plain Space has ah's preferences: for a repository or a folder, both are **409
`not_a_plain_space`** (its own files are the repository's to change). A name that is no
Space: **404 `space_not_found`**.

## SPC-4 Memory

The memory is Markdown files in `memory/`, written by the agents (the starting
`AGENTS.md` tells them to read `memory/MEMORY.md` first and keep durable facts there, one
topic a file, never a secret) and by the person.

- `GET /api/spaces/:name/memory` answers `{ files }`: each `.md` file in `memory/` as
  `{ name, text, bytes, updatedAt }`, `MEMORY.md` first then by name, at most 200 files;
  a file over 262 144 bytes comes back cut to that, with `truncated: true`.
- `PUT /api/spaces/:name/memory/:file` `{ text }` writes one (at most 262 144 characters,
  **413 `memory_too_long`**); `DELETE` removes one (`MEMORY.md` can't be removed: **409
  `memory_index`**). A file name is 1–80 letters, digits, `.`, `_`, `-`, ending in `.md`
  (`invalid_memory_file`, 400); one that isn't there to remove is **404 `memory_not_found`**.

Plain Spaces only, as preferences (`not_a_plain_space`).

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
- **Settings → Spaces**: the Spaces folder and the removed Spaces, each with **Restore**.
- **New session** offers plain Spaces among the projects; the Spaces folder is a root.

## Wording

*Space* replaces *project* (README's vocabulary) everywhere a person reads it: the Inbox's
menu and its Space grouping, New session's Space field and New Space, the sidebar's Spaces,
a note's Space, Run in Space, Review's Start from a Space, Settings, the CLI's SPACE
column. What programs read keeps its name, so installed apps and scripts go on working:
the API's `project` fields, `/api/projects`, the `new-project` command id, the switcher's
`p:` token.

## Not in v1

Renaming a Space, moving a repository's sessions into a plain Space, a Space across hosts,
memory search, and preferences for a repository written by ah.
