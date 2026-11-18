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

// A note as a session: its key, where it's listed, how it comes back with a window, the
// editor's lists, saving as a file, putting it in a box, and handing it to an agent.

@Test func aNoteKeyIsNeverAHostSessionKey() {
    let id = NoteKey.newID()
    let key = NoteKey.key(id)
    #expect(NoteKey.id(key) == id)
    #expect(SessionKey(key) == nil, "no host is ever asked about it")
    #expect(NoteKey.id("note:not-a-uuid") == nil)
    #expect(NoteKey.id(id) == nil)
    #expect(!NoteKey.isNote("mac/abc123"))
}

@Test func returnCarriesAListOnAndEndsItOnAnEmptyItem() {
    func enter(_ text: String) -> String? {
        let at = (text as NSString).length
        guard let next = NoteLists.continuation(of: text, at: at) else { return nil }
        return (text as NSString).replacingCharacters(in: next.replace, with: next.with)
    }
    #expect(enter("- one") == "- one\n- ")
    #expect(enter("  * nested") == "  * nested\n  * ")
    #expect(enter("- [x] done") == "- [x] done\n- [ ] ", "a new task starts unchecked")
    #expect(enter("9. nine") == "9. nine\n10. ")
    #expect(enter("> quoted") == "> quoted\n> ")
    #expect(enter("text\n- ") == "text\n", "an empty item ends the list")
    #expect(enter("plain") == nil)
    #expect(enter("# Heading") == nil)
    // Mid-line: the rest of the line becomes the next item.
    let mid = NoteLists.continuation(of: "- ab", at: 3)
    #expect(mid?.replace == NSRange(location: 3, length: 0) && mid?.with == "\n- ")
}

