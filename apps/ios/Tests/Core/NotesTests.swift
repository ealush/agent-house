import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Scratchpads on the device: written offline, on disk before anything else, synced by
// revision against a host that keeps ah's rules (`apps/server/server/notes/store.ts`): a write on
// an older revision is refused with the host's version, a retried write id is answered, a
// deletion is a tombstone.

/// An ah host's notes, in memory, by the same rules as `server/notes/store.ts`.
private final class NotesHost: HTTPTransport, @unchecked Sendable {
    struct Row { var dto: NoteDTO; var lastWrite: String? }
    private let lock = NSLock()
    private var rows: [String: Row] = [:]
    private var seq = 0
    private var asked: [String] = []
    /// Unreachable: every request fails as offline does.
    var offline = false
    /// The next write is applied but its answer never arrives (a dropped connection).
    var loseNextAnswer = false
    /// The next request is refused with a 400 and no code (an older host's generic refusal).
    var refuseIDOnce: String?

    func requests() -> [String] { lock.withLock { asked } }
    func note(_ id: String) -> NoteDTO? { lock.withLock { rows[id]?.dto } }
    func count() -> Int { lock.withLock { rows.values.filter { !$0.dto.deleted }.count } }

    /// Another device's write, straight into the host.
    func write(_ id: String, markdown: String, title: String = "", project: NoteProjectDTO?? = nil) {
        lock.withLock {
            seq += 1
            let at = Date().timeIntervalSince1970
            var dto = rows[id]?.dto ?? NoteDTO(id: id, title: title, markdown: markdown, project: nil, revision: 0, seq: 0, writer: "device:other", createdAt: at, updatedAt: at, deleted: false, exports: [])
            dto.markdown = markdown
            dto.title = title
            if let project { dto.project = project }
            dto.revision += 1
            dto.seq = seq
            dto.writer = "device:other"
            rows[id] = Row(dto: dto, lastWrite: "other-\(seq)")
        }
    }

    /// A session the host recorded on a note (a hand-off, or a start on another device): news on
    /// the feed with no new revision.
    func recordSession(_ id: String, _ session: NoteSessionDTO) {
        lock.withLock {
            guard var row = rows[id] else { return }
            seq += 1
            row.dto.sessions = [session] + (row.dto.sessions ?? [])
            row.dto.seq = seq
            rows[id] = row
        }
    }

    func deleteElsewhere(_ id: String) {
        lock.withLock {
            guard var row = rows[id] else { return }
            seq += 1
            row.dto.deleted = true
            row.dto.markdown = ""
            row.dto.title = ""
            row.dto.revision += 1
            row.dto.seq = seq
            rows[id] = row
        }
    }

