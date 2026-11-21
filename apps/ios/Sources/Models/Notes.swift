import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Observation

/// A note being edited: its text lives in a composer box (uid "", so no host draft), so
/// dictation writes into it the way it writes into a session's box, at the caret, keeping
/// edits made while it listens. One per note for the whole app: two windows on one note
/// edit the same text.
@MainActor
@Observable
final class NoteDocument {
    let id: String
    let box: ComposerModel
    let dictation: DictationModel
    /// Edit or Preview, as the note was left.
    var preview: Bool { didSet { if preview != oldValue { owner?.setPreview(id, preview) } } }
    @ObservationIgnored weak var owner: NotesModel?

    init(id: String, text: String, preview: Bool, box: ComposerModel, dictation: DictationModel) {
        self.id = id
        self.box = box
        self.dictation = dictation
        self.preview = preview
        box.text = text
    }
}

/// Every scratchpad on this device (`docs/spec/15-scratchpads.md`). The device's copy is
/// the one being written: an edit is in memory at once and on disk within a moment (at once
/// when the app goes to the background), whatever the network is doing. Synced notes are
/// taken to their account's host by revision (`NoteSync`); local ones never leave.
@MainActor
@Observable
final class NotesModel {
    struct Summary: Equatable, Identifiable, Sendable {
        let id: String
        var key: String { NoteKey.key(id) }
        var title: String
        var project: NoteProject?
        var sync: SyncState
        var syncOrigin: String?
        var createdAt: Double
        var updatedAt: Double
    }

    enum SyncState: Equatable, Sendable {
        /// Kept on this device only, by choice.
        case local
        /// Changes the host hasn't taken yet (offline, or not tried yet).
        case pending
        case synced
        /// The host and this device changed it apart; both versions are kept.
        case conflict
        /// The account's host predates scratchpads: it stays here until it's updated.
        case unsupported
        /// The host refused it (too large, …): what it said.
        case refused(String)
    }

    /// How an account's host is reached for notes, as `AppModel` knows it.
    struct HostLink {
        let api: APIClient
        let hostname: String
        /// The host says it keeps notes (`features.notes`); false for an older host.
        let supportsNotes: Bool
        /// Its state stream is live now.
        let online: Bool
    }

    enum Resolution: Sendable { case keepMine, keepTheirs, keepBoth }

    /// What lists draw: titles, projects and sync states, not text. Changes only when one of
    /// those does, so typing in a note doesn't redraw every list.
    private(set) var summaries: [Summary] = []
    /// A note that had to be kept under a new id (its edits met a deletion elsewhere): where
    /// a window that still shows the old one goes.
    private(set) var successors: [String: String] = [:]
    /// Something to tell whoever's looking, once ("Kept your edits as a copy…").
    private(set) var notices: [String] = []

    @ObservationIgnored let repository: NoteRepository
    @ObservationIgnored let outbox: Outbox
    @ObservationIgnored var notes: [String: Note] = [:]
    @ObservationIgnored private var documents: [String: NoteDocument] = [:]
    @ObservationIgnored private var pendingText: Set<String> = []
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    /// Writes go here in order, off the main thread; `flush()` waits for them.
    @ObservationIgnored private let writer = DispatchQueue(label: "dev.ealush.ah.native.notes", qos: .userInitiated)
    /// Writes to disk that failed, counted on `writer` (a sync cursor isn't moved past them).
    @ObservationIgnored private let failedWrites = FailedWrites()
    @ObservationIgnored let saveDelay: Duration
    @ObservationIgnored let syncDelay: Duration

    /// The host an account's notes go to, if signed in.
    @ObservationIgnored var host: @MainActor (String) -> HostLink? = { _ in nil }
    /// What a new document dictates through (the window's account), and whether its host does voice.
    /// The account a note's dictation goes through: the one it syncs with (or its project's),
    /// else any signed-in one.
    @ObservationIgnored var voice: @MainActor (_ origin: String?) -> (api: APIClient, hostDoesVoice: @MainActor () -> Bool)? = { _ in nil }
    /// The microphone documents listen with (the app's; a stand-in in tests).
    @ObservationIgnored var makeCapture: @MainActor () -> any DictationCapture = { DictationModel.makeCapture() }
    /// A fallback for documents opened with no account at all (never called: uid "").
    @ObservationIgnored private lazy var nowhere = APIClient(origin: URL(string: "https://notes.invalid")!, transport: NoTransport(), credentials: AccountCredentials(token: nil) {}, device: DeviceDescriptor(name: "device", client: "notes"))

    // Sync bookkeeping (NoteSync.swift).
    @ObservationIgnored var syncing: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var syncAgain: Set<String> = []
    @ObservationIgnored var syncSoon: [String: Task<Void, Never>] = [:]