private func row(_ uid: String, host: String, project: String, path: String) throws -> SessionRow {
    let object: [String: Any] = ["id": "%\(uid)", "uid": uid, "name": uid, "title": uid, "statusSource": "hook", "project": project, "projectPath": path, "status": "idle", "command": "node", "agent": "claude"]
    return SessionRow(key: uid, host: host, isLocal: host == "mac", dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
}

private func summary(_ title: String, _ project: NoteProject?) -> NotesModel.Summary {
    NotesModel.Summary(id: NoteKey.newID(), title: title, project: project, sync: .synced, syncOrigin: nil, createdAt: 0, updatedAt: 0)
}

@Test func notesListUnderTheirProjectOnTheirHostAndNowhereElse() throws {
    let sections = [
        SessionOrdering.Section(id: "ah-native", rows: [try row("a1", host: "mac", project: "ah-native", path: "/Users/me/code/ah-native")]),
        SessionOrdering.Section(id: "ah", rows: [try row("b1", host: "mac", project: "ah", path: "/Users/me/code/ah")]),
    ]
    let here = summary("Restoration ideas", NoteProject(origin: nil, host: "mac", path: "/Users/me/code/ah-native"))
    // The same folder name on another machine: another project.
    let elsewhere = summary("Linux box notes", NoteProject(origin: nil, host: "linux", path: "/home/me/code/ah-native"))
    let idle = summary("No sessions yet", NoteProject(origin: nil, host: "mac", path: "/Users/me/code/new-thing"))
    let loose = summary("Shower thought", nil)
    let placed = NoteGrouping.place([here, elsewhere, idle, loose], sections: sections, multiHost: false)
    #expect(placed.inSections["ah-native"]?.map(\.id) == [here.id])
    #expect(placed.inSections["ah"] == nil)
    #expect(placed.groups.map(\.title) == ["ah-native", "new-thing", "Notes"], "its own block, then the unfiled ones last")
    #expect(placed.groups[0].notes.map(\.id) == [elsewhere.id])
    #expect(placed.groups.last?.notes.map(\.id) == [loose.id])

    // By host: a note goes under its host's block.
    let byHost = NoteGrouping.place([here, elsewhere], sections: [SessionOrdering.Section(id: "mac", rows: [])], multiHost: true)
    #expect(byHost.inSections["mac"]?.map(\.id) == [here.id])
    #expect(byHost.groups.map(\.title) == ["linux"])
}

@Test func aWindowOfNotesComesBackWithoutTheHost() {
    let a = NoteKey.key(NoteKey.newID()), b = NoteKey.key(NoteKey.newID())
    var snapshot = SceneSnapshot(sceneID: "w", hostOrigin: "https://box.example.ts.net", route: .session(a), session: .init(key: a, surface: .gui))
    #expect(SceneModel.onlyNotes(snapshot))
    snapshot.workspaces.slots[snapshot.workspaces.current] = Workspaces.Slot(layout: .split(direction: .horizontal, ratio: 0.5, first: .session(a), second: .session(LayoutNode.pickKey())), selected: nil)
    #expect(SceneModel.onlyNotes(snapshot))
    snapshot.workspaces.slots[snapshot.workspaces.current] = Workspaces.Slot(layout: .split(direction: .horizontal, ratio: 0.5, first: .session(a), second: .session("abc123")), selected: nil)
    #expect(!SceneModel.onlyNotes(snapshot), "a host session waits for its host")
    // A deleted note's pane asks what goes there; a live one stays.
    snapshot.workspaces.slots[snapshot.workspaces.current] = Workspaces.Slot(layout: .split(direction: .horizontal, ratio: 0.5, first: .session(a), second: .session(b)), selected: nil)
    let out = RestorationReconciler.reconcile(snapshot) { $0 == a ? .live : .gone }
    let leaves = out.snapshot.workspaces.slots[snapshot.workspaces.current]?.layout?.leaves().map(\.sessionKey) ?? []
    #expect(leaves.first == a)
    #expect(leaves.last.map(LayoutNode.isPick) == true)
}

@Test func aNoteSavedAsAFileIsNamedSafelyAndOnlyInsideTheProject() {
    var note = Note(title: "Session restoration: ideas / v2", markdown: "x")
    #expect(NoteFiles.fileName(for: note) == "Session restoration  ideas   v2.md")
    note.title = ""
    note.markdown = ""
    #expect(NoteFiles.fileName(for: note) == "Untitled Note.md")
    for ok in ["SPEC.md", "docs/proposals/session-restoration.md", "PLAN.md", "notes/ideas.md"] { #expect(NoteFiles.problem(ok) == nil, "\(ok)") }
    for bad in ["", "/etc/passwd", "~/x.md", "../x.md", "a/../b.md", "a//b.md", "./x.md", ".git/config", "a\\b.md"] { #expect(NoteFiles.problem(bad) != nil, "\(bad)") }
}

@Test func puttingANoteInABoxNeverLosesTheDraftUnlessAsked() {
    #expect(SceneModel.combined(draft: "", note: "# Spec", .below) == "# Spec")
    #expect(SceneModel.combined(draft: "my draft", note: "# Spec", .below) == "my draft\n\n# Spec")
    #expect(SceneModel.combined(draft: "my draft", note: "# Spec", .above) == "# Spec\n\nmy draft")
    #expect(SceneModel.combined(draft: "my draft", note: "# Spec", .replace) == "# Spec")
}

// MARK: Hand-off

/// A host's send and hand-off ledger, by `server/notes/handoff.ts`'s rules.
private final class AgentHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var ledger: [String: [String: Any]] = [:]
    private(set) var prompts: [String] = []
    var busy = false
    var loseNextAnswer = false
    var offline = false

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        if offline { throw URLError(.notConnectedToInternet) }
        let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]) ?? [:]
        func answer(_ status: Int, _ object: Any) -> (Data, HTTPURLResponse) {
            (try! JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        return try lock.withLock { () throws -> (Data, HTTPURLResponse) in
            switch url.path {
            case "/api/notes/handoffs":
                let id = body["id"] as! String, target = body["target"] as! String
                if var known = ledger[id] {
                    known["replay"] = true
                    return answer(200, known)
                }
                prompts.append(body["text"] as! String)
                let result: [String: Any] = ["id": id, "outcome": busy ? "queued" : "delivered", "queueId": busy ? id : NSNull(), "resumed": target.contains(":"), "error": NSNull(), "replay": false]
                ledger[id] = result
                if loseNextAnswer {
                    loseNextAnswer = false
                    throw URLError(.networkConnectionLost)
                }
                return answer(200, result)
            case let p where p.hasSuffix("/send"):
                prompts.append(body["text"] as! String)
                return answer(200, ["outcome": busy ? "queued" : "delivered", "windowId": "@1", "resumed": false, "queued": busy ? 1 : 0])
            case "/api/upload":
                return answer(200, ["path": "/home/me/.cache/ah/uploads/Spec.md"])
            default:
                return answer(404, ["error": "not found"])
            }
        }
    }
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) { try await data(for: request) }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func handoffBed() throws -> (NotesModel, APIClient, AgentHost, Note) {
    let database = try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    let notes = NotesModel(repository: NoteRepository(database: database), outbox: Outbox(), saveDelay: .milliseconds(10), syncDelay: .seconds(3600))
    let host = AgentHost()
    let api = APIClient(origin: URL(string: "https://box.example.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let note = notes.create(title: "Spec", markdown: "# Spec\n\nBuild the parser.", syncOrigin: nil)
    return (notes, api, host, note)
}

private let idle = NoteHandoff.Destination(key: "abc123", ref: "abc123", title: "Parser", host: nil, live: true)
private let ended = NoteHandoff.Destination(key: "claude:0f0e", ref: "claude:0f0e", title: "Old one", host: nil, live: false)

@MainActor
@Test func aNoteGoesToIdleBusyAndEndedSessionsOnceAndSaysWhatHappened() async throws {
    let (notes, api, host, note) = try handoffBed()
    let o = "https://box.example.ts.net"
    let (sent, record) = await NoteHandoff.send(note.id, to: idle, notes: notes, api: api, hostKeepsNotes: true, reachable: true, asFile: false, origin: o)
    #expect(sent == .delivered(resumed: false))
    #expect(record?.version == note.version, "which version went is kept")
    host.busy = true
    #expect(await NoteHandoff.send(note.id, to: idle, notes: notes, api: api, hostKeepsNotes: true, reachable: true, asFile: false, origin: o).0 == .queued(resumed: false))
    host.busy = false
    #expect(await NoteHandoff.send(note.id, to: ended, notes: notes, api: api, hostKeepsNotes: true, reachable: true, asFile: false, origin: o).0 == .delivered(resumed: true))
    #expect(host.prompts.count == 3)
    #expect(notes.note(note.id)?.markdown == "# Spec\n\nBuild the parser.", "the note is untouched")
    #expect(try notes.repository.handoffs(noteId: note.id).count == 3)
}

@MainActor
@Test func aLostAnswerIsUncertainAndTryAgainNeverSendsTwice() async throws {
    let (notes, api, host, note) = try handoffBed()
    let o = "https://box.example.ts.net"
    host.loseNextAnswer = true
    let (first, record) = await NoteHandoff.send(note.id, to: idle, notes: notes, api: api, hostKeepsNotes: true, reachable: true, asFile: false, origin: o)
    guard case .uncertain = first else { Issue.record("expected uncertain, got \(first)"); return }
    #expect(!first.arrived, "not claimed")
    let (again, _) = await NoteHandoff.send(note.id, to: idle, notes: notes, api: api, hostKeepsNotes: true, reachable: true, asFile: false, retrying: record, origin: o)
    #expect(again == .delivered(resumed: false))
    #expect(host.prompts.count == 1, "asked again, not sent again")
}

@MainActor
@Test func offlineNothingIsSentAndAnOlderHostGetsAPlainSend() async throws {
    let (notes, api, host, note) = try handoffBed()
    let o = "https://box.example.ts.net"
    let (offline, record) = await NoteHandoff.send(note.id, to: idle, notes: notes, api: api, hostKeepsNotes: true, reachable: false, asFile: false, origin: o)
    #expect(offline == .offline)
    #expect(record == nil)
    #expect(host.prompts.isEmpty)
    #expect(await NoteHandoff.send(note.id, to: idle, notes: notes, api: api, hostKeepsNotes: false, reachable: true, asFile: false, origin: o).0 == .delivered(resumed: false))
    #expect(host.prompts == ["# Spec\n\nBuild the parser."])

    // Too long for a message: said so, nothing sent; as a file it goes.
    let long = notes.create(markdown: String(repeating: "x", count: NoteHandoff.maxText + 1), syncOrigin: nil)
    #expect(await NoteHandoff.send(long.id, to: idle, notes: notes, api: api, hostKeepsNotes: true, reachable: true, asFile: false, origin: o).0 == .tooLong)
    #expect(await NoteHandoff.send(long.id, to: idle, notes: notes, api: api, hostKeepsNotes: true, reachable: true, asFile: true, origin: o).0 == .delivered(resumed: false))
    #expect(host.prompts.last?.hasPrefix("/home/me/.cache/ah/uploads/") == true, "the file's path leads the message")
}

// MARK: Review fixes (Codex, 18 November 2026)

@MainActor
private func scene(_ name: String) throws -> SceneModel {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(), device: DeviceDescriptor(name: "iPad", client: DeviceDescriptor.newClientID()), allowLoopback: true
    )
    return SceneModel(sceneID: name, app: AppModel(services: services))
}

@MainActor
@Test func goingToTheBackgroundPutsANotesTextOnDiskAtOnce() throws {
    let scene = try scene("background")
    let key = scene.newNote(markdown: "first")
    let id = try #require(NoteKey.id(key))
    scene.notes.document(id)!.box.text = "typed a moment before leaving"
    scene.didEnterBackground()
    // Read straight from disk, with no wait for the save timer.
    #expect(try scene.notes.repository.note(id)?.markdown == "typed a moment before leaving")
}

@MainActor
@Test func nextAndPreviousSessionGoThroughNotesToo() throws {
    let scene = try scene("cycle")
    let a = scene.newNote(markdown: "a"), b = scene.newNote(markdown: "b")
    #expect(scene.cycleOrder == [b, a])
    scene.workspace.cycle(scene.cycleOrder, 1)
    #expect(scene.workspace.selected == a)
    scene.workspace.cycle(scene.cycleOrder, 1)
    #expect(scene.workspace.selected == b)
}

@Test func aWindowWithNotesAndSessionsIsKnownToHaveNotes() {
    let a = NoteKey.key(NoteKey.newID())
    var snapshot = SceneSnapshot(sceneID: "w", hostOrigin: "https://box.example.ts.net", route: .inbox, session: nil)
    #expect(!SceneModel.hasNotes(snapshot))
    snapshot.workspaces.slots[snapshot.workspaces.current] = Workspaces.Slot(layout: .split(direction: .horizontal, ratio: 0.5, first: .session(a), second: .session("abc123")), selected: nil)
    #expect(SceneModel.hasNotes(snapshot) && !SceneModel.onlyNotes(snapshot), "offline, it comes back as it was rather than wait")
}
