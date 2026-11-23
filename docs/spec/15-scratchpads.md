# 15 · Scratchpads (`SCR`)

A scratchpad is a Markdown note that is a session of its own: you write, dictate and
think in it with no agent, terminal, tmux window or network behind it, then hand it to
an agent or save it into a project. Asked for by the owner on 18 November 2026 ("a
scratchpad / note session type … jot down ideas either when I'm offline or when I just
want to think through something", sent to a running session, started as a new one,
saved as a spec file in a project).

The devices own the writing; the host is where they meet. A note is written on a device
first (the native app keeps it in its own database, offline), and reaches the host when
it can. Nothing here needs an agent, and handing a note on never changes the note.

The routes follow the conductor's contract rules ([13](13-conductor.md#contract-rules-all-of-cnd)):
`api` stays 28, the capability is `notes` in `features`, errors are `{ error, code? }`,
every route is behind sign-in. A host without `notes` (an older one) still lets the
app keep notes on the device; it just has nowhere to sync them.

| Feature | Version | Routes |
|---|---|---|
| `notes` | 1 | `GET /api/notes`, `GET`/`PUT`/`DELETE /api/notes/:id`, `POST /api/notes/export`, `POST /api/notes/handoffs`, `GET /api/notes/handoffs/:id` |
| `notes` | 2 | a note's `sessions`; `POST /api/notes/:id/sessions` (SCR-8) |
| `folderFiles` | 1 | `GET /api/fs/complete` (SCR-7) |

## SCR-1 Identity

A note's `id` is a UUID made on the device that wrote it first, so it keeps one identity
on every device and on the host. Fields: `title`, `markdown` (at most 1 048 576
characters), `project` (below), `revision`, `seq`, `writer` (`device:<label>`,
`token:<name>`, `local`), `createdAt`/`updatedAt` (seconds), `deleted`/`deletedAt`,
`exports`, `sessions` (SCR-8). Kept in the `Note` table of ah.db (durable across restarts).

## SCR-2 Writing: revisions, never a silent overwrite

`PUT /api/notes/:id` `{ baseRevision, writeId, title, markdown, project, createdAt? }`
writes the whole note. `baseRevision` is the revision the device's text was made on (0
for a note the host hasn't seen); `writeId` names this write.

- The host's revision equals `baseRevision`: written, `revision + 1` (201 when made).
- A different revision: **409 `note_conflict`**, with `note` as the host has it. Nothing
  is merged. The device keeps both versions and the person chooses; writing their
  choice on top of the host's revision is an ordinary write.
- The same `writeId` as the write that made the note what it is, with the same `title`,
  `markdown` and `project`: the same answer again (a retry after a lost response is never
  applied twice). The same `writeId` with anything else isn't a retry (a device that kept
  editing after the answer was lost): it's checked as a write of its own, so it is
  refused (`note_conflict`, with what the host has) rather than taken as written.
- `markdown` over 1 048 576 characters (UTF-16 units): **413 `note_too_long`**; a `title`
  over 200: **400 `title_too_long`**.
- A host that has no row for an id with `baseRevision > 0` (a restored database) takes
  the note back from the device.

## SCR-3 Deleting: tombstones

`DELETE /api/notes/:id?baseRevision=&writeId=` leaves a tombstone: the id, a revision,
no title, text or project. A deletion made on an older revision is refused
(`note_conflict`: someone changed it since you looked). A write to a tombstone is
refused with **409 `note_deleted`**, so a device that was offline can't bring a deleted
note back; one with unsynced edits keeps them as a new note. Deleting an id the host
never had also leaves a tombstone.

A deletion of a tombstone is a retry (the tombstone again). A live note is never answered
as a retry, whichever `writeId` last wrote it: a deletion under an earlier write's id is
checked on its revision like any other. So the answer to a deletion that succeeds is
always a tombstone (`deleted: true`).

Until the host has read where its change numbering is (at start; again on the next
request if that failed), every notes route answers **503 `notes_unavailable`** and the
state stream's `notes` is `null`: numbering from 0 would hide new changes from a device
that has read further.

## SCR-4 Change discovery

`GET /api/notes?since=<seq>&limit=` returns every change after `seq`, oldest first,
tombstones included, `{ notes, cursor, more, state }` (a page stops near 4 MB of text).
The state stream carries `notes: { cursor, count }`: a client pulls `?since=` when
`cursor` moves, instead of asking after each note.

## SCR-5 Project, and saving as a file

`project: { host, path }` files a note under a folder on a host (this one or a peer, by
name: the same folder name on two hosts is two projects). It's metadata: nothing is
written into the folder, and the note lives in the database wherever it's filed.

`POST /api/notes/export` `{ dir, path, markdown, replace?, noteId?, revision? }` writes a
snapshot of the note into `dir` (a project folder inside `files.roots`, server/files.ts)
at the relative `path` (`SPEC.md`, `docs/proposals/x.md`). The file is a copy at that
moment, not the note: nothing keeps them in step.

- `path` can't be absolute, use `..`, `.` or empty parts, backslashes or control
  characters, or go into `.git` (`invalid_path`). Folders along it are made. `.git` is
  checked where each folder really is, too: a symlink to the repo's `.git` is refused.
- Every folder along the way is resolved through symlinks and must stay inside `dir`
  (`outside_project`); the target can't be a symlink (`file_symlink`) or a folder
  (`not_a_file`).