    init(repository: NoteRepository, outbox: Outbox, saveDelay: Duration = .milliseconds(300), syncDelay: Duration = .milliseconds(1500)) {
        self.repository = repository
        self.outbox = outbox
        self.saveDelay = saveDelay
        self.syncDelay = syncDelay
        for note in (try? repository.everything()) ?? [] { notes[note.id] = note }
        refreshSummaries()
    }

    // MARK: Reading

    func note(_ id: String) -> Note? { notes[id].flatMap { $0.deletedAt == nil ? $0 : nil } }

    func summary(_ id: String) -> Summary? { summaries.first { $0.id == id } }

    /// The key a window should show for `key`: itself, or the copy it was kept as.
    func current(_ key: String) -> String {
        guard let id = NoteKey.id(key) else { return key }
        var at = id
        var hops = 0
        while notes[at]?.deletedAt != nil || notes[at] == nil, let next = successors[at], hops < 8 {
            at = next
            hops += 1
        }
        return NoteKey.key(at)
    }

    func syncState(_ note: Note) -> SyncState {
        guard let origin = note.syncOrigin else { return .local }
        if note.conflict != nil { return .conflict }
        if let refused = note.syncError { return .refused(refused) }
        if let link = host(origin), !link.supportsNotes, link.online { return .unsupported }
        return note.hasUnsyncedChanges || note.revision == 0 ? .pending : .synced
    }

