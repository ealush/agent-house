import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// What this repository's server sends, read with the app's own decoders. The fixtures are
// real answers from a disposable host (`packages/protocol/fixtures`, captured and kept in step
// with `wire-shapes.txt` by `apps/server/test/contract.test.ts` and `protocol.test.ts`), so a
// server change the app can't read fails here, in plain `swift test`, without a host. The
// integration suite (`scripts/integration.sh`) checks the same against a live one.

/// `packages/protocol`, from this file (`apps/ios/Tests/Core/…`: five levels below the root).
private let protocolDir = (0..<5).reduce(URL(fileURLWithPath: #filePath)) { url, _ in url.deletingLastPathComponent() }
    .appendingPathComponent("packages/protocol")

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: protocolDir.appendingPathComponent(name))
}

private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try JSONDecoder().decode(T.self, from: fixture("fixtures/\(name)"))
}

@Test func theServersAPIVersionIsTheOneThisAppAccepts() throws {
    struct Versions: Decodable { let api: Int; let features: [String: Int] }
    let versions = try JSONDecoder().decode(Versions.self, from: fixture("versions.json"))
    #expect(versions.api == HubStateDTO.supportedAPIVersion)
    let hello = try decode(Hello.self, "hello.json")
    #expect(hello.ah)
}

/// `AppProtocol.requires` is the app's own gates (check-app.mjs holds it to them); the server at
/// this checkout announces all of them, so the app never calls it behind.
@Test func theServerAtThisCheckoutServesEverythingThisAppNeeds() throws {
    let state = try decode(HubStateDTO.self, "state.json")
    #expect(!AppProtocol.requires.isEmpty)
    #expect(AppProtocol.missing(from: state.features) == [])
    struct Versions: Decodable { let features: [String: Int] }
    #expect(AppProtocol.missing(from: try JSONDecoder().decode(Versions.self, from: fixture("versions.json")).features) == [])
}

@Test func aHostBehindThisAppIsToldWhatItLacks() throws {
    let state = try decode(HubStateDTO.self, "state.json")
    var older = try #require(state.features)
    older["spaces"] = 2
    older.removeValue(forKey: "voice")
    #expect(AppProtocol.missing(from: older) == ["spaces 3", "voice 1"])
    // A host from before feature versions lacks every one.
    #expect(AppProtocol.missing(from: nil).count == AppProtocol.requires.count)
}

@Test func theServersStateDecodesWithEverySessionAndAsk() throws {
    let state = try decode(HubStateDTO.self, "state.json")
    try state.validate()
    #expect(state.windows.contains { $0.name == "contract" })
    // The agent asking permission: its question and choices come through.
    #expect(state.windows.contains { $0.ask?.options?.isEmpty == false })
    #expect(state.supports("notes"))
    #expect(state.supports("spaces"))
    #expect(state.supports("spaces", version: 2))
    #expect(state.supports("supervision"))
    #expect(state.supports("fleet"))
    #expect(state.supports("fleet", version: 2))
    #expect(state.spaces != nil, "the Spaces list's revision")
    #expect(state.fleet != nil, "the Fleet revision for live task/mail updates")
}

@Test func theServersSpacesListDecodes() throws {
    let list = try decode(SpacesListDTO.self, "spaces.json")
    #expect(list.root == "~/spaces")
    let plain = try #require(list.spaces.first { $0.name == "Contract" })
    #expect(plain.kind == .space)
    #expect(plain.path == "~/spaces/Contract")
    #expect(plain.serverId?.hasPrefix("sp-") == true)
    #expect(plain.contextPath == "~/spaces/Contract")
    // `spaces` 3: only the Spaces made there, each with the projects attached to it.
    #expect(list.spaces.allSatisfy { $0.kind == .space })
    #expect(plain.projects?.isEmpty == false)

    let attached = try decode(SpaceCreatedDTO.self, "space-projects.json")
    #expect(attached.space.name == "Contract")
    #expect(attached.space.projects == plain.projects)
}

@Test func theServersStateSaysWhichSpaceEachSessionIsIn() throws {
    let state = try decode(HubStateDTO.self, "state.json")
    #expect(state.supports("spaces", version: 3))
    #expect(HubStore.placesSpaces(state))
    let rows = state.windows.map { SessionRow(key: $0.uid, host: state.hostname, isLocal: true, dto: $0, hostPlacesSpaces: true) }
    let contract = try #require(rows.first { $0.dto.name == "contract" })
    #expect(contract.spaceName == "Contract")
    #expect(InboxProject(host: state.hostname, name: "Contract").holds(contract))
    // In no Space: its project isn't one.
    let outside = rows.filter { $0.dto.space == nil }
    #expect(!outside.isEmpty)
    #expect(outside.allSatisfy { $0.spaceName == nil && InboxProject.outside.holds($0) })
}

