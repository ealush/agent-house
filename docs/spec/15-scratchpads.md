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

## SCR-1 Identity

A note's `id` is a UUID made on the device that wrote it first, so it keeps one identity
on every device and on the host. Fields: `title`, `markdown` (at most 1 048 576
characters), `project` (below), `revision`, `seq`, `writer` (`device:<label>`,
`token:<name>`, `local`), `createdAt`/`updatedAt` (seconds), `deleted`/`deletedAt`,
`exports`. Kept in the `Note` table of ah.db (durable across restarts).

## SCR-2 Writing: revisions, never a silent overwrite

`PUT /api/notes/:id` `{ baseRevision, writeId, title, markdown, project, createdAt? }`
writes the whole note. `baseRevision` is the revision the device's text was made on (0
for a note the host hasn't seen); `writeId` names this write.

- The host's revision equals `baseRevision`: written, `revision + 1` (201 when made).
- A different revision: **409 `note_conflict`**, with `note` as the host has it. Nothing
  is merged. The device keeps both versions and the person chooses; writing their
  choice on top of the host's revision is an ordinary write.
- The same `writeId` as the write that made the note what it is: the same answer again
  (a retry after a lost response is never applied twice).
- A host that has no row for an id with `baseRevision > 0` (a restored database) takes
  the note back from the device.

## SCR-3 Deleting: tombstones

`DELETE /api/notes/:id?baseRevision=&writeId=` leaves a tombstone: the id, a revision,
no title, text or project. A deletion made on an older revision is refused
(`note_conflict`: someone changed it since you looked). A write to a tombstone is
refused with **409 `note_deleted`**, so a device that was offline can't bring a deleted
note back; one with unsynced edits keeps them as a new note. Deleting an id the host
never had also leaves a tombstone.

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
  characters, or go into `.git` (`invalid_path`). Folders along it are made.
- Every folder along the way is resolved through symlinks and must stay inside `dir`
  (`outside_project`); the target can't be a symlink (`file_symlink`) or a folder
  (`not_a_file`).
- An existing file is replaced only with `replace: true`; otherwise **409
  `file_exists`** with `suggestion` ("SPEC (1).md").
- Written to a temporary file beside the target, synced, then moved into place (or
  hard-linked, so a file made meanwhile is still refused).
- With `noteId`, the note records `{ host, path, revision, at }` in `exports` without a
  new revision.

## SCR-6 Handing a note to an agent

`POST /api/notes/handoffs` `{ id, noteId, revision, target, text, resend? }` sends `text`
to the session `target` (a uid, or `harness:harnessId` for an ended one) through the
same send as a typed message: typed in when it's idle, queued while it works, resumed
first when it has ended. Never straight into tmux. At most 32 768 characters
(`handoff_too_long`: attach the note as a file instead).

`id` is chosen by the device. The `NoteHandoff` row is written before anything is
sent, and requests for one id run one at a time, so a retry is answered from what
happened: `delivered` or `queued` as before (`replay: true`; the queue item's id is the
hand-off's); a crash mid-send is `queued` if it's still in the target's queue, otherwise
**`uncertain`**, sent again only with `resend: true`. A send that failed (`failed`) can
be retried with the same id. The same id with another target or text is
`handoff_mismatch`. `revision` records which version of the note went (the sending
device's count of its edits: a local note has no host revision). The note itself isn't
touched.

Putting a note in a session's box as a draft (not sent) uses the session's own draft
(`PUT /api/sessions/:uid/draft`); the app asks before it combines it with a draft
already there.