    /// Notes whose title or text has every word of `query`, best (title) first.
    func search(_ query: String, limit: Int = 30) -> [Summary] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return Array(summaries.prefix(limit)) }
        var scored: [(Summary, Int)] = []
        for s in summaries {
            guard let n = notes[s.id] else { continue }
            let title = s.title.lowercased(), body = n.markdown.lowercased()
            let project = s.project?.name.lowercased() ?? ""
            guard words.allSatisfy({ title.contains($0) || body.contains($0) || project.contains($0) }) else { continue }
            scored.append((s, words.filter { title.contains($0) }.count))
        }
        return scored.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.createdAt > $1.0.createdAt }.prefix(limit).map(\.0)
    }

    func takeNotices() -> [String] {
        defer { if !notices.isEmpty { notices = [] } }
        return notices
    }

    func tell(_ text: String) { notices.append(text) }

    // MARK: Documents

    /// The note's editing document, made on first use.
    func document(_ id: String) -> NoteDocument? {
        if let kept = documents[id] { return kept }
        guard let note = note(id) else { return nil }
        let voice = voice(note.syncOrigin ?? note.project?.origin)
        let api = voice?.api ?? nowhere
        let box = ComposerModel(api: api, outbox: outbox, key: note.key, uid: "", isShell: false)
        var hostDoesVoice: @MainActor () -> Bool = { false }
        if let asks = voice?.hostDoesVoice { hostDoesVoice = asks }
        let dictation = DictationModel(api: api, thisDevice: DictationModel.thisDeviceName, hostDoesVoice: hostDoesVoice, makeCapture: { [weak self] in self?.makeCapture() ?? DictationModel.makeCapture() })
        let doc = NoteDocument(id: id, text: note.markdown, preview: note.preview, box: box, dictation: dictation)
        doc.owner = self
        documents[id] = doc
        follow(doc)
        return doc
    }

    /// Every change to the box (typing, dictation, a paste) is the note's text.
    private func follow(_ doc: NoteDocument) {
        withObservationTracking { _ = doc.box.text } onChange: { [weak self, weak doc] in
            Task { @MainActor in
                guard let self, let doc, self.documents[doc.id] === doc else { return }
                self.textChanged(doc.id)
                self.follow(doc)
            }
        }
    }

    private func textChanged(_ id: String) {
        guard let doc = documents[id], let note = notes[id], doc.box.text != note.markdown else { return }
        pendingText.insert(id)
        saveTask?.cancel()
        let delay = saveDelay
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.savePendingText()
        }
    }

    /// Takes what's in the open boxes into the notes and onto disk.
    private func savePendingText() {
        let ids = pendingText
        pendingText = []
        for id in ids {
            guard let doc = documents[id], var note = notes[id], note.deletedAt == nil, doc.box.text != note.markdown else { continue }
            note.markdown = doc.box.text
            touch(&note)
            store(note)
        }
    }

    /// The editor's place in a note (not a change to the note: no new version).
    func remember(_ id: String, selection: NSRange, scroll: Double) {
        guard var note = notes[id] else { return }
        guard note.selectionStart != selection.location || note.selectionLength != selection.length || abs(note.scrollOffset - scroll) > 1 else { return }
        note.selectionStart = selection.location
        note.selectionLength = selection.length
        note.scrollOffset = scroll
        notes[id] = note
        persist(note)
    }

    func setPreview(_ id: String, _ on: Bool) {
        guard var note = notes[id], note.preview != on else { return }
        note.preview = on
        notes[id] = note
        persist(note)
    }

    /// A note's text came from the host: an open box shows it.
    func documents(showing note: Note) {
        if let doc = documents[note.id], doc.box.text != note.markdown { doc.box.text = note.markdown }
    }

    /// Typing not yet taken into the note (within the save delay), or a box that differs.
    func hasUnsavedText(_ id: String) -> Bool {
        pendingText.contains(id) || (documents[id].map { $0.box.text != notes[id]?.markdown } ?? false)
    }

    // MARK: Changes

    /// A new note, on disk before this returns. `syncOrigin`: the account it syncs with.
    @discardableResult
    func create(title: String = "", markdown: String = "", project: NoteProject? = nil, syncOrigin: String?) -> Note {
        let note = Note(title: title, markdown: markdown, project: project, syncOrigin: syncOrigin)
        notes[note.id] = note
        persistNow(note)
        refreshSummaries()
        if let syncOrigin { scheduleSync(syncOrigin) }
        return note
    }

    func rename(_ id: String, to title: String) {
        guard var note = note(id) else { return }
        let clean = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        guard clean != note.title else { return }
        note.title = clean
        touch(&note)
        store(note)
    }

    /// Files it under a project, or none. Nothing is written into the folder.
    func setProject(_ id: String, _ project: NoteProject?) {
        guard var note = note(id), note.project != project else { return }
        note.project = project
        touch(&note)
        store(note)
    }

    /// Whether a note can stop syncing in place: only one the host never had.
    func canKeepLocal(_ id: String) -> Bool {
        guard let note = note(id) else { return false }
        return note.syncOrigin == nil || (note.revision == 0 && note.pendingJson == nil)
    }

    /// Starts syncing a local note with an account, or keeps a never-synced one here.
    func setSync(_ id: String, origin: String?) {
        guard var note = note(id), note.syncOrigin != origin else { return }
        if origin == nil, !canKeepLocal(id) { return }
        note.syncOrigin = origin
        note.revision = 0
        note.syncedVersion = 0
        note.pending = nil
        note.syncError = nil
        note.conflict = nil
        store(note)
        if let origin { scheduleSync(origin) }
    }

    /// A copy with a new identity, beside the original (same project and sync).
    @discardableResult
    func duplicate(_ id: String, syncOrigin: String?? = nil, title: String? = nil) -> Note? {
        flushText(id)
        guard let source = note(id) else { return nil }
        return create(title: title ?? "\(source.shownTitle) copy", markdown: source.markdown, project: source.project, syncOrigin: syncOrigin ?? source.syncOrigin)
    }

    /// Deleted here at once; a synced note's host is told (a tombstone there, so no other
    /// device's copy brings it back). Closing a note's view never calls this.
    func delete(_ id: String) {
        guard var note = notes[id], note.deletedAt == nil else { return }
        if let doc = documents[id], doc.dictation.phase != .idle { Task { await doc.dictation.cancel(in: doc.box) } }
        documents[id] = nil
        pendingText.remove(id)
        if let origin = note.syncOrigin, note.revision > 0 || note.pendingJson != nil {
            note.deletedAt = Date().timeIntervalSince1970
            notes[id] = note
            persistNow(note)
            scheduleSync(origin)
        } else {
            notes[id] = nil
            writer.async { [repository] in try? repository.remove(id) }
            flush()
        }
        refreshSummaries()
    }

    /// Chooses between this device's version and the host's after they changed apart.
    func resolve(_ id: String, _ choice: Resolution) {
        flushText(id)
        guard var note = note(id), let theirs = note.conflict, let origin = note.syncOrigin else { return }
        switch choice {
        case .keepMine:
            note.conflict = nil
            if theirs.deleted {
                // The host's copy is gone for good: mine continues as a new note.
                keepAsCopy(note, origin: origin, reason: nil)
                return
            }
            note.revision = theirs.revision
            note.pending = nil
            note.version += 1
            store(note)
        case .keepTheirs, .keepBoth:
            if choice == .keepBoth { _ = create(title: "\(note.shownTitle) (this device’s version)", markdown: note.markdown, project: note.project, syncOrigin: origin) }
            if theirs.deleted {
                note.conflict = nil
                notes[id] = note
                remove(id)
                return
            }
            note.conflict = nil
            note.title = theirs.title
            note.markdown = theirs.markdown
            note.project = theirs.project.map { NoteProject(origin: origin, host: $0.host, path: $0.path) }
            note.revision = theirs.revision
            note.pending = nil
            note.version += 1
            note.syncedVersion = note.version
            store(note)
            documents[id]?.box.text = theirs.markdown
        }
        scheduleSync(origin)
    }

    /// Edits that met a deletion elsewhere live on as a new note; the old id is gone.
    func keepAsCopy(_ note: Note, origin: String, reason: String?) {
        flushText(note.id)
        let kept = notes[note.id] ?? note
        let copy = create(title: kept.title, markdown: kept.markdown, project: kept.project, syncOrigin: origin)
        successors[note.id] = copy.id
        remove(note.id)
        if let reason { tell(reason) }
    }

    /// Gone from this device (the host already knows, or never had it).
    func remove(_ id: String) {
        if let doc = documents[id], doc.dictation.phase != .idle { Task { await doc.dictation.cancel(in: doc.box) } }
        documents[id] = nil
        pendingText.remove(id)
        notes[id] = nil
        writer.async { [repository] in try? repository.remove(id) }
        refreshSummaries()
    }

    func recordExport(_ id: String, _ export: NoteExportDTO) {
        guard var note = notes[id] else { return }
        note.exports = [export] + note.exports.filter { !($0.host == export.host && $0.path == export.path) }
        notes[id] = note
        persist(note)
    }

    /// An account is forgotten here: its notes stay, on this device only.
    func detach(origin: String) {
        flush()
        for var note in notes.values where note.syncOrigin == origin {
            if note.deletedAt != nil {
                notes[note.id] = nil
                writer.async { [repository, id = note.id] in try? repository.remove(id) }
                continue
            }
            note.syncOrigin = nil
            note.revision = 0
            note.syncedVersion = 0
            note.pending = nil
            note.conflict = nil
            note.syncError = nil
            notes[note.id] = note
            persist(note)
        }
        flush()
        refreshSummaries()
    }

    // MARK: Saving

    func touch(_ note: inout Note) {
        note.version += 1
        note.updatedAt = Date().timeIntervalSince1970
        if note.syncError != nil { note.syncError = nil }
    }

    /// Keeps a changed note: memory, disk, lists, and its host soon.
    func store(_ note: Note) {
        notes[note.id] = note
        persist(note)
        refreshSummaries()
        if let origin = note.syncOrigin, note.hasUnsyncedChanges { scheduleSync(origin) }
    }

    func persist(_ note: Note) {
        writer.async { [repository, failedWrites] in
            do { try repository.save(note) } catch { failedWrites.count += 1 }
        }
    }

    func persistNow(_ note: Note) {
        writer.sync { [repository, failedWrites] in
            do { try repository.save(note) } catch { failedWrites.count += 1 }
        }
    }

    /// How many writes have failed so far (read in turn after every write before it).
    func failedWriteCount() -> Int { writer.sync { [failedWrites] in failedWrites.count } }

    /// The host's change feed read up to `cursor`, written after (in turn with) the notes it
    /// brought; not moved when one of those didn't reach the disk, so they come again.
    func saveCursor(_ cursor: Int, origin: String, failuresBefore: Int) throws {
        try writer.sync { [repository, failedWrites] in
            guard failedWrites.count == failuresBefore else { throw NoteDiskError() }
            try repository.setCursor(cursor, origin: origin)
        }
    }

    /// What an open box holds goes into its note now (before a copy, a send, a sync).
    func flushText(_ id: String) {
        guard hasUnsavedText(id) else { return }
        pendingText.remove(id)
        guard let doc = documents[id], var note = notes[id], note.deletedAt == nil, doc.box.text != note.markdown else { return }
        note.markdown = doc.box.text
        touch(&note)
        store(note)
    }

    /// Everything typed is on disk when this returns (backgrounding, a window closing).
    func flush() {
        saveTask?.cancel()
        savePendingText()
        // A change the observer hasn't been told of yet (it hears on the next turn) counts too.
        for id in documents.keys { flushText(id) }
        writer.sync {}
    }

    func refreshSummaries() {
        let next = notes.values.filter { $0.deletedAt == nil }
            .map { Summary(id: $0.id, title: $0.shownTitle, project: $0.project, sync: syncState($0), syncOrigin: $0.syncOrigin, createdAt: $0.createdAt, updatedAt: $0.updatedAt) }
            .sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.id < $1.id }
        if next != summaries { summaries = next }
    }
}

/// A transport that never reaches anything (a document opened before any sign-in: its box
/// has no host to save drafts or uploads to, and never tries).
private struct NoTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) { throw APIError.transport("No host") }
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) { throw APIError.transport("No host") }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { throw APIError.transport("No host") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("notes never open a terminal") }
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) { throw APIError.transport("No host") }
}

/// Touched only on the notes' writer queue.
final class FailedWrites: @unchecked Sendable {
    var count = 0
}

struct NoteDiskError: Error {}