@Test func theServersSupervisionFleetAndSpaceBriefFixturesDecode() throws {
    let sup = try decode(SupervisionResponseDTO.self, "supervision.json")
    #expect(!sup.uid.isEmpty)
    #expect(sup.supervision?.role == .chief)
    #expect(sup.supervision?.space == "Contract")
    #expect(sup.supervision?.tags == ["space-chief"])

    let fwd = try decode(ForwardPromptResponseDTO.self, "forward.json")
    #expect(fwd.forwarded)
    #expect(!fwd.uid.isEmpty)
    #expect(fwd.answerable)
    #expect(fwd.ask?.options?.isEmpty == false)

    let task = try decode(FleetTaskDTO.self, "fleet-task.json")
    #expect(task.id.hasPrefix("tk-"))
    #expect(task.status == .todo)
    #expect(task.priority == 1)
    #expect(task.space == "Contract")
    #expect(task.verifyCmd == "true")

    let tasks = try decode(FleetTasksResponseDTO.self, "fleet-tasks.json")
    #expect(tasks.tasks.map(\.id).contains(task.id))

    let mail = try decode(FleetMailDTO.self, "fleet-mail.json")
    #expect(mail.id.hasPrefix("mb-"))
    #expect(mail.kind == .report)
    #expect(mail.subject == "Ready")

    let mailbox = try decode(FleetMailboxResponseDTO.self, "fleet-mailbox.json")
    #expect(mailbox.messages.map(\.id).contains(mail.id))

    let brief = try decode(SpaceBriefDTO.self, "space-brief.json")
    #expect(brief.space == "Contract")
    #expect(brief.brief.contains("Chief of Staff"))
    #expect(brief.contextPath == "~/spaces/Contract")

    let ctx = try decode(SpaceContextDTO.self, "space-context.json")
    #expect(ctx.space == "Contract")
    #expect(ctx.kind == .space)
    #expect(ctx.markdown.contains("# Agent House Space: Contract"))
    #expect(ctx.pointer.contains("ah space context"))
}

@Test func theServersStateStreamBuildsTheStateFromItsSnapshotAndPatches() throws {
    var parser = ServerSentEventParser()
    let events = try parser.append(fixture("fixtures/state-stream.sse"))
    #expect(events.first?.name == "state")
    #expect(events.contains { $0.name == "patch" })
    var reducer = HubStateReducer()
    for event in events { try reducer.apply(event) }
    let state = try #require(reducer.state)
    // Started after the snapshot: it arrived in a patch's windowsDelta.
    #expect(state.windows.contains { $0.name == "contract stream" })
    #expect(state.windows.contains { $0.name == "contract" })
}

/// Every field the state is read with arrives in a patch too: one the patch left out would keep
/// what the app saw at connect, whatever the host said after (the Inbox's interrupted cards did).
@Test func aPatchOfTheWholeStateGivesTheWholeState() throws {
    let full = try decode(HubStateDTO.self, "state.json")
    var reducer = HubStateReducer()
    try reducer.apply(ServerSentEvent(name: "state", data: #"{"api":\#(full.api),"hostname":"other","hosts":[],"windows":[],"history":[],"presets":[]}"#))
    try reducer.apply(ServerSentEvent(name: "patch", data: String(decoding: try fixture("fixtures/state.json"), as: UTF8.self)))
    #expect(reducer.state == full)
}

@Test func theServersAnswersToSendQueueAndCreateDecode() throws {
    let queued = try decode(SendResult.self, "send-queued.json")
    #expect(queued.outcome == .queued)
    #expect(queued.held == "picker")
    #expect(try decode(SendResult.self, "send-delivered.json").outcome == .delivered)
    let queue = try decode([QueueItem].self, "queue.json")
    #expect(queue.map(\.text) == ["after that, run the tests"])
    #expect(try decode(CreatedWindow.self, "window-created.json").uid.isEmpty == false)
    let auth = try decode(AuthStatus.self, "auth-status.json")
    #expect(auth.authenticated)
}

@Test func theServersRefusalsReadAsTheirMessage() throws {
    let answered = APIError(status: 409, body: try fixture("fixtures/error-code.json"))
    guard case .conflict(let message) = answered else {
        Issue.record("409 read as \(answered)")
        return
    }
    #expect(message == "that prompt was just answered")
    let bad = APIError(status: 400, body: try fixture("fixtures/error.json"))
    #expect(!bad.localizedDescription.isEmpty)
}
