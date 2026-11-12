import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// A window against a real host: hardware keys through command routing, the palette, and
// restoration across a relaunch, reconciled with what the host has now.
@MainActor
@Suite(.serialized, .enabled(if: LiveHost.available, "needs scripts/integration.sh"))
struct SceneIntegrationTests {
    private func signedInApp() async throws -> (AppModel, AccountSession, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let services = AppServices(
            database: try AppDatabase(directory: root), vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
            transport: LinuxTestTransport(), device: DeviceDescriptor(name: "iPad", client: DeviceDescriptor.newClientID()), allowLoopback: true
        )
        let app = AppModel(services: services)
        let account = try await app.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Scene iPad")
        return (app, account, root)
    }

    private func waitFor<T>(_ what: String, timeout: Double = 15, _ check: @MainActor () -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let value = check() { return value }
            try await Task.sleep(for: .milliseconds(100))
        }
        if let value = check() { return value }
        throw Timeout(what: what)
    }

    private func key(_ hid: Int, _ characters: String, _ modifiers: KeyPress.Modifiers) -> KeyPress {
        KeyPress(hidUsage: hid, characters: characters, modifiers: modifiers)
    }

    @Test func aNewSessionGoesIntoTheTmuxSessionYouName() async throws {
        let (app, account, _) = try await signedInApp()
        let scene = SceneModel(sceneID: "tmux", app: app)
        scene.restore()
        scene.sheet = nil
        let key = try #require(await scene.start(NewSessionRequest(preset: "shell", cwd: "~", session: "ahit-named", label: "named-tmux")))
        let row = try await waitFor("row") { account.hub.row(key) }
        #expect(row.dto.session == "ahit-named")
        #expect(scene.route == .session(key))
        account.deactivate()
    }

    @Test func hardwareKeysDriveTheWorkspace() async throws {
        let (app, account, _) = try await signedInApp()
        let a = try await LiveHost.launch(account.api, preset: "shell", label: "keys-a")
        let b = try await LiveHost.launch(account.api, preset: "shell", label: "keys-b")
        _ = try await waitFor("rows") { account.hub.row(a.uid) != nil && account.hub.row(b.uid) != nil ? true : nil }
        let scene = SceneModel(sceneID: "keys", app: app)
        scene.hardwareKeyboard = true
        scene.restore()
        scene.sheet = nil
        scene.open(a.uid)
        #expect(scene.route == .session(a.uid))
        #expect(scene.focusRequest?.target == .terminal(a.uid), "a shell has no GUI: the keyboard goes to its terminal")

        // ⌃⇧\ splits right (physical backslash, produced "|"), ⌃⇧K is the switcher.
        #expect(scene.handle(key(0x31, "|", [.control, .shift]), scope: .terminal))
        #expect(scene.workspace.chooserFocused)
        #expect(scene.handle(key(0x0E, "k", [.control, .shift]), scope: .app))
        #expect(scene.switcher != nil)
        scene.switcher?.intoPane = scene.workspace.focusPath
        scene.pick(b.uid)
        #expect(scene.workspace.layout?.keys == [a.uid, b.uid])
        // ⌃⇧← in a composer mid-text stays with the text; at the start it moves focus.
        #expect(!scene.handle(key(0x50, "", [.control, .shift]), scope: .field, field: FieldState(text: "hello", selection: 2..<2)))
        #expect(scene.handle(key(0x50, "", [.control, .shift]), scope: .field, field: FieldState(text: "hello", selection: 0..<0)))
        #expect(scene.workspace.focusedKey == a.uid)
        #expect(scene.focusRequest?.target == .terminal(a.uid), "the keyboard moves with the focus, not just the border")
        // Swap from the palette's command, balance by ⌃⇧=, cycle by ⌃Tab: the keyboard follows.
        scene.perform("swap-pane-right")
        #expect(scene.workspace.layout?.keys == [b.uid, a.uid])
        #expect(scene.workspace.focusedKey == a.uid)
        scene.workspace.setRatio(at: [], 0.7)
        #expect(scene.handle(key(0x2E, "=", [.control, .shift]), scope: .terminal))
        if case .split(_, let ratio, _, _)? = scene.workspace.layout { #expect(abs(ratio - 0.5) < 1e-9) }
        #expect(scene.handle(key(0x2B, "\t", [.control]), scope: .terminal))
        #expect(scene.workspace.focusedKey == b.uid)
        #expect(scene.focusRequest?.target == .terminal(b.uid))
        scene.perform("swap-pane-right")
        #expect(scene.workspace.layout?.keys == [a.uid, b.uid])
        scene.workspace.focusPane(.left)
        // No workspaces 1–9: ⌥2 and ⌃⌥] are no shortcut, and the split stays.
        #expect(!scene.handle(key(0x1F, "™", [.option]), scope: .app))
        #expect(!scene.handle(key(0x30, "]", [.control, .option]), scope: .app))
        #expect(scene.workspace.layout?.keys == [a.uid, b.uid])
        // The palette hides what can't run here and puts the keyboard back when it closes.
        scene.didFocus(.terminal(a.uid))
        scene.perform("go-to-session")
        #expect(scene.palette?.path == ["go", "sessions"])
        scene.modalWillPresent()
        scene.palette = nil
        scene.modalDidDismiss()
        #expect(scene.focusRequest?.target == .terminal(a.uid))
        // Pane mode: ⌃⇧Space, then l focuses right, Esc leaves.
        #expect(scene.handle(key(0x2C, " ", [.control, .shift]), scope: .app))
        #expect(scene.handle(key(0x0F, "l", []), scope: .app))
        #expect(scene.workspace.focusedKey == b.uid)
        #expect(scene.handle(key(0x29, "", []), scope: .app))
        #expect(scene.workspace.submap == nil)
        // A plain letter is never a shortcut, and an agent's question form owns the keyboard.
        #expect(!scene.handle(key(0x04, "a", []), scope: .terminal))
        #expect(!scene.handle(key(0x0E, "k", [.command]), scope: .ask))
        // Approve does nothing for a shell (unavailable), so the key falls through.
        #expect(!scene.handle(key(0x28, "\r", [.control, .option]), scope: .app))
        // The palette lists only what can run, including live sessions.
        let tree = scene.paletteTree()
        #expect(PaletteTree.search(tree, "keys-b").contains { $0.node.action == .openSession(b.uid) })
        #expect(!PaletteTree.search(tree, "approve").contains { $0.node.action == .command("approve") })
        // Going to a session already in a pane focuses that pane rather than replacing another.
        scene.workspace.focusPane(.left)
        scene.run(.openSession(b.uid))
        #expect(scene.workspace.layout?.keys == [a.uid, b.uid] && scene.workspace.focusedKey == b.uid)
        #expect(scene.focusRequest?.target == .terminal(b.uid))
        #expect(scene.recentPaletteRows().first?.action == .openSession(b.uid))
        // A session row's choices: no workspace to move it to.
        let row = PaletteTree.search(scene.paletteTree(), "keys-b").first { $0.node.action == .openSession(b.uid) }?.node
        #expect(row?.children?.contains { $0.key == "workspace" } == false)
        account.deactivate()
    }

    @Test func aRelaunchedWindowReopensWhereItWasAndReconciles() async throws {
        let (app, account, _) = try await signedInApp()
        let keep = try await LiveHost.launch(account.api, preset: "shell", label: "restore-keep")
        let doomed = try await LiveHost.launch(account.api, preset: "shell", label: "restore-doomed")
        _ = try await waitFor("rows") { account.hub.row(keep.uid) != nil && account.hub.row(doomed.uid) != nil ? true : nil }

        let scene = SceneModel(sceneID: "restore-window", app: app)
        scene.restore()
        scene.sheet = nil
        scene.open(keep.uid)
        scene.workspace.openTile(doomed.uid, wide: true)
        scene.workspace.focusPane(.left)
        scene.perform("panel-files")
        #expect(scene.focusedSession?.panel == .files)
        scene.setSurface(.terminal, for: keep.uid)
        scene.didEnterBackground()

        // The doomed session ends while the app is gone.
        try await account.api.terminate(doomed.uid)
        _ = try await waitFor("ended") { account.hub.row(doomed.uid) == nil ? true : nil }
        account.deactivate()

        // A new process: same database, same Keychain.
        let relaunched = AppModel(services: app.services)
        let session = try #require(relaunched.accounts.first)
        session.activate()
        _ = try await waitFor("live after relaunch") { session.hub.phase == .live ? true : nil }
        let window = SceneModel(sceneID: "restore-window", app: relaunched)
        window.restore()
        _ = try await waitFor("restored") { window.isRestored ? true : nil }
        #expect(window.route == .session(keep.uid))
        #expect(window.focusedSession?.panel == .files)
        #expect(window.focusedSession?.surface == .terminal, "the device's GUI/terminal choice comes back")
        // The split had the doomed session beside the kept one: it now reopens as its record.
        let one = try #require(window.workspace.journalSpaces.slots[1]?.layout)
        #expect(one.keys.first == keep.uid)
        #expect(one.keys.count == 2)
        // Handoff: this window offers its session; another window continues it there.
        let offer = try #require(window.handoff)
        #expect(offer.route == .session(keep.uid) && offer.title == "restore-keep")
        #expect(offer.webpageURL == nil, "a loopback test host has no https page to hand to")
        let other = SceneModel(sceneID: "handoff-window", app: relaunched)
        other.restore()
        other.sheet = nil
        #expect(other.continueHandoff(try #require(Handoff(userInfo: offer.userInfo))))
        #expect(other.route == .session(keep.uid))
        #expect(!other.continueHandoff(Handoff(origin: "https://elsewhere.example.ts.net", route: .inbox, title: "")))
        session.deactivate()
    }
}
