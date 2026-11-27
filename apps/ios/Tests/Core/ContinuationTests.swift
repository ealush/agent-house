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

// Continue a conversation in another agent (`ContinueModel`, `ah` server/portable): what the
// app asks the host, and what it shows of the answer.

/// A host speaking `server/portable`: a scripted plan, and an operation that moves a step
/// each time it's looked at.
private final class PortableHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [(method: String, path: String, body: [String: Any])] = []
    var launchOptions = false
    var blocked: [String: String]? = nil
    var states = ["preparing", "launching", "delivering", "linked"]
    var failFirst = false
    var rejectContinueStatus: Int? = nil
    var existedFailed = false
    private var looks = 0

    func asked(_ path: String) -> [[String: Any]] { lock.withLock { requests.filter { $0.path.hasSuffix(path) }.map(\.body) } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        lock.withLock { requests.append((request.httpMethod ?? "GET", path, body)) }
        func ok(_ object: Any, status: Int = 200) -> (Data, HTTPURLResponse) {
            (try! JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        func op(_ state: String) -> [String: Any] {
            ["id": "lk-0000abcd", "kind": "portable", "strategy": "context-handoff", "state": state, "childUid": state == "preparing" ? NSNull() : "c1", "parentUid": "u1", "fromHarness": "claude", "toHarness": "codex", "fromName": "Claude Code", "toName": "Codex", "error": state == "failed" ? "the agent didn't start" : NSNull(), "limitations": []]
        }
        if path.hasSuffix("/capabilities") {
            return ok(["version": 1, "format": ["name": "ah.portable-conversation", "version": 1], "strategies": ["context-handoff"], "harnesses": [["id": "codex", "name": "Codex", "available": true, "read": true, "nativeResume": true, "nativeFork": true, "receive": true, "notes": []]], "launchOptions": launchOptions])
        }
        if path.hasSuffix("/preview") {
            let to = body["to"] as? String ?? ""
            return ok([
                "strategy": to == "claude" ? "native-fork" : "context-handoff", "kind": "portable",
                "source": ["ref": "u1", "uid": "u1", "harness": "claude", "conversationId": "pc-1", "title": "Users latency", "cwd": "~/orbit-api", "live": true, "busy": false],
                "destination": ["harness": to, "name": to == "codex" ? "Codex" : to, "cwd": "~/orbit-api", "worktree": false],
                "transfers": ["Every message you and Claude Code wrote, in order"], "limitations": [["code": "no_internal_state", "message": "Claude Code’s internal state doesn’t transfer."], ["code": "reasoning_omitted", "message": "Its reasoning isn’t carried.", "count": 12]],
                "blocked": blocked.map { $0 as Any } ?? NSNull(), "ancestor": NSNull(),
                "handoff": ["chars": 18_400, "messagesIncluded": 40, "messagesOmitted": 0, "preview": "[ah continuation …"],
                "stats": ["messages": 40, "turns": 9, "toolCalls": 31, "reasoningOmitted": 12, "unparsedLines": 0, "droppedBefore": 0],
            ])
        }
        if path.hasSuffix("/continue") {
            if let status = rejectContinueStatus {
                rejectContinueStatus = nil
                return ok(["error": "the conversation's folder is gone", "code": "cwd_missing"], status: status)
            }
            if existedFailed {
                existedFailed = false
                return ok(["operation": op("failed"), "existed": true], status: 200)
            }
            if failFirst { return ok(["operation": op("failed"), "existed": false], status: 201) }
            return ok(["operation": op("preparing"), "existed": false], status: 201)
        }
        if path.hasSuffix("/retry") { failFirst = false; looks = 0; return ok(op("preparing")) }
        if path.contains("/operations/") {
            let state = lock.withLock { () -> String in looks += 1; return states[min(looks, states.count - 1)] }
            return ok(op(state))
        }
        return ok([:], status: 404)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

private func agent(_ id: String, name: String, available: Bool = true) throws -> PresetDTO {
    try JSONDecoder().decode(PresetDTO.self, from: JSONSerialization.data(withJSONObject: ["id": id, "name": name, "command": id == "shell" ? "" : id, "available": available]))
}

@MainActor
private func model(_ host: PortableHost, preset: String? = nil) throws -> ContinueModel {
    let api = APIClient(origin: URL(string: "https://box.tail.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let presets = [try agent("shell", name: "Shell"), try agent("claude", name: "Claude Code"), try agent("codex", name: "Codex"), try agent("gemini", name: "Gemini", available: false)]
    return ContinueModel(source: .init(ref: "u1", title: "Users latency", agent: "claude", host: nil), api: api, presets: presets, preset: preset)
}

@Test func aHostSaysWhatItCanDoAndWhereAConversationCameFrom() throws {
    let state = try JSONDecoder().decode(HubStateDTO.self, from: Data(#"{"api":28,"hostname":"box","windows":[{"id":"@1","uid":"c1","name":"codex","title":"Users latency","statusSource":"hook","project":"orbit-api","projectPath":"/p","status":"idle","continued":{"linkId":"lk-0000abcd","fromUid":"u1","fromHarness":"claude","fromTitle":"Users latency","kind":"portable","strategy":"context-handoff","at":1}}],"features":{"portable":1,"uploads":2}}"#.utf8))
    #expect(state.supports("portable"))
    #expect(!state.supports("portable", version: 2))
    #expect(!state.supports("jobs"))
    #expect(state.windows.first?.continued?.fromHarness == "claude")
    let old = try JSONDecoder().decode(HubStateDTO.self, from: Data(#"{"api":28,"hostname":"box","windows":[]}"#.utf8))
    #expect(!old.supports("portable"), "a host that predates features has none")
    let odd = try JSONDecoder().decode(HubStateDTO.self, from: Data(#"{"api":28,"hostname":"box","windows":[],"features":"soon"}"#.utf8))
    #expect(odd.features == nil, "a features map it can't read is left out, never the state")
}

@MainActor
@Test func thePreviewAsksForTheChosenAgentAndSaysWhatCarriesOver() async throws {
    let host = PortableHost()
    let continuing = try model(host)
    #expect(continuing.destinations.map(\.id) == ["claude", "codex"], "agents only: no shell, nothing the host can't run")
    #expect(continuing.destination == "codex", "another agent than its own")
    continuing.model = "gpt-5.5"
    await continuing.refresh()
    let preview = try #require(host.asked("/preview").last)
    #expect(preview["to"] as? String == "codex")
    #expect(preview["intent"] as? String == "continue")
    #expect(preview["idempotencyKey"] == nil, "a preview starts nothing")
    #expect(preview["model"] == nil, "a host that doesn't take launch choices isn't sent them")
    let plan = try #require(continuing.plan)
    #expect(plan.strategy == "context-handoff")
    #expect(plan.limitations.map(\.code) == ["no_internal_state", "reasoning_omitted"])
    #expect(plan.handoff?.chars == 18_400)
    #expect(continuing.canStart)
    #expect(ContinueWords.guarantee(plan.strategy, from: "Claude Code", to: "Codex").contains("doesn’t get Claude Code’s memory or reasoning"), "never implies the other agent's state came along")
}

@MainActor
@Test func launchChoicesGoOnlyToAHostThatTakesThem() async throws {
    let host = PortableHost()
    host.launchOptions = true
    let continuing = try model(host)
    await continuing.refresh()
    continuing.model = "gpt-5.5"
    continuing.effort = "high"
    await continuing.refresh()
    let preview = try #require(host.asked("/preview").last)
    #expect(preview["model"] as? String == "gpt-5.5")
    #expect(preview["effort"] as? String == "high")
    #expect(preview["mode"] == nil, "the default mode is the host's to pick")
    continuing.destination = "claude"
    #expect(continuing.model == nil && continuing.effort == nil, "another agent's models aren't these")
}

@MainActor
@Test func aBlockedPlanCantStart() async throws {
    let host = PortableHost()
    host.blocked = ["code": "source_busy", "message": "Claude Code is working: continue in its own worktree, or wait."]
    let continuing = try model(host)
    await continuing.refresh()
    #expect(continuing.plan?.blocked?.code == "source_busy")
    #expect(!continuing.canStart)
    #expect(await continuing.start() == nil)
    #expect(host.asked("/continue").isEmpty, "nothing was asked to start")
}

@MainActor
@Test func aContinuationIsFollowedUntilTheNewSessionHasItsConversation() async throws {
    let host = PortableHost()
    let continuing = try model(host)
    await continuing.refresh()
    let child = await continuing.start(poll: .milliseconds(1))
    #expect(child == "c1")
    #expect(continuing.operation?.state == "linked")
    let sent = try #require(host.asked("/continue").first)
    #expect((sent["idempotencyKey"] as? String)?.hasPrefix("native-") == true)
    #expect(!continuing.canStart, "done: nothing more to start")
}

@MainActor
@Test func aFailedContinuationIsRetriedAsTheSameOperation() async throws {
    let host = PortableHost()
    host.failFirst = true
    let continuing = try model(host)
    await continuing.refresh()
    #expect(await continuing.start(poll: .milliseconds(1)) == nil)
    #expect(continuing.operation?.state == "failed")
    #expect(continuing.operation?.error == "the agent didn't start")
    #expect(continuing.canStart, "a failed one can go again")
    #expect(await continuing.start(poll: .milliseconds(1)) == "c1")
    #expect(host.asked("/continue").count == 1, "retried under the same link, not started twice")
    #expect(host.asked("/retry").count == 1)
}

@Test func anOperationWithoutItsAgentsNamesStillReads() throws {
    // GET /api/portable/operations lists them without fromName / toName.
    let listed = try JSONDecoder().decode(ContinueOperation.self, from: Data(#"{"id":"lk-97209986","kind":"portable","strategy":"context-handoff","state":"linked","fromHarness":"claude","toHarness":"codex","parentUid":"8ea6fa5c","childUid":"1e295a39","error":null,"createdAt":1,"updatedAt":2}"#.utf8))
    #expect(listed.isDone && listed.childUid == "1e295a39" && listed.toName == nil)
}

@Test func whereASessionCameFromIsSaidPlainly() {
    let link = ContinuedLineage(linkId: "lk-1", fromUid: "u1", fromHarness: "claude", fromTitle: "Users latency", fromHost: nil, kind: "portable", strategy: "context-handoff", at: 1)
    let names = ["claude": "Claude Code", "codex": "Codex"]
    #expect(ContinueWords.origin(link, agentName: { names[$0] ?? $0 }) == "Continued from Claude Code")
    let fork = ContinuedLineage(linkId: "lk-2", fromUid: nil, fromHarness: "codex", fromTitle: "x", fromHost: nil, kind: "fork", strategy: "native-fork", at: 1)
    #expect(ContinueWords.origin(fork, agentName: { names[$0] ?? $0 }) == "Forked from Codex")
    #expect(ContinueWords.isNative("native-fork") && !ContinueWords.isNative("context-handoff"))
    #expect(ContinueWords.stepIndex("delivering") == 2)
}

@MainActor
@Test func aRejectedStartSurfacesItsErrorAndRetriesCleanlyWhenChoicesChange() async throws {
    let host = PortableHost()
    host.rejectContinueStatus = 409
    let continuing = try model(host)
    await continuing.refresh()
    let firstKey = continuing.idempotencyKey
    #expect(await continuing.start(poll: .milliseconds(1)) == nil)
    #expect(continuing.operation == nil)
    #expect(continuing.startError == "the conversation's folder is gone")
    #expect(continuing.canStart)

    // Changing an option clears the error and rotates the key so the new choice runs fresh.
    continuing.worktree = true
    #expect(continuing.startError == nil)
    #expect(continuing.idempotencyKey != firstKey)
    await continuing.refresh()
    #expect(await continuing.start(poll: .milliseconds(1)) == "c1")
}

@MainActor
@Test func anIdempotentHitOnAFailedOperationRetriesImmediately() async throws {
    let host = PortableHost()
    host.existedFailed = true
    let continuing = try model(host)
    await continuing.refresh()
    #expect(await continuing.start(poll: .milliseconds(1)) == "c1")
    #expect(host.asked("/continue").count == 1)
    #expect(host.asked("/retry").count == 1)
}

@MainActor
@Test func changingChoicesAfterAFailedOperationStartsFreshInsteadOfRetryingTheOldOne() async throws {
    let host = PortableHost()
    host.failFirst = true
    let continuing = try model(host)
    await continuing.refresh()
    let firstKey = continuing.idempotencyKey
    #expect(await continuing.start(poll: .milliseconds(1)) == nil)
    #expect(continuing.operation?.state == "failed")

    host.failFirst = false
    continuing.worktree = true
    #expect(continuing.operation == nil)
    #expect(continuing.idempotencyKey != firstKey)
    await continuing.refresh()
    #expect(await continuing.start(poll: .milliseconds(1)) == "c1")
    #expect(host.asked("/continue").count == 2)
    #expect(host.asked("/retry").isEmpty)
}