    private func answer(_ url: URL, _ status: Int, _ object: Any) -> (Data, HTTPURLResponse) {
        (try! JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    private func json(_ dto: NoteDTO) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: JSONEncoder().encode(dto)) as! [String: Any]
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let method = request.httpMethod ?? "GET"
        if offline { throw URLError(.notConnectedToInternet) }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let q = { (name: String) in query.first { $0.name == name }?.value }
        return try lock.withLock { () throws -> (Data, HTTPURLResponse) in
            asked.append("\(method) \(url.path)")
            if url.path == "/api/notes", method == "GET" {
                let since = Int(q("since") ?? "0") ?? 0
                let changed = rows.values.map(\.dto).filter { $0.seq > since }.sorted { $0.seq < $1.seq }
                return answer(url, 200, ["notes": changed.map(json), "cursor": changed.last?.seq ?? max(since, seq), "more": false])
            }
            let id = String(url.path.dropFirst("/api/notes/".count))
            if method == "PUT" {
                let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as! [String: Any]
                let base = body["baseRevision"] as! Int, write = body["writeId"] as! String
                if refuseIDOnce == id {
                    refuseIDOnce = nil
                    return answer(url, 400, ["error": "bad request"])
                }
                let markdown = body["markdown"] as! String, title = body["title"] as! String
                let sentProject = (body["project"] as? [String: String]).map { NoteProjectDTO(host: $0["host"]!, path: $0["path"]!) }
                if (markdown as NSString).length > 1_048_576 { return answer(url, 413, ["error": "too long", "code": "note_too_long"]) }
                if let row = rows[id] {
                    // A retry is the same write: same id and the same content (store.ts).
                    if row.lastWrite == write, row.dto.markdown == markdown, row.dto.title == title, row.dto.project == sentProject { return answer(url, 200, json(row.dto)) }
                    if row.dto.deleted { return answer(url, 409, ["error": "deleted", "code": "note_deleted", "note": json(row.dto)]) }
                    if row.dto.revision != base { return answer(url, 409, ["error": "changed", "code": "note_conflict", "note": json(row.dto)]) }
                }
                seq += 1
                let at = Date().timeIntervalSince1970
                let project = (body["project"] as? [String: String]).map { NoteProjectDTO(host: $0["host"]!, path: $0["path"]!) }
                let dto = NoteDTO(id: id, title: body["title"] as! String, markdown: body["markdown"] as! String, project: project, revision: (rows[id]?.dto.revision ?? base) + 1, seq: seq, writer: "device:phone", createdAt: rows[id]?.dto.createdAt ?? at, updatedAt: at, deleted: false, exports: [])
                rows[id] = Row(dto: dto, lastWrite: write)
                if loseNextAnswer {
                    loseNextAnswer = false
                    throw URLError(.networkConnectionLost)
                }
                return answer(url, rows.count == 1 && dto.revision == 1 ? 201 : 200, json(dto))
            }
            if method == "DELETE" {
                let base = Int(q("baseRevision") ?? "0") ?? 0, write = q("writeId") ?? ""
                guard var row = rows[id] else { return answer(url, 200, ["ok": true]) }
                // Only a tombstone answers a deletion again; a PUT's id is no deletion's.
                if row.dto.deleted { return answer(url, 200, json(row.dto)) }
                if row.dto.revision != base { return answer(url, 409, ["error": "changed", "code": "note_conflict", "note": json(row.dto)]) }
                seq += 1
                row.dto.deleted = true
                row.dto.markdown = ""
                row.dto.title = ""
                row.dto.project = nil
                row.dto.revision += 1
                row.dto.seq = seq
                row.lastWrite = write
                rows[id] = row
                return answer(url, 200, json(row.dto))
            }
            return answer(url, 404, ["error": "not found"])
        }
    }

    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

private let origin = "https://box.example.ts.net"

@MainActor
private struct Device {
    let notes: NotesModel
    let database: AppDatabase
    let root: URL
    let host: NotesHost

    /// This device's notes as a fresh launch reads them back from disk.
    func relaunch(supportsNotes: Bool = true) throws -> Device {
        let reopened = try AppDatabase(directory: root)
        return Device.wire(NotesModel(repository: NoteRepository(database: reopened), outbox: Outbox(), saveDelay: .milliseconds(10), syncDelay: .seconds(3600)), database: reopened, root: root, host: host, supportsNotes: supportsNotes)
    }

    static func make(host: NotesHost, supportsNotes: Bool = true) throws -> Device {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let database = try AppDatabase(directory: root)
        return wire(NotesModel(repository: NoteRepository(database: database), outbox: Outbox(), saveDelay: .milliseconds(10), syncDelay: .seconds(3600)), database: database, root: root, host: host, supportsNotes: supportsNotes)
    }

