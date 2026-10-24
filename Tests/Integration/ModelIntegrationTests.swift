import Foundation
import Testing
import GRDB
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The app's models against a real host: enrollment through AppModel, one shared state
// stream, the composer's optimistic send, queue steering, cross-device drafts, sign-out.
@MainActor
@Suite(.serialized, .enabled(if: LiveHost.available, "needs scripts/integration.sh"))
struct ModelIntegrationTests {
    private func app(device: String = "iPhone") throws -> AppModel {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let services = AppServices(
            database: try AppDatabase(directory: root),
            vault: CredentialVault(store: MemorySecretStore()),
            keys: MemoryDeviceKeyStore(),
            transport: LinuxTestTransport(),
            device: DeviceDescriptor(name: device, client: DeviceDescriptor.newClientID()),
            allowLoopback: true
        )
        return AppModel(services: services)
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

    @Test func enrollingStartsOneLiveStreamAndMergesSessions() async throws {
        let app = try app()
        let account = try await app.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Model iPhone")
        #expect(account.status == .signedIn)
        _ = try await waitFor("live") { account.hub.phase == .live ? true : nil }
        let shell = try await LiveHost.launch(account.api, preset: "shell", label: "model-shell")
        let row = try await waitFor("row merged") { account.hub.row(shell.uid) }
        #expect(row.isLocal && row.key == shell.uid && row.word == .idle || row.word == .newOutput || row.word == .working)
        #expect(account.hub.presence(of: shell.uid) == .live)
        #expect(account.hub.presence(of: "nonexistent") == .gone)
        // The account survives a relaunch of the app: same database, same vault.
        let reopened = AppModel(services: app.services)
        #expect(reopened.accounts.map(\.origin) == [account.origin])
        #expect(reopened.accounts.first?.status == .signedIn)
        account.deactivate()
    }

    @Test func composerSendsOptimisticallyAndTheQueueSteers() async throws {
        let app = try app()
        let account = try await app.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Composer iPhone")
        let agent = try await LiveHost.launch(account.api, preset: "test-agent", label: "composer-agent")
        _ = try await waitFor("row") { account.hub.row(agent.uid).flatMap { $0.dto.status != .busy ? $0 : nil } }
        let session = SessionModel(key: agent.uid, hub: account.hub, outbox: app.outbox, surface: .gui)
        await session.open()
        #expect(session.surface == .terminal, "an agent without a transcript adapter is terminal-only")

        session.composer.text = "first"
        #expect(session.composer.submit(working: false))
        #expect(session.composer.text.isEmpty, "the box clears at once")
        #expect(app.outbox.items(for: agent.uid).first?.state == .sending)
        session.composer.text = "second"
        #expect(session.composer.submit(working: false))
        #expect(app.outbox.items(for: agent.uid).last?.state == .queued, "a message right after another shows as queued")
        await session.composer.settle()
        let events = session.composer.takeEvents()
        #expect(events.count == 2)
        if case .sent(let first) = events[0] { #expect(first.outcome == .delivered) } else { Issue.record("first not sent") }
        if case .sent(let second) = events[1] { #expect(second.outcome == .queued, "busy: the server queued it") } else { Issue.record("second not sent") }

        await session.queue.load()
        #expect(session.queue.items.map(\.text) == ["second"])
        #expect(session.queue.pendingRows.isEmpty, "the server's row replaced our copy")
        #expect(session.sendNextNow())
        _ = try await waitFor("steered", timeout: 10) { session.queue.sending.isEmpty && session.queue.items.isEmpty ? true : nil }
        session.close()
        account.deactivate()
    }

    @Test func theNewestTranscriptPageIsSealedAndPaintsBeforeTheStream() async throws {
        let app = try app()
        let account = try await app.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Cache iPhone")
        _ = try await waitFor("cache key") { account.cacheKey }
        let agent = try await LiveHost.launch(account.api, preset: "claude", label: "cache-agent")
        _ = try await waitFor("transcript adopted", timeout: 25) { account.hub.row(agent.uid).flatMap { $0.dto.feed != nil ? true : nil } }
        let scene = SceneModel(sceneID: "cache-window", app: app)
        scene.useAccount(account.origin)
        let session = try #require(scene.session(agent.uid))
        _ = try await waitFor("live feed", timeout: 20) { session.feed.status == .live && !session.feed.entries.isEmpty ? true : nil }
        let sealed = try await waitFor("sealed", timeout: 10) { account.cached(SessionModel.FeedCache.Entry.self, kind: .feed, key: agent.uid) }
        #expect(sealed.harness == "claude")
        #expect(sealed.page.entries.map(\.seq) == session.feed.entries.suffix(SessionModel.cachedEntries).map(\.seq))
        // At rest it's ciphertext: no row carries the entry's JSON.
        let raw = try await app.services.database.pool.read { db in try Data.fetchAll(db, sql: "SELECT sealed FROM cacheEntry WHERE kind = 'feed'") }
        #expect(!raw.isEmpty && raw.allSatisfy { !String(decoding: $0, as: UTF8.self).contains("harness") })

        // The session list is sealed too, and a cold start paints it before the host answers.
        account.hub.saveCache(force: true)
        let list = try #require(account.cached(HubStateDTO.self, kind: .state, key: "hub"))
        #expect(list.windows.contains { $0.uid == agent.uid })
        let lists = try await app.services.database.pool.read { db in try Data.fetchAll(db, sql: "SELECT sealed FROM cacheEntry WHERE kind = 'state'") }
        #expect(!lists.isEmpty && lists.allSatisfy { !String(decoding: $0, as: UTF8.self).contains("cache-agent") })
        let cold = HubStore(api: account.api)
        cold.useCache(HubStore.StateCache(load: { account.cached(HubStateDTO.self, kind: .state, key: "hub") }, store: { _ in }))
        #expect(cold.showingCached)
        #expect(cold.row(agent.uid)?.title == account.hub.row(agent.uid)?.title)

        // Another window opening the session paints the cached page before its own stream answers.
        let later = SceneModel(sceneID: "cache-window-2", app: app)
        later.useAccount(account.origin)
        let reopened = try #require(later.session(agent.uid))
        _ = try await waitFor("painted from cache", timeout: 5) { reopened.feed.entries.isEmpty ? nil : true }
        session.close()
        reopened.close()
        // Forgetting the account takes its sealed data with it.
        await app.removeLocally(account)
        let left = try await app.services.database.pool.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cacheEntry") }
        #expect(left == 0)
    }

    @Test func aRefusedSendComesBackIntoTheBox() async throws {
        let app = try app()
        let account = try await app.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Refused")
        let session = SessionModel(key: "doesnotexist", hub: account.hub, outbox: app.outbox, surface: .gui)
        session.composer.text = "lost?"
        session.composer.submit(working: false)
        await session.composer.settle()
        #expect(session.composer.text == "lost?")
        #expect(app.outbox.items(for: "doesnotexist").isEmpty)
        if case .failed(let message) = session.composer.takeEvents().first { #expect(message.hasPrefix("Couldn’t send")) } else { Issue.record("no failure event") }
        account.deactivate()
    }

    @Test func draftsFillAnUntouchedBoxButNeverOverwriteTyping() async throws {
        let phone = try app(device: "iPhone")
        let pad = try app(device: "iPad")
        let phoneAccount = try await phone.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Phone")
        let padAccount = try await pad.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Pad")
        let shell = try await LiveHost.launch(phoneAccount.api, preset: "shell", label: "draft-sync")
        let onPhone = ComposerModel(api: phoneAccount.api, outbox: phone.outbox, key: shell.uid, uid: shell.uid, isShell: true, draftDebounce: .milliseconds(50))
        let onPad = ComposerModel(api: padAccount.api, outbox: pad.outbox, key: shell.uid, uid: shell.uid, isShell: true, draftDebounce: .milliseconds(50))
        await onPad.open()
        onPhone.text = "started on the phone"
        try await Task.sleep(for: .milliseconds(300))
        await onPad.foreground()
        #expect(onPad.text == "started on the phone")
        #expect(onPad.drafts.from == "iPhone")
        // Typing on the pad that hasn't synced yet wins over what the phone saved meanwhile.
        onPhone.text = "phone again"
        try await Task.sleep(for: .milliseconds(300))
        onPad.text = "pad edit"
        await onPad.foreground()
        #expect(onPad.text == "pad edit")
        // Once synced and untouched, a box follows a newer draft from another device.
        try await Task.sleep(for: .milliseconds(300))
        onPhone.text = "phone latest"
        try await Task.sleep(for: .milliseconds(300))
        await onPad.foreground()
        #expect(onPad.text == "phone latest")
        // Sent elsewhere (draft cleared): an untouched box empties too.
        await onPhone.drafts.saveNow("")
        await onPad.foreground()
        #expect(onPad.text == "")
        phoneAccount.deactivate()
        padAccount.deactivate()
    }

    @Test func lockEndsTheSignInAndFaceIDSignsBackIn() async throws {
        let app = try app()
        let account = try await app.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: "Locker")
        _ = try await waitFor("live") { account.hub.phase == .live ? true : nil }
        await account.lock()
        #expect(account.status == .needsSignIn(nil))
        #expect(try app.services.vault.credential(origin: account.origin) == nil, "no bearer kept after locking")
        await account.signIn()
        #expect(account.status == .signedIn)
        _ = try await waitFor("live again") { account.hub.phase == .live ? true : nil }
        // Revoked from another device: the account asks to sign in again.
        let overview = try await account.api.authOverview()
        let mine = try #require(overview.sessions.first { $0.current })
        _ = try await LiveHost.hostCall("DELETE", "/api/auth/sessions/\(mine.id)")
        _ = try await waitFor("signed out by the host") { if case .needsSignIn = account.status { return true } else { return nil } }
        // Removing the device makes it enroll again.
        await account.signIn()
        try await account.removeDevice()
        if case .unenrolled = account.status {} else { Issue.record("expected unenrolled") }
        #expect(try app.services.accounts.all().isEmpty)
    }
}
