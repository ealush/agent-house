import Foundation

/// Taking synced notes to their host and back (`../ah/docs/spec/15-scratchpads.md`).
///
/// One pass per account at a time: send what changed here (each write names the revision
/// it was made on, and is kept exactly as sent until answered, so a lost answer is retried
/// as the same write and never taken for a later one), then read what changed there since the last cursor. Nothing is merged: when the
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

    /// The most a note can hold on the host (UTF-16 units, as it counts).
    static let maxMarkdown = 1_048_576
    static let maxTitle = 200

    private func push(_ origin: String, _ api: APIClient) async throws {
        let waiting = notes.values.filter { $0.syncOrigin == origin && $0.conflict == nil && $0.syncError == nil && ($0.hasUnsyncedChanges || $0.revision == 0 || $0.pending != nil) }
            .sorted { $0.createdAt < $1.createdAt }
        for snapshot in waiting {
            // A write still unanswered goes first, as it was; then what changed since, then a
            // deletion: at most a few in a row for one note.
            for _ in 0..<4 {
                guard let write = nextWrite(snapshot.id) else { break }
                do {
                    guard try await send(write, of: snapshot.id, api: api, origin: origin) else { break }
                } catch let error as APIError {
                    // The host refused this note for good (a reason without a code): it waits,
                    // marked, while the others go on. Anything else (offline, signed out) stops here.
                    guard case .server(let status, let message) = error, (400..<500).contains(status) else { throw error }
                    refuse(snapshot.id, message.isEmpty ? "The host refused this note." : message)
                    break
                }
            }
        }
    }

    /// The write to send now for a note: the one still on its way, else one made from what
    /// changed (kept on disk before it goes). Nil: nothing to send, or it can't go.
    private func nextWrite(_ id: String) -> NoteWrite? {
        guard var note = notes[id], note.syncOrigin != nil, note.conflict == nil, note.syncError == nil else { return nil }
        if let pending = note.pending { return pending }
        guard note.hasUnsyncedChanges || note.revision == 0 else { return nil }
        if note.deletedAt == nil, let problem = Self.tooBig(note) {
            refuse(id, problem)
            return nil
        }
        let write = NoteWrite(note)
        note.pending = write
        notes[id] = note
        persistNow(note)
        return write
    }

    /// Why the host would refuse a note's size (it counts UTF-16 units).
    static func tooBig(_ note: Note) -> String? {
        if note.markdown.utf16.count > maxMarkdown { return "Too long to sync: a note holds at most about a million characters. It stays on this device." }
        if note.title.utf16.count > maxTitle { return "The title is too long to sync (at most 200 characters)." }
        return nil
    }

    private func refuse(_ id: String, _ reason: String) {
        guard var note = notes[id] else { return }
        note.pending = nil
        note.syncError = reason
        notes[id] = note
        persist(note)
    }

    /// Sends one write; true when the note may have more to send.
    private func send(_ write: NoteWrite, of id: String, api: APIClient, origin: String) async throws -> Bool {
        if write.deletion {
            let answer = try await api.deleteNote(id, baseRevision: write.baseRevision, writeId: write.id)
            return deletion(write, of: id, answer: answer, origin: origin)
        }
        let body = NoteWriteBody(baseRevision: write.baseRevision, writeId: write.id, title: write.title, markdown: write.markdown, project: write.project, createdAt: notes[id]?.createdAt ?? Date().timeIntervalSince1970)
        let answer = try await api.putNote(id, body)
        return written(write, of: id, answer: answer, origin: origin)
    }

    private func written(_ write: NoteWrite, of id: String, answer: NoteAnswer<NoteDTO>, origin: String) -> Bool {
        guard var note = notes[id] else { return false }
        note.pending = nil
        switch answer {
        case .ok(let dto):
            note.revision = dto.revision
            if !dto.exports.isEmpty { note.exports = dto.exports }
            // Only what this write carried is on the host; edits since go next.
            note.syncedVersion = max(note.syncedVersion, write.version)
            notes[id] = note
            persist(note)
            return note.hasUnsyncedChanges
        case .refused(let refusal):
            switch refusal.code {
            case "note_conflict":
                guard let theirs = refusal.note else { break }
                if write.matches(theirs) || note.sameContent(theirs) {
                    // This write reached the host (its answer was lost), or both sides wrote the same.
                    note.revision = theirs.revision
                    note.syncedVersion = max(note.syncedVersion, note.sameContent(theirs) ? note.version : write.version)
                    notes[id] = note
                    persist(note)
                    return note.hasUnsyncedChanges
                }
                if note.deletedAt != nil {
                    // Deleted here since: the deletion goes next, on the revision it saw, and
                    // the host refuses it with their version, which then stays.
                    notes[id] = note
                    persist(note)
                    return true
                }
                note.conflict = NoteConflict(title: theirs.title, markdown: theirs.markdown, revision: theirs.revision, writer: theirs.writer, at: theirs.updatedAt, deleted: false, project: theirs.project)
                notes[id] = note
                persist(note)
                return false
            case "note_deleted":
                notes[id] = note
                if note.deletedAt != nil { remove(id) } else {
                    keepAsCopy(note, origin: origin, reason: "“\(note.shownTitle)” was deleted on another device. Your edits are kept as a new note.")
                }
                return false
            default:
                break
            }
            note.syncError = refusal.error
            notes[id] = note
            persist(note)
            return false
        }
    }

    private func deletion(_ write: NoteWrite, of id: String, answer: NoteAnswer<NoteDTO>, origin: String) -> Bool {
        guard var note = notes[id] else { return false }
        note.pending = nil
        switch answer {
        case .ok(let dto):
            if dto.deleted {
                remove(id)
                return false
            }
            // Not a tombstone (an older host's answer to an id it had seen): asked again, anew.
            note.revision = dto.revision
            notes[id] = note
            persist(note)
            return dto.revision != write.baseRevision
        case .refused(let refusal):
            guard refusal.code == "note_conflict", let theirs = refusal.note else {
                // Gone there already, or refused for good: gone here too.
                remove(id)
                return false
            }
            if write.matches(theirs) {
                // What was deleted here is what the host has, one revision on (this device's
                // own write, its answer lost): delete that revision.
                note.revision = theirs.revision
                notes[id] = note
                persist(note)
                return true
            }
            // Changed on another device since you deleted it: their changes stay.
            note.deletedAt = nil
            adopt(theirs, into: &note)
            store(note)
            tell("“\(note.shownTitle)” changed on another device, so it wasn’t deleted.")
            return false
        }
    }

    // MARK: Reading

    private func pull(_ origin: String, _ api: APIClient) async throws {
        var cursor = (try? repository.cursor(origin: origin)) ?? 0
        var pages = 0
        repeat {
            let page = try await api.notes(since: cursor)
            let failures = failedWriteCount()
            for dto in page.notes { merge(dto, origin: origin) }
            cursor = page.cursor
            try saveCursor(cursor, origin: origin, failuresBefore: failures)
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
        } else if note.sameContent(dto) || note.pending?.matches(dto) == true {
            // This device's own write, seen on the feed before its answer came.
            let carried = note.pending.flatMap { $0.matches(dto) ? $0.version : nil }
            if carried != nil { note.pending = nil }
            note.syncedVersion = max(note.syncedVersion, note.sameContent(dto) ? note.version : (carried ?? note.syncedVersion))
            note.revision = dto.revision
            notes[note.id] = note
            persist(note)
        } else {
            note.conflict = NoteConflict(title: dto.title, markdown: dto.markdown, revision: dto.revision, writer: dto.writer, at: dto.updatedAt, deleted: false, project: dto.project)
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