    static func wire(_ notes: NotesModel, database: AppDatabase, root: URL, host: NotesHost, supportsNotes: Bool) -> Device {
        let api = APIClient(origin: URL(string: origin)!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
        notes.host = { asked in asked == origin ? NotesModel.HostLink(api: api, hostname: "box", supportsNotes: supportsNotes, online: !host.offline) : nil }
        return Device(notes: notes, database: database, root: root, host: host)
    }
}

@MainActor
private func settle() async { try? await Task.sleep(for: .milliseconds(60)) }

/// Waits (up to 3 s: the suite runs in parallel) for what's on disk to say so.
@MainActor
private func onDisk(_ device: Device, _ id: String, _ done: (Note?) -> Bool) async -> Bool {
    let repo = NoteRepository(database: device.database)
    for _ in 0..<150 {
        if done(try? repo.note(id)) { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return false
}

@MainActor
@Test func aNoteWrittenOfflineIsOnDiskAndComesBackAfterTheAppIsKilled() async throws {
    let host = NotesHost()
    host.offline = true
    let phone = try Device.make(host: host)
    let note = phone.notes.create(syncOrigin: origin)
    let doc = try #require(phone.notes.document(note.id))
    doc.box.text = "# Session restoration\n\n- [ ] panes\n"
    #expect(await onDisk(phone, note.id) { $0?.markdown == "# Session restoration\n\n- [ ] panes\n" }, "saved on its own, no Save button")
    // No flush: the process is gone, only what reached the disk counts.
    let after = try phone.relaunch()
    #expect(after.notes.note(note.id)?.markdown == "# Session restoration\n\n- [ ] panes\n")
    #expect(after.notes.summary(note.id)?.title == "Session restoration", "the first line, without its #")
    await after.notes.sync(origin)
    #expect(after.notes.summary(note.id)?.sync == .pending, "offline: waiting, nothing claimed")
    #expect(host.count() == 0)
}

@MainActor
@Test func backOnlineItSyncsOnceAndALostAnswerIsNeverASecondWrite() async throws {
    let host = NotesHost()
    host.offline = true
    let phone = try Device.make(host: host)
    let note = phone.notes.create(markdown: "Idea", syncOrigin: origin)
    await phone.notes.sync(origin)
    #expect(phone.notes.note(note.id)?.revision == 0)

    host.offline = false
    host.loseNextAnswer = true
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.revision == 1, "the host took it")
    #expect(phone.notes.summary(note.id)?.sync == .pending, "but the answer was lost: not claimed as synced")
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.revision == 1, "the retry was answered, not written again")
    #expect(phone.notes.note(note.id)?.revision == 1)
    #expect(phone.notes.summary(note.id)?.sync == .synced)
    #expect(host.requests().filter { $0.hasPrefix("PUT") }.count == 3 - 1, "one lost, one answered")
}

@MainActor
@Test func twoDevicesEditingTheSameRevisionKeepBothVersionsUntilYouChoose() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host), ipad = try Device.make(host: host)
    let note = phone.notes.create(markdown: "v1", syncOrigin: origin)
    await phone.notes.sync(origin)
    await ipad.notes.sync(origin)
    #expect(ipad.notes.note(note.id)?.markdown == "v1", "a note made elsewhere appears")

    phone.notes.document(note.id)!.box.text = "phone’s idea"
    ipad.notes.document(note.id)!.box.text = "iPad’s idea"
    await settle()
    await phone.notes.sync(origin)
    await ipad.notes.sync(origin)
    #expect(ipad.notes.summary(note.id)?.sync == .conflict)
    #expect(ipad.notes.note(note.id)?.markdown == "iPad’s idea", "never overwritten")
    #expect(ipad.notes.note(note.id)?.conflict?.markdown == "phone’s idea", "theirs kept beside it")
    #expect(host.note(note.id)?.markdown == "phone’s idea")

    ipad.notes.resolve(note.id, .keepBoth)
    await ipad.notes.sync(origin)
    #expect(ipad.notes.note(note.id)?.markdown == "phone’s idea")
    #expect(ipad.notes.summaries.count == 2)
    #expect(ipad.notes.summaries.contains { $0.title.hasSuffix("(this device’s version)") })
    #expect(host.count() == 2)

    // Keep Mine writes on top of the host's revision.
    phone.notes.document(note.id)!.box.text = "phone again"
    await settle()
    await ipad.notes.sync(origin)
    host.write(note.id, markdown: "someone else")
    await phone.notes.sync(origin)
    #expect(phone.notes.summary(note.id)?.sync == .conflict)
    phone.notes.resolve(note.id, .keepMine)
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.markdown == "phone again")
    #expect(phone.notes.summary(note.id)?.sync == .synced)
}

@MainActor
@Test func aLocalNoteNeverLeavesTheDevice() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    let note = phone.notes.create(markdown: "private", syncOrigin: nil)
    await phone.notes.sync(origin)
    #expect(host.requests().allSatisfy { $0.hasPrefix("GET") }, "only the change feed was read")
    #expect(host.count() == 0)
    #expect(phone.notes.summary(note.id)?.sync == .local)
    // Syncing it is a choice; a synced note that reached the host can't silently stop.
    phone.notes.setSync(note.id, origin: origin)
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.markdown == "private")
    #expect(!phone.notes.canKeepLocal(note.id))
}

