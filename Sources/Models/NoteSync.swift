import Foundation

/// Taking synced notes to their host and back (`../ah/docs/spec/15-scratchpads.md`).
///
/// One pass per account at a time: send what changed here (each write names the revision
/// it was made on and keeps its id across retries, so a lost answer is never a second
/// write), then read what changed there since the last cursor. Nothing is merged: when the
/// two changed apart, the host's version is kept beside this device's until the person
/// chooses. Offline, a pass stops at the first unreachable request and waits for the next
/// reason to run (an edit, the state stream's cursor, a reconnect).
extension NotesModel {
    /// Soon, once: edits come in bursts.
    func scheduleSync(_ origin: String) {
        syncSoon[origin]?.cancel()
        let delay = syncDelay
        syncSoon[origin] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.syncSoon[origin] = nil
            await self?.sync(origin)
        }
    }

    /// One pass for `origin`; asked again while one runs, another follows it.
    func sync(_ origin: String) async {
        if let running = syncing[origin] {
            syncAgain.insert(origin)
            await running.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.syncAgain.remove(origin)
                await self.pass(origin)
            } while self.syncAgain.contains(origin)
        }
        syncing[origin] = task
        await task.value
        syncing[origin] = nil
    }

    /// Every account with synced notes (foreground, reconnect).
    func syncAll(origins: [String]) async {
        for origin in origins { await sync(origin) }
    }

    private func pass(_ origin: String) async {
        guard let link = host(origin), link.supportsNotes else {
            refreshSummaries()
            return
        }
        flush()
        do {
            try await push(origin, link.api)
            try await pull(origin, link.api)
        } catch {
            // Unreachable or signed out: everything stays as it is, to be sent next time.
        }
        refreshSummaries()
    }

    // MARK: Sending

    private func push(_ origin: String, _ api: APIClient) async throws {
        let waiting = notes.values.filter { $0.syncOrigin == origin && $0.conflict == nil && $0.syncError == nil && ($0.hasUnsyncedChanges || $0.revision == 0) }
            .sorted { $0.createdAt < $1.createdAt }
        for snapshot in waiting {
            guard var note = notes[snapshot.id] else { continue }
            // A write keeps its id until the host takes it: asked again, the host answers the
            // first time's result instead of applying it twice.
            if note.writeId == nil {
                note.writeId = NoteKey.newID()
                notes[note.id] = note
                persist(note)
                flush()
            }
            let writeId = note.writeId!
            if note.deletedAt != nil {
                try await sendDeletion(note, writeId: writeId, api: api, origin: origin)
            } else {
                try await sendWrite(note, writeId: writeId, api: api, origin: origin)
            }
        }
    }

    private func sendWrite(_ sent: Note, writeId: String, api: APIClient, origin: String) async throws {
        let body = NoteWriteBody(baseRevision: sent.revision, writeId: writeId, title: sent.title, markdown: sent.markdown, project: sent.project.map { NoteProjectDTO(host: $0.host, path: $0.path) }, createdAt: sent.createdAt)
        let answer = try await api.putNote(sent.id, body)
        guard var note = notes[sent.id] else { return }
        switch answer {
        case .ok(let dto):
            note.revision = dto.revision
            note.writeId = nil
            note.exports = dto.exports.isEmpty ? note.exports : dto.exports
            // Edited while it was on its way: still ahead of the host, sent next pass.
            note.syncedVersion = sent.version
            notes[note.id] = note
            persist(note)
            if note.version != note.syncedVersion { syncAgain.insert(origin) }
        case .refused(let refusal):
            note.writeId = nil
            switch refusal.code {
            case "note_conflict":
                guard let theirs = refusal.note else { break }
                if theirs.title == note.title && theirs.markdown == note.markdown {
                    // Both sides wrote the same: in step.
                    note.revision = theirs.revision
                    note.syncedVersion = note.version
                } else {
                    note.conflict = NoteConflict(title: theirs.title, markdown: theirs.markdown, revision: theirs.revision, writer: theirs.writer, at: theirs.updatedAt, deleted: false)
                }
                notes[note.id] = note
                persist(note)
            case "note_deleted":
                keepAsCopy(note, origin: origin, reason: "“\(note.shownTitle)” was deleted on another device. Your edits are kept as a new note.")
            default:
                note.syncError = refusal.error
                notes[note.id] = note
                persist(note)
            }
        }
    }

    private func sendDeletion(_ sent: Note, writeId: String, api: APIClient, origin: String) async throws {
        let answer = try await api.deleteNote(sent.id, baseRevision: sent.revision, writeId: writeId)
        switch answer {
        case .ok:
            remove(sent.id)
        case .refused(let refusal):
            guard refusal.code == "note_conflict", let theirs = refusal.note else {
                remove(sent.id)
                return
            }
            if theirs.markdown == sent.markdown && theirs.title == sent.title {
                // Our own write reached the host (its answer was lost): delete that revision.
                guard var note = notes[sent.id] else { return }
                note.revision = theirs.revision
                note.writeId = nil
                notes[note.id] = note
                persist(note)
                syncAgain.insert(origin)
                return
            }
            // Changed on another device since you deleted it: their changes stay.
            guard var note = notes[sent.id] else { return }
            note.deletedAt = nil
            note.writeId = nil
            adopt(theirs, into: &note)
            store(note)
            tell("“\(note.shownTitle)” changed on another device, so it wasn’t deleted.")
        }
    }

    // MARK: Reading

    private func pull(_ origin: String, _ api: APIClient) async throws {
        var cursor = (try? repository.cursor(origin: origin)) ?? 0
        var pages = 0
        repeat {
            let page = try await api.notes(since: cursor)
            for dto in page.notes { merge(dto, origin: origin) }
            cursor = page.cursor
            try? repository.setCursor(cursor, origin: origin)
            pages += 1
            if !page.more { break }
        } while pages < 50
    }

    /// One change from the host, against this device's copy.
    func merge(_ dto: NoteDTO, origin: String) {
        // Typed while this pass was on the network: that's a change here, never overwritten.
        flushText(dto.id)
        guard var note = notes[dto.id] else {
            guard !dto.deleted else { return }
            var made = Note(id: dto.id, title: dto.title, markdown: dto.markdown, project: dto.project.map { NoteProject(origin: origin, host: $0.host, path: $0.path) }, syncOrigin: origin, now: dto.createdAt)
            made.revision = dto.revision
            made.syncedVersion = made.version
            made.updatedAt = dto.updatedAt
            made.exports = dto.exports
            notes[made.id] = made
            persist(made)
            return
        }
        // The same id on this device only, or under another account: not this host's note.
        guard note.syncOrigin == origin else { return }
        let changedHere = note.version != note.syncedVersion
        if dto.deleted {
            if note.deletedAt != nil || !changedHere {
                if note.deletedAt == nil { tell("“\(note.shownTitle)” was deleted on another device.") }
                remove(note.id)
            } else {
                keepAsCopy(note, origin: origin, reason: "“\(note.shownTitle)” was deleted on another device. Your edits are kept as a new note.")
            }
            return
        }
        guard dto.revision > note.revision else {
            if !dto.exports.isEmpty, dto.exports != note.exports {
                note.exports = dto.exports
                notes[note.id] = note
                persist(note)
            }
            return
        }
        if note.deletedAt != nil {
            // Deleted here, changed there: the deletion goes as is (it names the revision it saw,
            // so the host refuses it and the note comes back with their changes).
            return
        }
        if !changedHere {
            adopt(dto, into: &note)
            note.syncedVersion = note.version
            notes[note.id] = note
            persist(note)
            documents(showing: note)
        } else if dto.title == note.title && dto.markdown == note.markdown {
            note.revision = dto.revision
            note.syncedVersion = note.version
            notes[note.id] = note
            persist(note)
        } else {
            note.conflict = NoteConflict(title: dto.title, markdown: dto.markdown, revision: dto.revision, writer: dto.writer, at: dto.updatedAt, deleted: false)
            notes[note.id] = note
            persist(note)
        }
    }

    private func adopt(_ dto: NoteDTO, into note: inout Note) {
        note.title = dto.title
        note.markdown = dto.markdown
        note.project = dto.project.map { NoteProject(origin: note.syncOrigin, host: $0.host, path: $0.path) }
        note.revision = dto.revision
        note.version += 1
        note.syncedVersion = note.version
        note.updatedAt = dto.updatedAt
        note.exports = dto.exports
    }
}
