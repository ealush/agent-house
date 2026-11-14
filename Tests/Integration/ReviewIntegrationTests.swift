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

/// Review flows end to end through the app's `ReviewModel`, against a disposable stack: the
/// demo host's orbit-api #101 → #102 → #103 behind its stand-in `gh` and a bare repository
/// playing GitHub (`scripts/review-it.sh`). Nothing reaches GitHub.
@MainActor
@Suite(.serialized, .enabled(if: LiveHost.available && ProcessInfo.processInfo.environment["AH_REVIEW_DIR"] != nil))
struct ReviewIntegrationTests {
    static let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["AH_REVIEW_DIR"] ?? "/nonexistent")
    static var github: URL { dir.appendingPathComponent("github") }

    /// Git, in `dir` (or anywhere, with `-C` in `args`).
    @discardableResult
    static func git(_ args: String...) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + args
        var env = ProcessInfo.processInfo.environment
        env["GIT_AUTHOR_NAME"] = "Someone else"; env["GIT_AUTHOR_EMAIL"] = "else@example.invalid"
        env["GIT_COMMITTER_NAME"] = "Someone else"; env["GIT_COMMITTER_EMAIL"] = "else@example.invalid"
        process.environment = env
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw Timeout(what: "git \(args.joined(separator: " "))") }
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Someone else pushes to #`pr`'s branch, from a clone of their own: a new commit, its pull
    /// ref, and GitHub's idea of its head.
    static func push(_ pr: Int, branch: String, file: String, line: String) throws -> String {
        let clone = dir.appendingPathComponent("else-\(pr)")
        try? FileManager.default.removeItem(at: clone)
        try git("clone", "-q", "--branch", branch, github.appendingPathComponent("orbit-api.git").path, clone.path)
        let path = clone.appendingPathComponent(file)
        let text = (try? String(contentsOf: path, encoding: .utf8)) ?? ""
        try (text + line + "\n").write(to: path, atomically: true, encoding: .utf8)
        try git("-C", clone.path, "commit", "-qam", "A push during review")
        let head = try git("-C", clone.path, "rev-parse", "HEAD")
        try git("-C", clone.path, "push", "-q", "-f", "origin", "HEAD:\(branch)", "HEAD:refs/pull/\(pr)/head")
        let stateURL = github.appendingPathComponent("state.json")
        var state = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as! [String: Any]
        var prs = state["prs"] as! [[String: Any]]
        for i in prs.indices where prs[i]["number"] as? Int == pr { prs[i]["headRefOid"] = head }
        state["prs"] = prs
        try JSONSerialization.data(withJSONObject: state).write(to: stateURL)
        return head
    }

    static func ghState(_ pr: Int) throws -> [String: Any]? {
        let state = try JSONSerialization.jsonObject(with: Data(contentsOf: github.appendingPathComponent("state.json"))) as! [String: Any]
        return (state["prs"] as? [[String: Any]])?.first { $0["number"] as? Int == pr }
    }

    @Test func aStackIsReviewedChangedUnderTheReviewerAndMergedInOrder() async throws {
        let device = try await LiveHost.enrolled(label: "Review IT")
        let review = ReviewAPI(api: device.api)
        let summary = try await poll("the orbit-api stack", timeout: 60) { try await review.stacks().first { $0.repo == "orbit/orbit-api" } }
        _ = try await poll("its layers fetched", timeout: 60) { () -> ReviewStack? in
            let stack = try await review.sync(summary.id)
            return stack.layers.allSatisfy { $0.current != nil } && stack.layers.count == 3 ? stack : nil
        }
        let model = ReviewModel(api: device.api)
        await model.open(ReviewRoute(stack: summary.id, pr: 101))
        #expect(model.layer?.pr == 101)
        let head101 = try #require(model.layer?.current?.headSha)

        // Approving names the head shown: #101 is reviewed at it.
        await model.markReviewed()
        #expect(model.error == nil)
        #expect(model.stack?.layers.first { $0.pr == 101 }?.approved == true)
        #expect(model.confidence?.review == .current)

        // #102 is pushed to while its page is open, and the host syncs the push: an approval for
        // the head the page still shows is refused and marks nothing; the page then moves on.
        await model.select(102)
        let shown102 = try #require(model.layer?.current?.headSha)
        let pushed = try Self.push(102, branch: "cache/invalidate", file: "src/routes/teams.ts", line: "// a push during review")
        _ = try await poll("the host at #102's new head", timeout: 30) { () -> ReviewStack? in
            let synced = try await review.sync(summary.id)
            return synced.layers.first { $0.pr == 102 }?.current?.headSha == pushed ? synced : nil
        }
        do {
            _ = try await review.approve(summary.id, pr: 102, approved: true, head: shown102)
            Issue.record("an approval for the head before the push went through")
        } catch let error as APIError {
            guard case .conflict(let message) = error else { Issue.record("expected 409, got \(error)"); return }
            #expect(message.contains("moved on"))
        }
        await model.refresh()
        let now102 = try #require(model.stack?.layers.first { $0.pr == 102 }?.current?.headSha)
        #expect(now102 == pushed, "the page shows the new head")
        #expect(model.stack?.layers.first { $0.pr == 102 }?.approved == false, "the stale approval marked nothing")

        // A finding raised on the new head, at a line.
        await model.addFinding(title: "Say why the cache is dropped here", body: "", severity: .nit, path: "src/routes/teams.ts", lines: 6...6)
        #expect(model.findings(for: 102).contains { $0.title == "Say why the cache is dropped here" && $0.state == .open })

        // #103's failing lint holds it back; nothing marks it reviewed for you.
        let layer103 = try #require(model.stack?.layers.first { $0.pr == 103 })
        #expect(layer103.gates.contains { !$0.ok }, "a failing check is a closed gate")
        #expect(!layer103.approved)

        // Merge and next: a stale merge intent for #101 (a head it never had) changes nothing;
        // the head it was reviewed at merges, and the next layer comes up.
        await model.select(101)
        let stale = await model.merge(expectedHead: String(repeating: "0", count: 40))
        guard case .changed = stale else { Issue.record("a stale merge intent should stop at the client, got \(stale)"); return }
        #expect(try Self.ghState(101)?["state"] as? String == "OPEN", "nothing merged")
        let merged = await model.merge(expectedHead: head101)
        guard case .merged(let next, _, _) = merged else { Issue.record("expected a merge, got \(merged)"); return }
        #expect(next == 102)
        #expect(try Self.ghState(101)?["state"] as? String == "MERGED")
        #expect(model.layer?.pr == 102, "the next layer is up")
        // The rest of the stack now targets the trunk.
        let retargeted = try await poll("#102 retargeted", timeout: 20) { try await review.stack(summary.id).layers.first { $0.pr == 102 && $0.baseRef == "main" } }
        #expect(retargeted.baseRef == "main")
        // #102 isn't reviewed at its new head: it can't land.
        let refusedMerge = await model.merge(expectedHead: now102)
        guard case .refused = refusedMerge else { Issue.record("an unreviewed layer should be refused, got \(refusedMerge)"); return }
        #expect(try Self.ghState(102)?["state"] as? String == "OPEN")
    }
}

/// `until`, on the main actor (the review model lives there).
@MainActor
private func poll<T>(_ what: String, timeout: Double = 10, _ check: @MainActor () async throws -> T?) async throws -> T {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let value = try? await check() { return value }
        try await Task.sleep(for: .milliseconds(250))
    }
    if let value = try await check() { return value }
    throw Timeout(what: what)
}