@MainActor
@Test func aDeletionIsForGoodAndEditsThatMeetItAreKeptAsANewNote() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host), ipad = try Device.make(host: host)
    let note = phone.notes.create(markdown: "draft", syncOrigin: origin)
    await phone.notes.sync(origin)
    await ipad.notes.sync(origin)

    // The iPad edits offline while the phone deletes.
    host.offline = true
    ipad.notes.document(note.id)!.box.text = "draft, improved offline"
    await settle()
    await ipad.notes.sync(origin)
    host.offline = false
    phone.notes.delete(note.id)
    #expect(phone.notes.note(note.id) == nil, "gone here at once")
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.deleted == true)

    await ipad.notes.sync(origin)
    #expect(ipad.notes.note(note.id) == nil, "the deleted note doesn’t come back")
    let copy = try #require(ipad.notes.summaries.first)
    #expect(ipad.notes.note(copy.id)?.markdown == "draft, improved offline", "the edits live on")
    #expect(ipad.notes.current(note.key) == copy.key, "a window on the old note goes to the copy")
    #expect(ipad.notes.takeNotices().first?.contains("deleted on another device") == true)
    await ipad.notes.sync(origin)
    #expect(host.note(copy.id)?.markdown == "draft, improved offline")
    #expect(host.note(note.id)?.deleted == true)

    // A device with no edits just lets it go.
    let third = try Device.make(host: host)
    await third.notes.sync(origin)
    #expect(third.notes.note(note.id) == nil)
}

@MainActor
@Test func aProjectIsAHostAndAFolderNotAFileAndTravelsWithTheNote() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host), ipad = try Device.make(host: host)
    let mac = NoteProject(origin: origin, host: "mac", path: "/Users/me/code/ah-native")
    let linux = NoteProject(origin: origin, host: "linux", path: "/home/me/code/ah-native")
    let a = phone.notes.create(markdown: "a", project: mac, syncOrigin: origin)
    let b = phone.notes.create(markdown: "b", project: linux, syncOrigin: origin)
    #expect(mac.name == linux.name && mac != linux, "the same folder name on two hosts is two projects")
    await phone.notes.sync(origin)
    #expect(host.requests().allSatisfy { !$0.contains("export") }, "filing a note writes nothing into the folder")
    await ipad.notes.sync(origin)
    #expect(ipad.notes.note(a.id)?.project == mac)
    #expect(ipad.notes.note(b.id)?.project == linux)
    phone.notes.setProject(a.id, nil)
    await phone.notes.sync(origin)
    await ipad.notes.sync(origin)
    #expect(ipad.notes.note(a.id)?.project == nil, "cleared everywhere")
    // Offline, the project is kept as last known.
    host.offline = true
    phone.notes.setProject(b.id, mac)
    let after = try phone.relaunch()
    #expect(after.notes.note(b.id)?.project == mac)
}

@MainActor
@Test func anOlderHostLeavesNotesWorkingHere() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host, supportsNotes: false)
    let note = phone.notes.create(markdown: "still mine", syncOrigin: origin)
    phone.notes.rename(note.id, to: "Ideas")
    await phone.notes.sync(origin)
    #expect(host.requests().isEmpty, "nothing asked of a host without notes")
    #expect(phone.notes.summary(note.id)?.sync == .unsupported)
    #expect(phone.notes.summary(note.id)?.title == "Ideas")
}

@MainActor
@Test func renameDuplicateAndDeleteAreLocalFirstAndClosingNeverDeletes() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    let note = phone.notes.create(markdown: "# Plan\nsteps", syncOrigin: nil)
    phone.notes.rename(note.id, to: "  Launch plan  ")
    #expect(phone.notes.summary(note.id)?.title == "Launch plan")
    let copy = try #require(phone.notes.duplicate(note.id))
    #expect(copy.id != note.id)
    #expect(copy.markdown == "# Plan\nsteps")
    #expect(phone.notes.summary(copy.id)?.title == "Launch plan copy")
    _ = phone.notes.document(note.id)
    phone.notes.flush()
    #expect(phone.notes.note(note.id) != nil, "a view going away isn't a deletion")
    phone.notes.delete(note.id)
    let after = try phone.relaunch()
    #expect(after.notes.note(note.id) == nil)
    #expect(after.notes.note(copy.id) != nil)
    #expect(after.notes.search("launch").map(\.id) == [copy.id])
    #expect(after.notes.search("steps").map(\.id) == [copy.id], "found by its text too")
}

