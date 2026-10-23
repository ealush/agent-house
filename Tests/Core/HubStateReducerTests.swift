import Foundation
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
    #expect(session.identity(on: state.hostname) == SessionIdentity(host: "hub", uid: "stable-uid"))
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

@Test func stableSessionIdentitySurvivesTmuxWindowReplacementAndIsHostScoped() throws {
    var reducer = HubStateReducer()
    try reducer.apply(stateEvent())
    let before = try #require(reducer.state?.windows.first)
    let replacement = sessionJSON.replacingOccurrences(of: "@1", with: "@99")
    try reducer.apply(ServerSentEvent(name: "patch", data: "{\"windows\":[\(replacement)]}"))
    let after = try #require(reducer.state?.windows.first)
    #expect(before.id != after.id)
    #expect(before.identity(on: "hub") == after.identity(on: "hub"))
    #expect(before.identity(on: "hub") != after.identity(on: "peer"))
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
