import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The Inbox's interrupted cards against a real host: a session's window closed mid-turn is an
// interruption the app reads (with its History item's `interrupted`), and the app's own
// InterruptionsModel restores one and dismisses another.
@Suite(.serialized, .enabled(if: LiveHost.available, "needs scripts/integration.sh"))
struct InterruptionsIntegrationTests {
    /// The host's state until `check` has something to say.
    private static func poll<T: Sendable>(_ what: String, _ api: APIClient, timeout: Double = 20, _ check: @escaping @Sendable (HubStateDTO) -> T?) async throws -> T {
        try await until(what, timeout: timeout) { check(try await api.state()) }
    }

    /// The fixture agent (a conversation of its own) cut off mid-turn: a "SLOW" message starts an
    /// 8 s turn, its conversation is ah's, and its window is closed while it works.
    private static func cutOff(_ api: APIClient, _ label: String) async throws -> String {
        let agent = try await LiveHost.launch(api, preset: "claude", label: label)
        let uid = agent.uid
        _ = try await poll("\(label) idle", api) { $0.windows.first { $0.uid == uid && $0.status != .busy } }
        _ = try await api.send(uid, text: "SLOW a long turn")
        _ = try await poll("\(label)'s conversation", api) { $0.windows.first { $0.uid == uid && $0.harnessId != nil } }
        _ = try await poll("\(label) working", api, timeout: 6) { $0.windows.first { $0.uid == uid && $0.status == .busy } }
        try LiveHost.tmux("kill-window", "-t", agent.id)
        let item = try await poll("\(label) interrupted", api) { $0.history.first { $0.ref == uid && $0.interrupted != nil } }
        #expect(item.interrupted?.cause == "window")
        #expect(item.interrupted?.midTurn == true)
        return uid
    }

    @MainActor
    @Test func aSessionCutOffMidTurnIsRestoredFromTheAppAndAnotherDismissed() async throws {
        let device = try await LiveHost.enrolled()
        let api = device.api
        let model = InterruptionsModel(api: api)

        let restored = try await Self.cutOff(api, "cut-restore")
        let state = try await api.state()
        #expect(state.supports("interruptions"))
        let incident = try #require(state.history.first { $0.ref == restored }?.interrupted?.incident)
        #expect(state.interruptions?.incidents.contains { $0.id == incident } == true)
        await model.restoreAll(incident)
        #expect(model.errors[incident] == nil)
        _ = try await Self.poll("restored: live again", api) { $0.windows.first { $0.uid == restored } }
        let after = try await api.state()
        #expect(after.interruptions?.incidents.contains { $0.id == incident } != true, "no longer waiting")

        let dismissed = try await Self.cutOff(api, "cut-dismiss")
        let other = try #require(try await api.state().history.first { $0.ref == dismissed }?.interrupted?.incident)
        await model.dismiss(other)
        #expect(model.errors[other] == nil)
        _ = try await Self.poll("dismissed", api, timeout: 10) { ($0.interruptions?.incidents.contains { $0.id == other } ?? false) ? nil : true }
        let last = try await api.state()
        #expect(last.history.first { $0.ref == dismissed }?.interrupted == nil, "forgotten as an interruption")
    }
}