@MainActor
@Test func theHostsChangesNeverOverwriteTypingInFlight() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    let note = phone.notes.create(markdown: "v1", syncOrigin: origin)
    await phone.notes.sync(origin)
    host.write(note.id, markdown: "from elsewhere")
    // Typed a moment ago, not yet saved when the change arrives.
    phone.notes.document(note.id)!.box.text = "v1 and what I just typed"
    await phone.notes.sync(origin)
    #expect(phone.notes.note(note.id)?.markdown == "v1 and what I just typed")
    #expect(phone.notes.note(note.id)?.conflict?.markdown == "from elsewhere")

    // With nothing typed, the host's change shows in the open note.
    let quiet = phone.notes.create(markdown: "q1", syncOrigin: origin)
    let doc = phone.notes.document(quiet.id)!
    await phone.notes.sync(origin)
    host.write(quiet.id, markdown: "q2")
    await phone.notes.sync(origin)
    #expect(doc.box.text == "q2")
    await settle()
    #expect(phone.notes.summary(quiet.id)?.sync == .synced, "taking the host's text isn't an edit to send back")
}

/// Dictation hears what it's told to.
private final class Microphone: DictationCapture {
    var heard = "add a restore test"
    private let file = FileManager.default.temporaryDirectory.appendingPathComponent("note-dictation-\(UUID().uuidString).m4a")
    init() { FileManager.default.createFile(atPath: file.path, contents: Data("aac".utf8)) }
    func start(transcribing locale: Locale?, events: @escaping @MainActor (CaptureEvent) -> Void) async throws { events(.level(0.4)) }
    func finish() async throws -> CaptureResult { CaptureResult(file: file, text: heard, lastBatch: nil) }
    func cancel() async {}
    func transcribe(_ file: URL, locale: Locale) async throws -> String { heard }
}

@MainActor
@Test func dictationGoesInAtTheCaretAndKeepsWhatWasTypedMeanwhile() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    phone.notes.makeCapture = { Microphone() }
    let note = phone.notes.create(markdown: "# Spec\n\nTests:\n", syncOrigin: nil)
    let doc = try #require(phone.notes.document(note.id))
    doc.box.caret = doc.box.text.utf16.count
    await doc.dictation.start(into: doc.box)
    #expect(doc.dictation.isListening)
    // Typed above the caret while it listens (the text view moves the caret with it): kept,
    // and the words still go in where the caret is.
    doc.box.text = "# Spec, draft\n\nTests:\n"
    doc.box.caret += ", draft".utf16.count
    await doc.dictation.finish(into: doc.box)
    #expect(doc.box.text == "# Spec, draft\n\nTests:\nadd a restore test")
    #expect(await onDisk(phone, note.id) { $0?.markdown == "# Spec, draft\n\nTests:\nadd a restore test" }, "dictated words are saved like typed ones")

    // Cancelled: nothing goes in.
    await doc.dictation.start(into: doc.box)
    await doc.dictation.cancel(in: doc.box)
    #expect(doc.box.text == "# Spec, draft\n\nTests:\nadd a restore test")
}

// MARK: Review fixes (Codex, 18 November 2026)

@MainActor
@Test func aLostAnswerThenMoreTypingSendsTheFirstWriteAsItWasThenTheRest() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    let note = phone.notes.create(markdown: "A", syncOrigin: origin)
    host.loseNextAnswer = true
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.markdown == "A", "the host took A; its answer was lost")
    phone.notes.document(note.id)!.box.text = "B"
    phone.notes.flush()
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.markdown == "B", "B, typed after, reached the host too")
    #expect(host.note(note.id)?.revision == 2, "A answered again, B written once")
    #expect(phone.notes.summary(note.id)?.sync == .synced)
    let ipad = try Device.make(host: host)
    await ipad.notes.sync(origin)
    #expect(ipad.notes.note(note.id)?.markdown == "B")
}

@MainActor
@Test func aDeletionAfterALostAnswerDeletesItOnTheHostAndItStaysGone() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    let note = phone.notes.create(markdown: "A", syncOrigin: origin)
    host.loseNextAnswer = true
    await phone.notes.sync(origin)
    phone.notes.delete(note.id)
    await phone.notes.sync(origin)
    #expect(host.note(note.id)?.deleted == true, "a tombstone there, not the live note answered back")
    await phone.notes.sync(origin)
    #expect(phone.notes.note(note.id) == nil, "the next pull doesn't bring it back")
    #expect(phone.notes.summaries.isEmpty)
}

