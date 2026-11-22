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

// A note carries files (docs/spec/15-scratchpads.md, SCR-7): its Markdown keeps each upload's
// path, as a sent message does; its box shows each as a tile and a chip ("@paste.png"), and
// @ lists the files in its Space. The same rules as ah's web/noteText.ts.

private func up(_ name: String, _ stamp: String) -> String { "/home/me/.cache/ah/uploads/\(stamp)-\(name)" }

@Test func aNoteShowsEachUploadAsItsTokenAndItsMarkdownKeepsThePath() {
    let md = "Why is \(up("shot.png", "2026-11-22T10-00-00-000Z")) red, next to \(up("paste.png", "2026-11-22T10-00-01-000Z"))?\n\n- and \(up("paste.png", "2026-11-22T10-00-02-000Z")), see \(up("log.txt", "2026-11-22T10-00-00-000Z"))."
    var known: [String: String] = [:]
    let shown = NoteText.shown(md, known: &known)
    #expect(shown.text == "Why is @shot.png red, next to @paste.png?\n\n- and @paste-2.png, see @log.txt.")
    #expect(shown.uploads.map(\.token) == ["shot.png", "paste.png", "paste-2.png", "log.txt"])
    #expect(shown.uploads.map(\.upload.image) == [true, true, true, false])
    let paths = NoteText.tokenPaths(known, files: shown.uploads.map { (token: $0.token, path: $0.upload.path) })
    #expect(NoteText.markdown(shown.text, paths: paths) == md, "back to the same Markdown")
}

@Test func aChipKeepsItsNameWhenAnotherOfTheSameNameIsTakenOut() {
    let a = up("paste.png", "2026-11-22T10-00-01-000Z"), b = up("paste.png", "2026-11-22T10-00-02-000Z")
    var known: [String: String] = [:]
    #expect(NoteText.shown("\(a) \(b)", known: &known).text == "@paste.png @paste-2.png")
    #expect(NoteText.shown(b, known: &known).text == "@paste-2.png", "the box doesn't change under the caret")
    #expect(NoteText.shown("x \(b) \(a)", known: &known).text == "x @paste-2.png @paste.png")
}