- An existing file is replaced only with `replace: true`; otherwise **409
  `file_exists`** with `suggestion` ("SPEC (1).md").
- Written to a temporary file beside the target (opened exclusively, never through a
  link), synced, then moved into place (or hard-linked, so a file made meanwhile is still
  refused). The folder is checked again just before the temporary file is made and just
  before it's moved, so one swapped for a symlink in between is refused
  (`outside_project`). Node has no `openat`, so a swap in the instant between that last
  check and the move can't be ruled out; it needs another process on the host racing the
  write with the owner's permissions.
- With `noteId`, the note records `{ host, path, revision, at }` in `exports` without a
  new revision.

## SCR-6 Handing a note to an agent

`POST /api/notes/handoffs` `{ id, noteId, revision, target, text, resend? }` sends `text`
to the session `target` (a uid, or `harness:harnessId` for an ended one) through the
same send as a typed message: typed in when it's idle, queued while it works, resumed
first when it has ended. Never straight into tmux. At most 32 768 characters (UTF-16
units, of any script; the request may be up to 512 KB): **413 `handoff_too_long`**, attach
the note as a file instead.

`id` is chosen by the device. The `NoteHandoff` row is written before anything is
sent, and requests for one id run one at a time, so a retry is answered from what
happened: `delivered` or `queued` as before (`replay: true`; the queue item's id is the
hand-off's); a crash mid-send is `queued` if it's still in the target's queue, otherwise
**`uncertain`**, sent again only with `resend: true`. A send that failed (`failed`) can
be retried with the same id; `failed` means nothing reached the target. A send that may
have typed some of the text (a paste that failed after it began), or that queued it but
couldn't yet keep the queue on disk, answers 200 **`uncertain`** instead: sending again
could deliver it twice. `queued` is answered only once the queue holding it is on disk.
If the send went but the row couldn't be updated after, the row stays as sending, and a
retry reads it as above (`queued` or `uncertain`), never `failed`. The same id with another target or text is
`handoff_mismatch`. `revision` records which version of the note went (the sending
device's count of its edits: a local note has no host revision). The note itself isn't
touched.

Putting a note in a session's box as a draft (not sent) uses the session's own draft
(`PUT /api/sessions/:uid/draft`); the app asks before it combines it with a draft
already there.

## SCR-7 Files and pictures in a note

A note can carry what a message carries, so a prompt with pictures can be written now and
sent later. Asked for by the owner on 22 November 2026 ("media/files references - even
plain @ file references and completion + uploads in the notes feature so I can prepare a
prompt with images for later").

- **@ files.** "@path" names a file as it does in a session's box (web/mentions.ts, the
  app's Mentions.swift): relative to the note's Space when it's filed under one on this
  host, else to the home folder; absolute and ~ paths as written. One that names a file
  there is a chip that opens it.
- **@ completion.** `GET /api/fs/complete?dir=&q=` lists the files under `dir` matching `q`
  as a session's own completion does (`GET /api/sessions/:uid/files`: git's files, or a
  bounded walk; relative to `dir`, at most 30). `dir` must be a folder inside `files.roots`
  (`safePath`: 403 outside, 404 missing, 400 a file or not absolute); a symlink in it is
  named, never walked. A note asks with its Space's folder, or `~` when it has none (403
  when home isn't a root: no suggestions).
- **Pictures and files.** Pasted, dropped or picked, a file uploads to this host at once
  (`POST /api/upload`, as a message's attachment) and is a tile over the text and a chip
  where the caret was ("@paste.png", its token). The note's Markdown keeps its path in the
  upload folder in that place, as a sent message carries it, so a hand-off, a new session
  from the note, the session's box and a saved file all carry the file with no step of
  their own; on another device the path is the same chip again. The path is put in once
  the upload is done: until then the token stands in the text, and sending is held. A
  failed upload takes its token out and says so. Its tile's × or its chip's takes it out of
  the text (the file stays in the upload folder until that is cleared, Settings → System).
- **Preview.** Pictures over the words (the gallery), files beside them, each a chip where
  it was put; "@path" files open in the file preview.
- **Starting a session from a note** puts each upload in New session's box as a tile and a
  chip, as if attached there.
- **The app** does the same in its note editor: chips drawn as the session's box draws them,
  tiles over the text, the attach menu (photos, camera, files) and pasted media, the @ list
  over the bar (on a host with `folderFiles`; an older host lists nothing), and Preview with
  the pictures over the words. Putting a note in a session's box or starting a session from
  it brings its files as tiles and chips. A note with no account to reach has no attach menu.

## SCR-8 The sessions a note went to

A note remembers the sessions it started and the ones it was handed to: `sessions`, newest
first, at most 20, each `{ uid, host, title, via: 'start' | 'handoff', at }` (`title` as the
session was called then; `at` in seconds). A hand-off that was delivered or queued records
its session on the host (SCR-6). Starting a session from a note (its words or its file) is
recorded by the device that started it: `POST /api/notes/:id/sessions { uid }` for a session
on the note's host, `{ uid, host, title }` for one on another. Neither is a change to the note:
no new revision, so no device's next write conflicts with it, and the change feed carries it.
A host before `notes` 2 has no `sessions`; a device keeps its own record of what it started.

- **Both clients** mark a note that went to a session in the lists (a session glyph beside its
  name) and say which inside it: "In <session>" (the newest), which opens that session, or
  says it ended.

