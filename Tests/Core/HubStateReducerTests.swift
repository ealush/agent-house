import Foundation
import Observation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Synthetic API 28 contract examples; no server, agents or user data is used.
private let sessionJSON = #"""
{
  "id":"@1", "uid":"stable-uid", "name":"agent", "title":"Review changes",
  "agent":"codex", "model":"test-model", "statusSource":"hook",
  "project":"example", "projectPath":"~/example", "branch":"feature", "worktree":true,
  "status":"waiting", "detail":"Permission needed", "limit":null,
  "ask":{"kind":"command","text":"Run tests?","options":[{"key":"1","label":"Yes"}]},
  "answerable":true, "viewers":1, "devices":["Test iPad"],
  "activity":1792700000.5, "createdAt":1792690000, "panes":1, "pinned":false,
  "queued":2, "order":null, "feed":"codex"
}
"""#

private func stateEvent(windows: String = "[\(sessionJSON)]", api: Int = 28) -> ServerSentEvent {
    ServerSentEvent(name: "state", data: """
    {"api":\(api),"hostname":"hub","hosts":[{"name":"hub","self":true,"online":true}],
     "windows":\(windows),"focus":{"key":"stable-uid","device":"Test iPad","client":"client-1","at":1792700000},
     "history":[],"presets":[],"review":null,"futureField":{"ignored":true}}
    """)
}

@Test func decodesTheAuditedStateContract() throws {
    var reducer = HubStateReducer()
    #expect(try reducer.apply(stateEvent()))
    let state = try #require(reducer.state)
    #expect(state.hosts.first?.isSelf == true)
    let session = try #require(state.windows.first)
    #expect(session.uid == "stable-uid")
    #expect(session.activity == 1792700000.5)
    #expect(session.ask?.kind == .command)
    #expect(session.ask?.options?.first?.key == "1")
    #expect(session.status == .waiting)
    #expect(session.answerable)
}

@Test func topLevelPatchesReplaceArraysAndPreserveOmittedFields() throws {
    var reducer = HubStateReducer()
    try reducer.apply(stateEvent())
    let focus = reducer.state?.focus
    try reducer.apply(ServerSentEvent(name: "patch", data: #"{"windows":[],"history":[]}"#))
    #expect(reducer.state?.windows.isEmpty == true)
    #expect(reducer.state?.hostname == "hub")
    #expect(reducer.state?.hosts.count == 1)
    #expect(reducer.state?.focus == focus)
    try reducer.apply(ServerSentEvent(name: "patch", data: #"{"focus":null}"#))
    #expect(reducer.state?.focus == nil)
    try reducer.apply(ServerSentEvent(name: "patch", data: #"{"focus":{"key":"other","device":"Phone","client":"new","at":10}}"#))
    #expect(reducer.state?.focus?.key == "other")
}

@Test func stableSessionIdentitySurvivesTmuxWindowReplacement() throws {
    var reducer = HubStateReducer()
    try reducer.apply(stateEvent())
    let before = try #require(reducer.state?.windows.first)
    let replacement = sessionJSON.replacingOccurrences(of: "@1", with: "@99")
    try reducer.apply(ServerSentEvent(name: "patch", data: "{\"windows\":[\(replacement)]}"))
    let after = try #require(reducer.state?.windows.first)
    #expect(before.id != after.id)
    #expect(before.uid == after.uid)
}

@Test func aNewConnectionRequiresAFullSnapshot() throws {
    var reducer = HubStateReducer()
    let patch = ServerSentEvent(name: "patch", data: #"{"windows":[]}"#)
    #expect(throws: HubStateDTO.StateError.snapshotRequired) { try reducer.apply(patch) }
    try reducer.apply(stateEvent())
    reducer.reset()
    #expect(reducer.state == nil)
    #expect(throws: HubStateDTO.StateError.snapshotRequired) { try reducer.apply(patch) }
    try reducer.apply(stateEvent(windows: "[]"))
    #expect(reducer.state?.windows.isEmpty == true)
}

@Test(arguments: ["{}", "null", "{bad json", #"{"api":29}"#, #"{"windows":null}"#,
                  #"{"hostname":null}"#, #"{"hosts":null}"#, #"{"api":null}"#,
                  #"{"windows":[{"id":"@1"}]}"#])
func invalidBaselineOrPatchCannotRemainActionable(_ payload: String) throws {
    var reducer = HubStateReducer()
    // {} is a valid no-op patch, but never a valid full state.
    try reducer.apply(stateEvent())
    let name = payload == "{}" ? "state" : "patch"
    #expect(throws: (any Error).self) {
        try reducer.apply(ServerSentEvent(name: name, data: payload))
    }
    #expect(reducer.state == nil)
    #expect(throws: HubStateDTO.StateError.snapshotRequired) {
        try reducer.apply(ServerSentEvent(name: "patch", data: "{}"))
    }
}

@Test func rejectsUnknownAPIStatusesAndDuplicateSessionIdentities() throws {
    var reducer = HubStateReducer()
    #expect(throws: HubStateDTO.StateError.unsupportedAPI(29)) { try reducer.apply(stateEvent(api: 29)) }
    #expect(throws: (any Error).self) {
        try reducer.apply(stateEvent(windows: "[\(sessionJSON.replacingOccurrences(of: "waiting", with: "new-status"))]"))
    }
    #expect(throws: HubStateDTO.StateError.invalidIdentity) {
        try reducer.apply(stateEvent(windows: "[\(sessionJSON),\(sessionJSON)]"))
    }
    #expect(reducer.state == nil)
}

@Test func unknownEventsDoNotChangeStateAndWholeSnapshotsReplaceIt() throws {
    var reducer = HubStateReducer()
    try reducer.apply(stateEvent())
    let original = reducer.state
    #expect(try !reducer.apply(ServerSentEvent(name: "ping", data: "not json")))
    #expect(reducer.state == original)
    try reducer.apply(stateEvent(windows: "[]"))
    #expect(reducer.state?.windows.isEmpty == true)
    try reducer.apply(ServerSentEvent(name: "patch", data: "{}"))
    #expect(reducer.state?.windows.isEmpty == true)
}

@Test func decodesQuestionsAndPartiallyAnsweredDialogs() throws {
    let data = Data(#"""
    {"kind":"choice","text":"Choose","questions":[{"question":"Which?","header":"Mode","multiSelect":true,
      "options":[{"label":"One","description":"First"}]}],
     "dialog":{"question":"Next?","multiSelect":false,"options":[{"label":"Two","checked":true}],"total":2,"answered":1}}
    """#.utf8)
    let ask = try JSONDecoder().decode(AskDTO.self, from: data)
    #expect(ask.questions?.first?.multiSelect == true)
    #expect(ask.dialog?.answered == 1)
    #expect(ask.dialog?.options.first?.checked == true)
}

@Test func parsesSnapshotAndPatchThroughTheSameByteStream() throws {
    let snapshot = stateEvent().data.replacingOccurrences(of: "\n", with: "")
    let stream = Data("event: state\ndata: \(snapshot)\n\nevent: patch\ndata: {\"windows\":[]}\n\n".utf8)
    var parser = ServerSentEventParser()
    var reducer = HubStateReducer()
    var updates = 0
    for byte in stream {
        for event in try parser.append(Data([byte])) {
            if try reducer.apply(event) { updates += 1 }
        }
    }
    #expect(updates == 2)
    #expect(reducer.state?.windows.isEmpty == true)
}

@Test func theStateRoundTripsThroughTheSealedCacheEncoding() throws {
    let json = Data(#"{"api":28,"hostname":"desk","windows":[{"id":"%1","uid":"u1","name":"fix","statusSource":"hook","project":"ah","projectPath":"/p/ah","status":"waiting","ask":{"kind":"tool","text":"Run tests?"},"fork":{"parentUid":"u0","parentTitle":"root","rootUid":"u0","forks":1}}],"history":[{"ref":"claude:1","kind":"ended","harness":"claude","title":"old","cwd":"/p/ah","project":"ah","at":5}]}"#.utf8)
    let state = try JSONDecoder().decode(HubStateDTO.self, from: json)
    let again = try JSONDecoder().decode(HubStateDTO.self, from: JSONEncoder().encode(state))
    #expect(again == state)
}

@MainActor
@Test func aColdStartPaintsLastTimesListUntilTheHostAnswers() throws {
    let json = Data(#"{"api":28,"hostname":"desk","windows":[{"id":"%1","uid":"u1","name":"fix","statusSource":"hook","project":"ah","projectPath":"/p/ah","status":"idle"}]}"#.utf8)
    let state = try JSONDecoder().decode(HubStateDTO.self, from: json)
    let hub = HubStore(api: APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: URLSessionTransport(), credentials: AccountCredentials(token: nil, onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "c")))
    var stored: [HubStateDTO] = []
    hub.useCache(HubStore.StateCache(load: { state }, store: { stored.append($0) }))
    #expect(hub.showingCached)
    #expect(hub.rows.map(\.key) == ["u1"])
    #expect(hub.hostname == "desk")
    #expect(hub.phase == .connecting, "still says it's connecting")
    hub.saveCache(state, now: Date())
    hub.saveCache(state, now: Date().addingTimeInterval(1))
    #expect(stored.count == 1, "at most every \(HubStore.cacheInterval) s")
    hub.saveCache(state, force: true)
    #expect(stored.count == 2)
}

@Test func readsAnAgentsFolderTrustPromptAndTheLaunchFlagThatSkipsIt() throws {
    // ah's Grok trust prompt: hotkey rows, `ask.trust` names the row that trusts the folder.
    let window = sessionJSON.replacingOccurrences(
        of: #""ask":{"kind":"command","text":"Run tests?","options":[{"key":"1","label":"Yes"}]}"#,
        with: #""ask":{"kind":"screen","text":"Do you trust the contents of this directory?","options":[{"key":"y","label":"Yes, proceed"},{"key":"n","label":"No, quit"}],"trust":{"accept":"y"}}"#)
    var reducer = HubStateReducer()
    try reducer.apply(stateEvent(windows: "[\(window)]"))
    let ask = try #require(reducer.state?.windows.first?.ask)
    #expect(ask.trust?.accept == "y")
    #expect(ask.options?.map(\.label) == ["Yes, proceed", "No, quit"])
    // An ordinary prompt carries none.
    var plain = HubStateReducer()
    try plain.apply(stateEvent())
    #expect(plain.state?.windows.first?.ask?.trust == nil)

    let preset = try JSONDecoder().decode(PresetDTO.self, from: Data(#"{"id":"grok","name":"Grok","command":"grok","available":true,"trust":{"pattern":"Do you trust","accept":"^Yes, proceed"}}"#.utf8))
    #expect(preset.trust?.accept == "^Yes, proceed")
    let shell = try JSONDecoder().decode(PresetDTO.self, from: Data(#"{"id":"shell","name":"Shell","command":"","available":true}"#.utf8))
    #expect(shell.trust == nil)

    let body = { (trust: Bool?) in
        String(decoding: try JSONEncoder().encode(NewSessionRequest(preset: "grok", cwd: "~/p", session: "main", label: "", trust: trust)), as: UTF8.self)
    }
    #expect(try body(true).contains(#""trust":true"#))
    #expect(try !body(nil).contains("trust"))
}

@MainActor
@Test func theSessionListIsMadeOncePerChangeAndStillFollowsEveryChange() throws {
    let json = Data(#"{"api":28,"hostname":"desk","windows":[{"id":"%1","uid":"u1","name":"fix","statusSource":"hook","project":"ah","projectPath":"/p/ah","status":"idle"},{"id":"%2","uid":"u2","name":"docs","statusSource":"hook","project":"ah","projectPath":"/p/ah","status":"busy"}]}"#.utf8)
    let state = try JSONDecoder().decode(HubStateDTO.self, from: json)
    let hub = HubStore(api: APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: URLSessionTransport(), credentials: AccountCredentials(token: nil, onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "c")))
    #expect(hub.rows.isEmpty && hub.row("u1") == nil)
    #expect(hub.awaitingState, "nothing known yet isn't an empty list")
    // Whoever read the empty list hears of the first one (the kept answer still registers the read).
    let told = Told()
    withObservationTracking { _ = hub.rows } onChange: { told.count += 1 }
    hub.useCache(HubStore.StateCache(load: { state }, store: { _ in }))
    #expect(told.count == 1)
    #expect(hub.rows.map(\.key) == ["u1", "u2"])
    #expect(!hub.awaitingState)
    #expect(hub.row("u2")?.dto.status == .busy)
    #expect(hub.row("nope") == nil)
    // Hidden rows leave the list and the lookup, and come back.
    told.count = 0
    withObservationTracking { _ = hub.row("u1") } onChange: { told.count += 1 }
    hub.hide("u1", true)
    #expect(told.count == 1)
    #expect(hub.rows.map(\.key) == ["u2"])
    #expect(hub.row("u1") == nil)
    hub.hide("u1", false)
    #expect(hub.rows.map(\.key) == ["u1", "u2"])
    #expect(hub.row("u1")?.title == state.windows.first?.title)
}

/// Counts an observation's calls (they come on the thread that made the change: the test's).
@MainActor
@Test func aSessionsSlotHearsOnlyOfItsOwnRow() throws {
    func state(_ docs: String) throws -> HubStateDTO {
        try JSONDecoder().decode(HubStateDTO.self, from: Data(#"{"api":28,"hostname":"desk","windows":[{"id":"%1","uid":"u1","name":"fix","statusSource":"hook","project":"ah","projectPath":"/p/ah","status":"idle"},{"id":"%2","uid":"u2","name":"docs","statusSource":"hook","project":"ah","projectPath":"/p/ah","status":"\#(docs)"}]}"#.utf8))
    }
    let hub = HubStore(api: APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: URLSessionTransport(), credentials: AccountCredentials(token: nil, onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "c")))
    let fix = hub.slot("u1"), docs = hub.slot("u2")
    #expect(fix.row == nil, "nothing known yet")
    hub.useCache(HubStore.StateCache(load: { try? state("idle") }, store: { _ in }))
    #expect(fix.row?.title == hub.row("u1")?.title && docs.row?.dto.status == .idle)
    let told = Told()
    withObservationTracking { _ = fix.row } onChange: { told.count += 1 }
    // Another session changing leaves this one's screen alone.
    hub.useCache(HubStore.StateCache(load: { try? state("busy") }, store: { _ in }))
    #expect(docs.row?.dto.status == .busy)
    #expect(told.count == 0)
    hub.hide("u1", true)
    #expect(told.count == 1 && fix.row == nil)
    #expect(hub.slot("u1") === fix, "one slot a session")
}

private final class Told: @unchecked Sendable {
    var count = 0
}
