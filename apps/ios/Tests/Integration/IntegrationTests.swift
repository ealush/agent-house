import Foundation
import Testing
import SwiftTerm
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// End-to-end against a real ah (scripts/integration.sh): device sign-in, live state,
// sends/queue/answers, the GUI feed and a real terminal, all through the native client.
@Suite(.serialized, .enabled(if: LiveHost.available, "needs scripts/integration.sh"))
struct IntegrationTests {
    @Test func enrollsWithAHostCodeAndSignsInAgainWithTheDeviceKey() async throws {
        let device = try await LiveHost.enrolled(label: "Evyatar's iPhone")
        #expect(device.credential.token.count == 43)
        let hello = try await device.api.hello()
        #expect(hello.ah)
        let overview = try await device.api.authOverview()
        // The label as the server keeps it, and this sign-in marked current.
        #expect(overview.devices?.contains { $0.id == device.credential.deviceId && $0.label == "Evyatars iPhone" && $0.current } == true)
        #expect(overview.sessions.contains { $0.id == device.credential.sessionId && $0.native == true && $0.current })

        // Signing out ends the sign-in; the key signs in again.
        try await device.api.logout()
        await #expect(throws: APIError.self) { _ = try await device.api.state() }
        #expect(await device.box.rejections == 1)
        let again = try await NativeAuth(api: device.api).signIn(deviceId: device.credential.deviceId, label: "Evyatar's iPhone", key: device.key)
        await device.box.set(again.token)
        _ = try await device.api.state()

        // A code works once.
        let code = try await LiveHost.setupCode()
        _ = try await NativeAuth(api: LiveHost.client(TokenBox())).enroll(code: code, label: "one", key: SoftwareDeviceKey())
        await #expect(throws: APIError.unauthorized("invalid or expired setup code")) {
            _ = try await NativeAuth(api: LiveHost.client(TokenBox())).enroll(code: code, label: "two", key: SoftwareDeviceKey())
        }
    }

    @Test func aSignatureFromAnotherKeyIsRefused() async throws {
        let device = try await LiveHost.enrolled()
        await #expect(throws: APIError.self) {
            _ = try await NativeAuth(api: device.api).signIn(deviceId: device.credential.deviceId, label: "Test iPhone", key: SoftwareDeviceKey())
        }
    }

    @Test func liveStateArrivesAsSnapshotThenPatches() async throws {
        let device = try await LiveHost.enrolled()
        let stream = StateStream(api: device.api)
        let updates = await stream.updates()
        await stream.start()
        let first = try await next(updates, "live state") { $0.phase == .live && $0.state != nil }
        #expect(first.state?.api == 28)
        let session = try await LiveHost.launch(device.api, preset: "shell", label: "patched-in")
        let seen = try await next(updates, "new window via patch") { update in update.state?.windows.contains { $0.uid == session.uid } == true }
        #expect(seen.phase == .live)
        #expect(seen.state?.presets.contains { $0.id == "test-agent" } == true)
        await stream.stop()
    }

    @Test func sendDeliversQueuesWhileBusyAndSteersOrStops() async throws {
        let device = try await LiveHost.enrolled()
        let api = device.api
        let agent = try await LiveHost.launch(api, preset: "test-agent", label: "queue-agent")
        _ = try await until("agent idle", timeout: 20) { try await api.state().windows.first { $0.uid == agent.uid && $0.status != .busy } }

        let first = try await api.send(agent.uid, text: "first")
        #expect(first.outcome == .delivered, "typed in while idle")
        let second = try await api.send(agent.uid, text: "second")
        #expect(second.outcome == .queued, "busy: held for the next idle moment, never claimed as delivered")
        #expect(second.queued == 1)
        let third = try await api.send(agent.uid, text: "third")
        let queue = try await api.queue(agent.uid)
        #expect(queue.map(\.text) == ["second", "third"])

        // Reorder, then send the top one now (interrupting the turn).
        let moved = try await api.moveQueued(agent.uid, item: try #require(third.queueId), to: 0)
        #expect(moved.map(\.text) == ["third", "second"])
        let now = try await api.sendNow(agent.uid, item: try #require(third.queueId))
        #expect(now.outcome == .delivered)
        try await api.clearQueue(agent.uid)
        #expect(try await api.queue(agent.uid).isEmpty)

        // Stop the turn.
        _ = try await until("busy after send-now", timeout: 10) { try await api.state().windows.first { $0.uid == agent.uid && $0.status == .busy } }
        try await api.interrupt(agent.uid)
        let screen = try await until("interrupted on screen", timeout: 10) { () -> String? in
            let text = try await api.capture(agent.uid)
            return text.contains("INTERRUPTED") ? text : nil
        }
        #expect(screen.contains("RECEIVED:third"))
    }

    @Test func approvesAPermissionPromptOnlyWhileItIsShowing() async throws {
        let device = try await LiveHost.enrolled()
        let api = device.api
        let session = try await LiveHost.launch(api, preset: "test-claude", label: "permission")
        let waiting = try await until("permission prompt surfaces", timeout: 20) {
            try await api.state().windows.first { $0.uid == session.uid && $0.status == .waiting && $0.answerable }
        }
        #expect(waiting.ask != nil)
        let parts = AskParts(try #require(waiting.ask), detail: waiting.detail)
        #expect(parts.kind == "Wants to run a command" || parts.kind == "Waiting for you")
        try await api.answer(session.uid, approve: true)
        let typed = try await until("Enter reached the agent", timeout: 10) { () -> String? in
            let log = (try? String(contentsOfFile: LiveHost.pickerKeys, encoding: .utf8)) ?? ""
            return log.isEmpty ? nil : log
        }
        #expect(typed.contains("KEY:"))
    }

    @Test func aLongSessionsTranscriptStillLoads() async throws {
        // A session full of screenshots sends a snapshot of megabytes as one line: it used to
        // be refused (1 MiB line limit) and retried forever ("Connecting to the transcript…").
        let device = try await LiveHost.enrolled()
        let api = device.api
        let agent = try await LiveHost.launch(api, preset: "claude", label: "long-transcript")
        defer { Task { try? await api.terminate(agent.uid) } }
        let ready = try await until("transcript adopted", timeout: 25) { try await api.state().windows.first { $0.uid == agent.uid && $0.harnessId != nil } }
        let id = try #require(ready.harnessId)
        let dir = try #require(LiveHost.environment["AH_IT_DIR"])
        let projects = URL(fileURLWithPath: "\(dir)/claude/projects")
        let file = try #require((FileManager.default.enumerator(at: projects, includingPropertiesForKeys: nil)?.allObjects as? [URL])?.first { $0.lastPathComponent == "\(id).jsonl" })
        // Eight long replies (ah keeps up to 256 KB of each): 1.6 MB in the snapshot's one line.
        let big = String(repeating: "screenshot ", count: 18_000) + "end"
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        for n in 1...8 {
            let line = #"{"type":"assistant","uuid":"big-\#(n)","sessionId":"\#(id)","cwd":"\#(ready.cwd)","timestamp":"2026-10-26T00:00:0\#(n).000Z","message":{"role":"assistant","content":[{"type":"text","text":"\#(big)"}]}}"#
            try handle.write(contentsOf: Data((line + "\n").utf8))
        }
        try handle.close()

        let feed = FeedStream(api: api, ref: agent.uid)
        let updates = await feed.updates()
        await feed.start()
        let longReplies: @Sendable (FeedState) -> Int = { state in state.entries.filter { $0.parts.contains { if case .text(let t) = $0 { return t.count == big.count } else { return false } } }.count }
        let state = try? await next(updates, "the snapshot with the long replies", timeout: 20) { state in state.status == .live && longReplies(state) == 8 }
        let last = await feed.current
        #expect(state != nil, "status \(last.status), reason \(last.reason ?? "-"), \(last.entries.count) entries, \(longReplies(last)) long")
        await feed.stop()
    }

    @Test func guiFeedCarriesTypedTranscriptToolCallsAndWidgets() async throws {
        let device = try await LiveHost.enrolled()
        let api = device.api
        let agent = try await LiveHost.launch(api, preset: "claude", label: "feed-agent")
        let ready = try await until("transcript adopted", timeout: 25) { try await api.state().windows.first { $0.uid == agent.uid && $0.harnessId != nil } }
        #expect(ready.feed == "claude")

        let feed = FeedStream(api: api, ref: agent.uid)
        let updates = await feed.updates()
        await feed.start()
        _ = try await next(updates, "initial snapshot") { $0.status == .live && !$0.entries.isEmpty }

        let sent = try await api.send(agent.uid, text: "hello-native")
        #expect(sent.outcome == .delivered)
        let state = try await next(updates, "the reply with its tool call", timeout: 20) { state in
            state.entries.contains { $0.parts.contains { if case .widget = $0 { return true } else { return false } } }
        }
        let blocks = FeedProjection.project(state.entries)
        #expect(blocks.contains { $0.isUser && $0.text == "hello-native" }, "the prompt shows as the user's own message")
        let tools = blocks.flatMap { block -> [ToolCall] in
            guard case .agent(_, _, _, let items) = block else { return [] }
            return items.flatMap { item -> [ToolCall] in if case .tools(_, let calls) = item { return calls } else { return [] } }
        }
        let call = try #require(tools.last)
        let view = ToolPresentation(call: call, result: state.results[call.id])
        #expect(view.kind == .shell)
        #expect(view.label == "Ran")
        #expect(view.summary == "echo hello-native")
        #expect(view.status == .done)
        let widget = try #require(state.entries.flatMap(\.parts).compactMap { part -> Widget? in if case .widget(let w) = part { return w } else { return nil } }.last)
        guard case .choices(let prompt, let options) = WidgetModel(widget) else { Issue.record("not a choices widget"); return }
        #expect(prompt == "Next?")
        #expect(options.map(\.reply) == ["again", "Stop"])
        #expect(FeedProjection.lastAssistantText(state.entries).contains("Echoed **hello-native**"))

        let prompts = try await api.feedPrompts(agent.uid)
        #expect(prompts.last?.text == "hello-native")
        // Older pages exist only when the snapshot didn't carry everything.
        let page = try await api.feedPage(agent.uid, before: state.entries.last!.seq)
        #expect(page.entries.allSatisfy { $0.seq < state.entries.last!.seq })
        await feed.stop()
    }

    @Test func terminalRendersRealTmuxOutputThroughSwiftTermAndAcceptsInput() async throws {
        let device = try await LiveHost.enrolled()
        let api = device.api
        let shell = try await LiveHost.launch(api, preset: "shell", label: "term")
        let terminal = TerminalConnection(api: api, columns: 100, rows: 30) {
            try? await api.state().windows.first { $0.uid == shell.uid }?.id
        }
        let events = await terminal.events()
        let emulator = HeadlessEmulator(columns: 100, rows: 30)
        let collector = Task {
            for await event in events {
                if ProcessInfo.processInfo.environment["AH_IT_DEBUG"] != nil { print("terminal event:", event) }
                if case .output(let data) = event { await emulator.feed(data) }
            }
        }
        await terminal.start()
        _ = try await until("connected", timeout: 10) { await terminal.isConnected ? true : nil }
        #expect(await terminal.send(.input("printf 'native-%s\\n' $((6*7))\r")))
        let screen = try await until("command output on the emulated screen", timeout: 10) { () -> String? in
            let text = await emulator.screenText()
            return text.contains("native-42") ? text : nil
        }
        #expect(screen.contains("native-42"))
        // Unicode and color come through the emulator intact.
        #expect(await terminal.send(.input("printf '\\033[31mשלום 世界\\033[0m\\n'\r")))
        // Wide CJK glyphs take two cells, so compare without the cell padding.
        let unicode = try await until("unicode on screen", timeout: 10) { () -> String? in
            let text = await emulator.screenText()
            return text.contains("שלום") && text.contains("世") && text.contains("界") ? text : nil
        }
        // The output line (not the echoed command): Hebrew and CJK intact, colour codes consumed.
        let line = unicode.split(separator: "\n").first { $0.contains("世") && !$0.contains("printf") }.map(String.init) ?? ""
        #expect(line == "שלום 世界")
        await terminal.resize(columns: 60, rows: 20)
        await terminal.stop()
        #expect(await terminal.send(.input("x")) == false, "nothing is sent once disconnected")
        collector.cancel()
    }

    @Test func attachedShellRunsViaTheNativeAPIAndTerminalWithoutBecomingASession() async throws {
        let device = try await LiveHost.enrolled()
        let api = device.api
        let owner = try await LiveHost.launch(api, preset: "shell", label: "attached-owner")
        defer { Task { try? await api.terminate(owner.uid) } }
        #expect(try await api.state().supports("attachedTerminal"))
        let opened = try #require(try await api.openTerminal(owner.uid).terminal)
        let terminal = TerminalConnection(api: api, columns: 100, rows: 30) {
            try await api.attachedTerminal(owner.uid).terminal?.id
        }
        let events = await terminal.events()
        let emulator = HeadlessEmulator(columns: 100, rows: 30)
        let collector = Task {
            for await event in events {
                if case .output(let data) = event { await emulator.feed(data) }
            }
        }
        await terminal.start()
        _ = try await until("attached shell connected", timeout: 10) { await terminal.isConnected ? true : nil }
        _ = try await api.openTerminal(owner.uid, command: "printf 'companion-%s\\n' $((6*7))")
        _ = try await until("native attached output", timeout: 10) { () -> String? in
            let text = await emulator.screenText()
            return text.contains("companion-42") ? text : nil
        }
        #expect(try await api.openTerminal(owner.uid).terminal?.id == opened.id)
        let state = try await api.state()
        #expect(!state.windows.contains { $0.id == opened.id })
        #expect(state.windows.first { $0.uid == owner.uid }?.terminal?.id == opened.id)
        await terminal.stop()
        collector.cancel()
        try await api.closeTerminal(owner.uid)
        #expect(try await api.attachedTerminal(owner.uid).terminal == nil)
        #expect(try await api.state().windows.contains { $0.uid == owner.uid })
    }

    @Test func draftsFollowTheSessionAcrossDevicesAndClearWhenEmpty() async throws {
        let phone = try await LiveHost.enrolled(label: "iPhone")
        let pad = try await LiveHost.enrolled(label: "iPad")
        let shell = try await LiveHost.launch(phone.api, preset: "shell", label: "drafts")
        let saved = try await phone.api.saveDraft(shell.uid, text: "half a thought")
        #expect(saved?.text == "half a thought")
        let fromPad = try await pad.api.draft(shell.uid)
        #expect(fromPad?.text == "half a thought")
        #expect(fromPad?.client == phone.api.device.client, "the draft names the scene that wrote it")
        #expect(try await pad.api.saveDraft(shell.uid, text: "  ") == nil)
        #expect(try await phone.api.draft(shell.uid) == nil)
        try await phone.api.focus(key: shell.uid)
        let focus = try await until("focus recorded", timeout: 5) { try await pad.api.state().focus.flatMap { $0.key == shell.uid ? $0 : nil } }
        #expect(focus.device == "iPhone")
    }

    @Test func revocationSignsTheDeviceOutAndClosesItsStreamsAndTerminals() async throws {
        let device = try await LiveHost.enrolled(label: "revoked")
        let api = device.api
        let shell = try await LiveHost.launch(api, preset: "shell", label: "revoke-term")
        let stream = StateStream(api: api)
        let updates = await stream.updates()
        await stream.start()
        _ = try await next(updates, "live") { $0.phase == .live }
        let terminal = TerminalConnection(api: api) { try? await api.state().windows.first { $0.uid == shell.uid }?.id }
        let events = await terminal.events()
        await terminal.start()
        _ = try await until("terminal connected", timeout: 10) { await terminal.isConnected ? true : nil }

        _ = try await LiveHost.hostCall("DELETE", "/api/auth/sessions/\(device.credential.sessionId)")
        let ended = try await next(events, "terminal ends signed out") { $0 == .ended(.signedOut) }
        #expect(ended == .ended(.signedOut))
        let out = try await next(updates, "state stream signed out") { $0.phase == .signedOut }
        #expect(out.state == nil, "nothing stale stays on screen as if current")
        await stream.stop()
    }

    @Test func uploadsLandOwnerOnlyAndComeBackAsAttachments() async throws {
        let device = try await LiveHost.enrolled()
        let path = try await device.api.upload(name: "screen shot.png", data: Data([0x89, 0x50, 0x4E, 0x47]))
        #expect(path.contains("/ah/uploads/"))
        let message = "\(Uploads.shellQuote(path)) what is this?"
        let split = Uploads.split(message)
        #expect(split.uploads.first?.image == true)
        #expect(split.uploads.first?.name == "screen_shot.png")
        #expect(split.rest == "what is this?")
    }

    @Test @MainActor func hostAdminFromSettingsReachesTheLauncherRebuildAndTokens() async throws {
        let device = try await LiveHost.enrolled(label: "Admin iPad")
        let system = SystemSettings(api: device.api)
        await system.load()
        let before = try #require(system.desktop)
        #expect(!before.installed && before.bind.contains("bindd"))
        await system.setDesktop(install: true)
        #expect(system.desktop?.installed == true && !system.desktopMessages.isEmpty && system.error == nil)
        await system.setDesktop(install: false)
        #expect(system.desktop?.installed == false)

        await system.rebuild()
        #expect(system.buildLog == nil && system.notice != nil && !system.rebuilding)

        let security = SecuritySettings(api: device.api)
        await security.createToken(name: "  backup script ")
        let made = try #require(security.newToken)
        #expect(made.name == "backup script" && made.secret.count >= 20)
        let token = try #require(security.overview?.tokens.first { $0.name == "backup script" })
        // The secret is a working bearer for the host's API.
        let script = LiveHost.client(TokenBox(made.secret), device: "script")
        _ = try await script.state()
        security.dismissToken()
        #expect(security.newToken == nil)
        await security.removeToken(token)
        #expect(security.overview?.tokens.contains { $0.id == token.id } == false)
        await #expect(throws: APIError.self) { _ = try await script.state() }
    }
}

/// SwiftTerm's emulator without a view: the same engine the iOS terminal view drives.
actor HeadlessEmulator {
    private final class Sink: TerminalDelegate {
        func send(source: Terminal, data: ArraySlice<UInt8>) {}
    }

    private let sink = Sink()
    private let terminal: Terminal

    init(columns: Int, rows: Int) {
        terminal = Terminal(delegate: sink, options: TerminalOptions(cols: columns, rows: rows))
    }

    func feed(_ data: Data) {
        terminal.feed(byteArray: [UInt8](data))
    }

    func screenText() -> String {
        // A wide glyph's second cell holds NUL: drop it, as a renderer would.
        (0..<terminal.rows).compactMap { terminal.getLine(row: $0)?.translateToString(trimRight: true).replacingOccurrences(of: "\u{0}", with: "") }.joined(separator: "\n")
    }
}
