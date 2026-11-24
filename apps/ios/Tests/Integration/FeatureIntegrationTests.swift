import Foundation
import Testing
import GRDB
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The features used every day, end to end against a real host through the app's own models:
// files, the git panel and branches, snapshots and restore, fork into a worktree, the
// composer's model/effort/permission controls, new sessions in new folders and worktrees,
// and session management (rename, pin, reorder, end, History). Each works in its own git
// project under the host's home.
@MainActor
@Suite(.serialized, .enabled(if: LiveHost.available, "needs scripts/integration.sh"))
struct FeatureIntegrationTests {
    private func signedIn(_ label: String) async throws -> (AppModel, AccountSession) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let services = AppServices(
            database: try AppDatabase(directory: root), vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
            transport: LinuxTestTransport(), device: DeviceDescriptor(name: "iPad", client: DeviceDescriptor.newClientID()), allowLoopback: true
        )
        let app = AppModel(services: services)
        let account = try await app.enroll(address: LiveHost.origin.absoluteString, code: try await LiveHost.setupCode(), label: label)
        _ = try await waitFor("live") { account.hub.phase == .live ? true : nil }
        return (app, account)
    }

    private func waitFor<T>(_ what: String, timeout: Double = 20, _ check: @MainActor () -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let value = check() { return value }
            try await Task.sleep(for: .milliseconds(100))
        }
        if let value = check() { return value }
        throw Timeout(what: what)
    }

    /// A committed git project in the host's browsable folders: README, src/app.ts, on `main`.
    private func project(_ api: APIClient, _ name: String) async throws -> String {
        let path = "\(try await root(api))/\(name)-\(UUID().uuidString.prefix(6).lowercased())"
        try FileManager.default.createDirectory(atPath: "\(path)/src", withIntermediateDirectories: true)
        try "# \(name)\n".write(toFile: "\(path)/README.md", atomically: true, encoding: .utf8)
        try "export const answer = 41;\n".write(toFile: "\(path)/src/app.ts", atomically: true, encoding: .utf8)
        try git(path, "init", "-q", "-b", "main")
        try git(path, "add", "-A")
        try git(path, "commit", "-qm", "Start")
        return path
    }

    /// The first of the host's file roots (`files.roots`), where projects live.
    private func root(_ api: APIClient) async throws -> String {
        let top = try await api.list(path: nil, hidden: false)
        return top.roots?.first ?? top.path
    }

    /// ah shows paths under the home folder as `~/…`.
    private func expanded(_ path: String, _ api: APIClient) async throws -> String {
        path.hasPrefix("~/") ? (try await api.state().home) + path.dropFirst(1) : path
    }

    @discardableResult
    private func git(_ dir: String, _ args: String...) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=t@t.invalid"] + args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        if process.terminationStatus != 0 { throw GitFailed(args: args) }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private struct GitFailed: Error { let args: [String] }

    private func read(_ path: String) -> String? { try? String(contentsOfFile: path, encoding: .utf8) }

    /// A session started the way New Session starts one, once the host lists it.
    private func start(_ account: AccountSession, _ request: NewSessionRequest) async throws -> SessionRow {
        let created = try await account.api.create(request)
        return try await waitFor("\(request.label) listed", timeout: 25) {
            account.hub.row(created.uid).flatMap { request.preset == "shell" || $0.dto.agent == request.preset ? $0 : nil }
        }
    }

    private func idle(_ account: AccountSession, _ key: String, _ what: String) async throws {
        _ = try await waitFor(what, timeout: 25) {
            account.hub.row(key).flatMap { $0.dto.status == .idle || $0.dto.status == .attention ? true : nil }
        }
    }

    // MARK: Files

    @Test func filesBrowseReadMakeFoldersAndUpload() async throws {
        let (_, account) = try await signedIn("Files iPad")
        let repo = try await project(account.api, "files")
        let files = FilesModel(api: account.api)
        await files.open(repo)
        #expect(files.error == nil)
        let listing = try #require(files.listing)
        #expect(listing.path == repo)
        #expect(listing.parent != nil, "a project folder has a way up")
        #expect(listing.entries.contains { $0.name == "README.md" && $0.type == .file })
        #expect(listing.entries.contains { $0.name == "src" && $0.type == .dir })

        // Reading a file gives its bytes, as the reader shows them.
        let readme = try #require(listing.entries.first { $0.name == "README.md" })
        let bytes = try #require(await files.data(files.child(readme)))
        #expect(String(decoding: bytes, as: UTF8.self) == "# files\n")

        // A new folder appears in place; an upload lands inside the folder shown.
        await files.makeFolder("notes")
        #expect(files.listing?.entries.contains { $0.name == "notes" && $0.type == .dir } == true)
        await files.open("\(repo)/notes")
        await files.upload(name: "todo.txt", data: Data("ship it\n".utf8))
        #expect(files.error == nil)
        #expect(files.listing?.entries.map(\.name) == ["todo.txt"])
        #expect(read("\(repo)/notes/todo.txt") == "ship it\n")
        await files.up()
        #expect(files.listing?.path == repo)

        // Hidden files only when asked.
        #expect(files.listing?.entries.contains { $0.name == ".git" } == false)
        files.showHidden = true
        await files.reload()
        #expect(files.listing?.entries.contains { $0.name == ".git" } == true)
        account.deactivate()
    }

    // MARK: Git panel and branches

    @Test func theGitPanelReadsChangesAndSwitchesBranches() async throws {
        let (_, account) = try await signedIn("Git iPad")
        let repo = try await project(account.api, "git")
        let row = try await start(account, NewSessionRequest(preset: "shell", cwd: repo, session: "it", label: "git-shell"))
        #expect(row.dto.branch == "main")

        try "# git\n\nNow with a dark mode.\n".write(toFile: "\(repo)/README.md", atomically: true, encoding: .utf8)
        try "export const dark = true;\n".write(toFile: "\(repo)/src/theme.ts", atomically: true, encoding: .utf8)
        let diff = DiffModel(api: account.api, uid: row.dto.uid)
        await diff.load()
        #expect(diff.error == nil)
        let changes = try #require(diff.changes)
        #expect(changes.branch == "main")
        #expect(changes.files.contains { $0.path == "README.md" })
        #expect(diff.untracked.map(\.path).contains("src/theme.ts"))
        let readme = try #require(diff.files.first { $0.path == "README.md" })
        #expect(readme.additions == 2 && readme.deletions == 0, "the patch parses into the diff the panel draws")

        await diff.loadBranches()
        #expect(diff.branches?.current == "main")
        #expect(diff.branches?.dirty ?? 0 >= 2)
        // A name that doesn't exist yet makes the branch, uncommitted work comes along.
        #expect(await diff.switchBranch("feature/dark-mode"))
        #expect(diff.branches?.current == "feature/dark-mode")
        #expect(try git(repo, "branch", "--show-current") == "feature/dark-mode")
        _ = try await waitFor("the row follows the branch") { account.hub.row(row.key)?.dto.branch == "feature/dark-mode" ? true : nil }
        // And back to an existing one.
        #expect(await diff.switchBranch("main"))
        #expect(diff.branches?.branches.contains { $0.name == "feature/dark-mode" && !$0.current } == true)
        account.deactivate()
    }

    // MARK: Snapshots

    @Test func snapshotsCaptureEachTurnAndARestoreCanBeUndone() async throws {
        let (_, account) = try await signedIn("Snapshots iPad")
        let repo = try await project(account.api, "snaps")
        let row = try await start(account, NewSessionRequest(preset: "test-agent", cwd: repo, session: "it", label: "snap-agent", worktree: false))
        try await idle(account, row.key, "agent ready")
        let snapshots = SnapshotsModel(api: account.api, uid: row.dto.uid)
        func captured(_ count: Int) async throws {
            let deadline = Date().addingTimeInterval(25)
            while (snapshots.list?.snapshots.count ?? 0) < count {
                guard Date() < deadline else { throw Timeout(what: "snapshot \(count)") }
                try await Task.sleep(for: .milliseconds(300))
                await snapshots.load()
            }
        }

        // Each turn takes a snapshot of the files as they were when it started.
        try "v1\n".write(toFile: "\(repo)/a.txt", atomically: true, encoding: .utf8)
        _ = try await account.api.send(row.dto.uid, text: "first")
        try await captured(1)
        try await idle(account, row.key, "first turn done")
        try "v2\n".write(toFile: "\(repo)/a.txt", atomically: true, encoding: .utf8)
        try "bee\n".write(toFile: "\(repo)/b.txt", atomically: true, encoding: .utf8)
        _ = try await account.api.send(row.dto.uid, text: "second")
        try await captured(2)
        try await idle(account, row.key, "second turn done")

        await snapshots.load()
        let list = try #require(snapshots.list)
        #expect(list.available && list.enabled)
        #expect(list.snapshots.map(\.turn) == [2, 1])
        #expect(list.snapshots.map(\.promptExcerpt) == ["second", "first"])
        #expect(list.branch == "main")

        // Damage after turn 2, then put the files back as they were before it.
        try "v3\n".write(toFile: "\(repo)/a.txt", atomically: true, encoding: .utf8)
        try FileManager.default.removeItem(atPath: "\(repo)/b.txt")
        try "cee\n".write(toFile: "\(repo)/c.txt", atomically: true, encoding: .utf8)
        guard case .restored(let restored) = await snapshots.restore(turn: 2, interrupt: false) else {
            Issue.record("restore failed: \(snapshots.error ?? "")")
            return
        }
        #expect(restored.safety.kind == "safety")
        #expect(read("\(repo)/a.txt") == "v2\n")
        #expect(read("\(repo)/b.txt") == "bee\n")
        #expect(read("\(repo)/c.txt") == nil)
        #expect(snapshots.list?.snapshots.contains { $0.kind == "safety" } == true, "the safety snapshot shows, so Undo has a row")

        // Undo is restoring the safety snapshot.
        guard case .restored = await snapshots.restore(turn: restored.safety.turn, interrupt: false) else {
            Issue.record("undo failed: \(snapshots.error ?? "")")
            return
        }
        #expect(read("\(repo)/a.txt") == "v3\n")
        #expect(read("\(repo)/b.txt") == nil)
        #expect(read("\(repo)/c.txt") == "cee\n")

        // Off and on again for this session.
        await snapshots.setEnabled(false)
        #expect(snapshots.list?.enabled == false)
        await snapshots.setEnabled(true)
        #expect(snapshots.list?.enabled == true)
        account.deactivate()
    }

    // MARK: Fork

    @Test func aForkStartsOnItsOwnBranchInItsOwnWorktree() async throws {
        let (app, account) = try await signedIn("Fork iPad")
        let repo = try await project(account.api, "fork")
        let row = try await start(account, NewSessionRequest(preset: "claude", cwd: repo, session: "it", label: "fork-parent", worktree: false))
        _ = try await waitFor("conversation adopted", timeout: 25) { account.hub.row(row.key).flatMap { $0.dto.harnessId != nil && $0.dto.feed != nil ? true : nil } }
        try await idle(account, row.key, "parent ready")
        let session = SessionModel(key: row.key, hub: account.hub, outbox: app.outbox, surface: .gui)

        let info = try #require(await session.forkInfo())
        #expect(info.canFork, "\(info.reason ?? "")")
        #expect(info.branch == "main")
        #expect(info.head != nil)
        let request = LaunchState.forkRequest(name: "try dark", prompt: "try the dark theme", mode: info.mode ?? "default", modes: 0,
                                              inherited: (info.model, info.effort), picked: (info.model, info.effort))
        let result = try #require(await session.fork(request), "\(session.notices.map(\.text))")
        #expect(result.branch.hasPrefix("ah/"))
        #expect(FileManager.default.fileExists(atPath: "\(result.worktree)/README.md"), "the worktree is checked out")
        #expect(try git(result.worktree, "branch", "--show-current") == result.branch)
        #expect(try git(repo, "branch", "--show-current") == "main", "the parent's checkout is untouched")

        // Lineage on both rows, as the sidebar and the Forks sheet read it.
        let child = try await waitFor("fork listed with its parent") { account.hub.row(result.uid).flatMap { $0.dto.fork?.parentUid == row.dto.uid ? $0 : nil } }
        #expect(try await expanded(child.dto.cwd, account.api) == result.worktree)
        #expect(child.dto.worktree)
        _ = try await waitFor("parent counts its fork") { account.hub.row(row.key)?.dto.fork?.forks == 1 ? true : nil }

        // Worktrees lists it, owned by the fork.
        let worktrees = WorktreesModel(api: account.api)
        await worktrees.load()
        let tree = try #require(worktrees.trees.first { $0.path == result.worktree })
        #expect(tree.branch == result.branch)
        #expect(tree.live.contains { $0.id == result.uid } || tree.sessions.contains { $0.id == result.uid })
        session.close()
        account.deactivate()
    }

    // MARK: Model, effort, permissions

    @Test func modelEffortAndPermissionChangesReachTheAgent() async throws {
        let (app, account) = try await signedIn("Launch iPad")
        let repo = try await project(account.api, "launch")
        let row = try await start(account, NewSessionRequest(preset: "claude", cwd: repo, session: "it", label: "launch-agent", worktree: false, model: "deep", effort: "low"))
        #expect(row.dto.launchModel == "deep")
        #expect(row.dto.launchEffort == "low")
        _ = try await waitFor("conversation adopted", timeout: 25) { account.hub.row(row.key).flatMap { $0.dto.harnessId != nil ? true : nil } }
        try await idle(account, row.key, "agent ready")
        let session = SessionModel(key: row.key, hub: account.hub, outbox: app.outbox, surface: .gui)
        #expect(session.launch.model?.id == "deep")
        #expect(session.launch.levels == ["low", "medium", "high"])

        // Effort switches live: the agent's own command, typed into it.
        let effort = session.plan(effort: "high")
        #expect(effort == .switchLive(LaunchState.Change(effort: "high")))
        #expect(await session.apply(effort) == nil)
        #expect(session.notices.last?.text == "Switched to high effort" || session.notices.last?.text == "Switching to high effort when the agent is free", "\(session.notices.map(\.text))")
        // The agent took "/effort high" as a turn: straight away the host refuses a relaunch,
        // and the app says to wait rather than passing the refusal on.
        let tooSoon = session.planMode("auto")
        if case .relaunch = tooSoon {
            #expect(await session.apply(tooSoon) == nil)
            #expect(session.notices.last?.text == "Wait until the session is idle to relaunch", "\(session.notices.map(\.text))")
        }
        // Once the list has caught up (the host's next tick) and the turn is over, it goes.
        try await Task.sleep(for: .seconds(2))
        try await idle(account, row.key, "agent idle after the switch")

        // A permission mode this agent can't cycle to relaunches the conversation with it.
        let mode = session.planMode("auto")
        guard case .relaunch(let change, _, _, let dangerous) = mode else {
            Issue.record("expected a relaunch, got \(mode)")
            return
        }
        #expect(change.mode == "auto")
        #expect(dangerous)
        let relaunched = try #require(await session.apply(mode), "\(session.notices.map(\.text))")
        let next = try await waitFor("relaunched with the mode", timeout: 25) { account.hub.row(relaunched).flatMap { $0.dto.launchMode == "auto" ? $0 : nil } }
        #expect(next.dto.launchModel == "deep", "the model carries over")
        #expect(try await expanded(next.dto.cwd, account.api) == repo)

        // The model relaunches too (this agent has no live model command).
        try await idle(account, relaunched, "relaunched agent ready")
        let again = SessionModel(key: relaunched, hub: account.hub, outbox: app.outbox, surface: .gui)
        let model = again.plan(model: "fast")
        guard case .relaunch = model else {
            Issue.record("expected a relaunch, got \(model)")
            return
        }
        let third = try #require(await again.apply(model), "\(again.notices.map(\.text))")
        let last = try await waitFor("relaunched with the model", timeout: 25) { account.hub.row(third).flatMap { $0.dto.launchModel == "fast" ? $0 : nil } }
        #expect(last.dto.launchMode == "auto", "the mode carries over")
        session.close()
        again.close()
        account.deactivate()
    }

    // MARK: New session

    @Test func aNewSessionMakesItsFolderOrItsOwnWorktree() async throws {
        let (app, account) = try await signedIn("New iPad")
        let repo = try await project(account.api, "new")
        let fresh = "\(try await root(account.api))/brand-new-\(UUID().uuidString.prefix(6).lowercased())"

        // The folder field's live hint.
        #expect(try await account.api.dir(repo).state == .dir)
        #expect(try await account.api.dir(fresh).state == .new)
        #expect(try await account.api.dir("\(repo)/README.md").state == .file)

        // A new folder, made a git repository.
        let scene = SceneModel(sceneID: "new-session", app: app)
        scene.useAccount(account.origin)
        let made = try #require(await scene.start(NewSessionRequest(preset: "shell", cwd: fresh, session: "it", label: "fresh", create: true, git: true)))
        let madeRow = try await waitFor("fresh listed") { account.hub.row(made) }
        #expect(try await expanded(madeRow.dto.cwd, account.api) == fresh)
        #expect(FileManager.default.fileExists(atPath: "\(fresh)/.git"))
        #expect(scene.route == .session(made), "the new session opens")

        // Its own worktree off the project.
        let isolated = try #require(await scene.start(NewSessionRequest(preset: "shell", cwd: repo, session: "it", label: "isolated", worktree: true)))
        let isolatedRow = try await waitFor("worktree session listed") { account.hub.row(isolated).flatMap { $0.dto.worktree ? $0 : nil } }
        #expect(try await expanded(isolatedRow.dto.cwd, account.api) != repo)
        #expect(isolatedRow.dto.branch?.hasPrefix("ah/") == true)
        #expect(isolatedRow.dto.project == URL(fileURLWithPath: repo).lastPathComponent, "it groups with its project")

        // Recent projects offer the folders sessions ran in.
        let projects = try await account.api.projects()
        #expect(projects.contains { $0 == repo || $0.hasSuffix("/" + URL(fileURLWithPath: repo).lastPathComponent) }, "\(projects)")
        account.deactivate()
    }

    // MARK: Session management

    @Test func sessionsRenamePinReorderEndAndComeBack() async throws {
        let (app, account) = try await signedIn("Manage iPad")
        let repo = try await project(account.api, "manage")
        let a = try await start(account, NewSessionRequest(preset: "shell", cwd: repo, session: "it", label: "manage-a"))
        let b = try await start(account, NewSessionRequest(preset: "shell", cwd: repo, session: "it", label: "manage-b"))
        let c = try await start(account, NewSessionRequest(preset: "shell", cwd: repo, session: "it", label: "manage-c"))
        let session = SessionModel(key: a.key, hub: account.hub, outbox: app.outbox, surface: .terminal)

        session.renaming = "Build the dark mode"
        await session.commitRename()
        _ = try await waitFor("renamed") { account.hub.row(a.key)?.title == "Build the dark mode" ? true : nil }

        await session.togglePin()
        _ = try await waitFor("pinned") { account.hub.row(a.key)?.dto.pinned == true ? true : nil }
        // Its block: its Space's, or (spaces 3) Not in a Space, or (older hosts) its project's.
        func block() -> SessionOrdering.Section? {
            SessionOrdering.sections(account.hub.rows, multiHost: false).first { $0.rows.contains { $0.key == a.key } }
        }
        func group() -> [String] { block()?.rows.map(\.key).filter { [a.key, b.key, c.key].contains($0) } ?? [] }
        #expect(group().first == a.key, "a pin goes to the top of its block")

        // Dragging c above b, as the sidebar does it.
        let unpinned = try #require(block()).rows.filter { !$0.dto.pinned }
        for (key, order) in SessionOrdering.movedOrders(unpinned, dragged: c.key, target: b.key, after: false) {
            try await account.hub.client(forKey: key).order(SessionKey(key)?.uid ?? key, order)
        }
        account.hub.refresh()
        _ = try await waitFor("reordered") { group() == [a.key, c.key, b.key] ? true : nil }

        // Ending one keeps it in History; resuming a shell brings back a live session.
        let ending = SessionModel(key: b.key, hub: account.hub, outbox: app.outbox, surface: .terminal)
        #expect(await ending.terminate())
        _ = try await waitFor("gone from the list") { account.hub.row(b.key) == nil ? true : nil }
        let ended = try await waitFor("in History") { account.hub.history.first { $0.dto.ref == b.dto.uid } }
        #expect(ended.dto.kind == .ended)
        #expect(try await expanded(ended.dto.cwd, account.api) == repo)
        await session.togglePin()
        _ = try await waitFor("unpinned") { account.hub.row(a.key)?.dto.pinned == false ? true : nil }
        session.close()
        ending.close()
        account.deactivate()
    }
}