@MainActor
@Test func filingTheSameNoteUnderTwoProjectsApartIsAConflictToo() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host), ipad = try Device.make(host: host)
    let note = phone.notes.create(markdown: "same text", syncOrigin: origin)
    await phone.notes.sync(origin)
    await ipad.notes.sync(origin)
    let r = NoteProject(origin: origin, host: "mac", path: "/code/r"), q = NoteProject(origin: origin, host: "mac", path: "/code/q")
    phone.notes.setProject(note.id, r)
    await phone.notes.sync(origin)
    ipad.notes.setProject(note.id, q)
    await ipad.notes.sync(origin)
    #expect(ipad.notes.summary(note.id)?.sync == .conflict, "the text matches, the project doesn't: not taken as in step")
    #expect(ipad.notes.note(note.id)?.conflict?.project == NoteProjectDTO(host: "mac", path: "/code/r"))
    ipad.notes.resolve(note.id, .keepTheirs)
    #expect(ipad.notes.note(note.id)?.project?.path == "/code/r", "keeping theirs keeps their project")
    await ipad.notes.sync(origin)
    #expect(host.note(note.id)?.project?.path == "/code/r")
}

@MainActor
@Test func oneNoteTheHostRefusesDoesntStopTheOthersOrThePull() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    let refused = phone.notes.create(markdown: "refused", syncOrigin: origin)
    let huge = phone.notes.create(markdown: String(repeating: "a", count: NotesModel.maxMarkdown + 1), syncOrigin: origin)
    let fine = phone.notes.create(markdown: "fine", syncOrigin: origin)
    let elsewhere = NoteKey.newID()
    host.write(elsewhere, markdown: "made on the Mac")
    host.refuseIDOnce = refused.id
    await phone.notes.sync(origin)
    #expect(host.note(fine.id)?.markdown == "fine", "the notes after it still go")
    #expect(phone.notes.note(elsewhere)?.markdown == "made on the Mac", "and the host's changes still come")
    #expect(phone.notes.note(refused.id)?.syncError != nil, "the refused one says so")
    #expect(phone.notes.note(huge.id)?.syncError?.contains("Too long") == true)
    #expect(host.note(huge.id) == nil, "too long to sync isn't sent at all")
    #expect(!host.requests().contains("PUT /api/notes/\(huge.id)"))
}

@MainActor
@Test func aNoteSaysWhichSessionItWentToHereAtOnceAndAsTheHostKeepsIt() async throws {
    let host = NotesHost()
    let phone = try Device.make(host: host)
    let note = phone.notes.create(markdown: "# Plan", syncOrigin: origin)
    await phone.notes.sync(origin)
    phone.notes.recordSession(note.id, NoteSessionDTO(uid: "abc123", host: "box", title: "Build it", via: "start", at: 1))
    phone.notes.recordSession(note.id, NoteSessionDTO(uid: "def456", host: "box", title: "Review", via: "handoff", at: 2))
    phone.notes.recordSession(note.id, NoteSessionDTO(uid: "abc123", host: "box", title: "Build it", via: "start", at: 3))
    #expect(phone.notes.note(note.id)?.sessions.map(\.uid) == ["abc123", "def456"], "newest first, once each")
    #expect(phone.notes.summary(note.id)?.wentTo?.title == "Build it", "the list shows the last")
    #expect(await onDisk(phone, note.id) { $0?.sessions.first?.uid == "abc123" })
    // The host's own list, on the feed with no new revision.
    host.recordSession(note.id, NoteSessionDTO(uid: "mac0001", host: "mac", title: "On the Mac", via: "handoff", at: 4))
    await phone.notes.sync(origin)
    #expect(phone.notes.note(note.id)?.sessions.map(\.uid) == ["mac0001"])
    #expect(phone.notes.summary(note.id)?.wentTo?.uid == "mac0001")
    #expect(phone.notes.note(note.id)?.revision == 1, "no new revision")
    #expect(await onDisk(phone, note.id) { $0?.sessions.first?.uid == "mac0001" })
    #expect(try phone.relaunch().notes.summary(note.id)?.wentTo?.uid == "mac0001", "kept across a launch")
    // A host before notes 2 sends none: it still decodes.
    let older = try JSONDecoder().decode(NoteDTO.self, from: Data(#"{"id":"x","title":"","markdown":"","project":null,"revision":1,"seq":1,"writer":"w","createdAt":0,"updatedAt":0,"deleted":false,"exports":[]}"#.utf8))
    #expect(older.sessions == nil)
}