@Test func anUploadsPathInsideOtherWordsOrCodeIsLeftAsItIs() {
    var known: [String: String] = [:]
    let a = up("a.png", "2026-11-22T10-00-00-000Z")
    for md in ["x\(a)", "`\(a)`", "[a](\(a))", "\(a)x/y"] { #expect(NoteText.shown(md, known: &known).text == md) }
    let quoted = "'/home/my me/.cache/ah/uploads/2026-11-22T10-00-00-000Z-a.png'"
    let shown = NoteText.shown("look \(quoted)", known: &known)
    #expect(shown.text == "look @a.png")
    #expect(NoteText.markdown(shown.text, paths: NoteText.tokenPaths(known, files: [])) == "look \(quoted)")
    // A file still on its way is its token, whatever an earlier one of that name was.
    #expect(NoteText.markdown("@a.png", paths: NoteText.tokenPaths(known, files: [(token: "a.png", path: nil)])) == "@a.png")
}

/// A host for a note's files: uploads (held until let go), a folder's listing, and @ completion.
private actor FilesHostState {
    private(set) var asked: [String] = []
    private var open = false
    func letGo() { open = true }
    func record(_ line: String) { asked.append(line) }
    func waitToOpen() async { while !open { try? await Task.sleep(for: .milliseconds(5)) } }
}

private struct FilesHostTransport: HTTPTransport {
    let state: FilesHostState

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let q = { (name: String) in query.first { $0.name == name }?.value ?? "" }
        await state.record("\(request.httpMethod ?? "GET") \(url.path) \(query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&"))")
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        switch url.path {
        case "/api/fs/complete":
            let files = ["docs/plan.md", "README.md"].filter { q("q").isEmpty || $0.contains(q("q")) }
            return (try JSONSerialization.data(withJSONObject: files), ok)
        case "/api/fs/list":
            let entries: [[String: Any]] = q("path") == "/work/proj/docs" ? [["name": "plan.md", "type": "file", "size": 1, "mtime": 1]] : []
            return (try JSONSerialization.data(withJSONObject: ["path": q("path"), "parent": NSNull(), "entries": entries]), ok)
        default:
            return (Data(#"{"error":"not found"}"#.utf8), HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        }
    }

    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) {
        await state.waitToOpen()
        let name = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "name" }?.value ?? "upload"
        return (try JSONSerialization.data(withJSONObject: ["path": up(name, "2026-11-22T11-00-00-000Z")]), HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!)
    }

    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func notesWithFiles(completes: Bool = true) throws -> (NotesModel, FilesHostState) {
    let state = FilesHostState()
    let api = APIClient(origin: URL(string: "https://box.example.ts.net")!, transport: FilesHostTransport(state: state), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let notes = NotesModel(repository: NoteRepository(database: try AppDatabase(directory: root)), outbox: Outbox(), saveDelay: .milliseconds(10), syncDelay: .seconds(3600))
    notes.voice = { _ in (api, { false }) }
    notes.filesHost = { _ in NotesModel.FilesHost(hostname: "box", home: "/home/me", completes: completes) }
    return (notes, state)
}

@MainActor
private func eventually(_ done: () -> Bool) async -> Bool {
    for _ in 0..<150 {
        if done() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return false
}

@MainActor
@Test func aNotesUploadsAreTilesAndChipsAndItsMarkdownKeepsTheirPaths() async throws {
    let (notes, _) = try notesWithFiles()
    let shot = up("shot.png", "2026-11-22T10-00-00-000Z")
    let note = notes.create(markdown: "Why is \(shot) red?", syncOrigin: nil)
    let doc = try #require(notes.document(note.id))
    #expect(doc.box.text == "Why is @shot.png red?")
    #expect(doc.box.attachments.map(\.path) == [shot] && doc.box.attachmentChips.count == 1, "a tile, and a chip where it is")
    // Typed after: the note keeps the path where the chip is.
    doc.box.text = "Why is @shot.png red? And blue?"
    notes.flushText(note.id)
    #expect(notes.note(note.id)?.markdown == "Why is \(shot) red? And blue?")
    // The host's version comes in: the same chip, no new tile.
    let id = doc.box.attachments[0].id
    doc.show("Look: \(shot)")
    #expect(doc.box.text == "Look: @shot.png" && doc.box.attachments.map(\.id) == [id])
    // Its tile's ×: the chip goes, and the path with it.
    doc.box.removeAttachment(id)
    notes.flushText(note.id)
    #expect(notes.note(note.id)?.markdown == "Look:")
}

@MainActor
@Test func aFileAttachedToANoteIsItsTokenUntilItsUpThenItsPath() async throws {
    let (notes, state) = try notesWithFiles()
    let note = notes.create(markdown: "See ", syncOrigin: nil)
    let doc = try #require(notes.document(note.id))
    doc.box.caret = 4
    Task { await doc.box.attach(name: "photo.png", data: Data("png".utf8), image: true) }
    #expect(await eventually { doc.box.text == "See @photo.png " })
    notes.flushText(note.id)
    #expect(notes.note(note.id)?.markdown == "See @photo.png ", "on its way: its token, as written")
    #expect(notes.isUploading(note.id), "handing it on waits")
    await state.letGo()
    let path = up("photo.png", "2026-11-22T11-00-00-000Z")
    #expect(await eventually { notes.note(note.id)?.markdown == "See \(path) " }, "up: its path, where its chip is, saved on its own")
    #expect(!notes.isUploading(note.id))
    #expect(doc.box.text == "See @photo.png ", "the box still shows the chip")
}

@MainActor
@Test func atListsTheFilesInTheNotesSpaceOrWholePathsFromHome() async throws {
    let (notes, state) = try notesWithFiles()
    let filed = notes.create(markdown: "", project: NoteProject(origin: nil, host: "box", path: "/work/proj"), syncOrigin: nil)
    let doc = try #require(notes.document(filed.id))
    doc.box.text = "See @pla"
    doc.box.caret = 8
    doc.box.updateSuggestions()
    #expect(await eventually { doc.box.suggestions.map(\.value) == ["@docs/plan.md "] })
    #expect(await state.asked.contains { $0.hasPrefix("GET /api/fs/complete dir=/work/proj&q=pla") })
    doc.box.accept(doc.box.suggestions[0])
    #expect(doc.box.text == "See @docs/plan.md ")
    // A file that's there is a chip.
    #expect(await eventually { doc.box.fileMentions.map(\.path) == ["docs/plan.md"] })

    // In no Space: whole paths from the host's home, since whoever takes it on works elsewhere.
    let loose = notes.create(markdown: "", syncOrigin: nil)
    let other = try #require(notes.document(loose.id))
    other.box.text = "@READ"
    other.box.caret = 5
    other.box.updateSuggestions()
    #expect(await eventually { other.box.suggestions.map(\.value) == ["@/home/me/README.md "] })
}

@MainActor
@Test func aHostWithoutFolderFilesListsNothingForTheAt() async throws {
    let (notes, state) = try notesWithFiles(completes: false)
    let note = notes.create(markdown: "", project: NoteProject(origin: nil, host: "box", path: "/work/proj"), syncOrigin: nil)
    let doc = try #require(notes.document(note.id))
    doc.box.text = "@pla"
    doc.box.caret = 4
    doc.box.updateSuggestions()
    try await Task.sleep(for: .milliseconds(300))
    #expect(doc.box.suggestions.isEmpty)
    #expect(await !state.asked.contains { $0.contains("/api/fs/complete") }, "an older host isn't asked")
}
