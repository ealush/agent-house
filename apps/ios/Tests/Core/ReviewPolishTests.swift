import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

private func layer(_ pr: Int) -> Layer {
    Layer(pr: pr, role: "", position: pr, title: "PR \(pr)", url: "", author: "a", state: "open", draft: false, headRef: "b\(pr)", baseRef: "main", headSha: "h\(pr)", mergeable: "MERGEABLE", checks: Checks(pass: 1, fail: 0, pending: 0, failing: []), needs: "", status: .unreviewed, approved: false, samePatch: true, rebased: false, current: nil, reviewed: nil, open: 0, followups: 0, blocking: 0, dispatch: nil, gates: [], ownerUid: nil, ghStack: nil, ghPos: nil)
}

@Test func aLayersNeighborsAreTheOnesBelowAndAboveIt() {
    let layers = [layer(101), layer(102), layer(103)]
    #expect(ReviewModel.neighbor(of: 102, 1, in: layers)?.pr == 103)
    #expect(ReviewModel.neighbor(of: 102, -1, in: layers)?.pr == 101)
    // The ends have nothing past them, and a layer that isn't there has no neighbors.
    #expect(ReviewModel.neighbor(of: 103, 1, in: layers) == nil)
    #expect(ReviewModel.neighbor(of: 101, -1, in: layers) == nil)
    #expect(ReviewModel.neighbor(of: 999, 1, in: layers) == nil)
}

@Test func severitiesAndStatesAreSaidInWords() {
    #expect(Finding.Severity.allCases.map(\.label) == ["Blocking", "Should fix", "Nit"])
    #expect(Finding.State.wontfix.label == "Won’t fix")
    #expect(Finding.State.sent.label == "Sent for fixing")
    // Every state has words of its own, not the wire's.
    #expect(Set(Finding.State.allCases.map(\.label)).count == Finding.State.allCases.count)
}

@Test func aLayersDiffSplitsIntoFilesWithTheirCounts() {
    let patch = """
    diff --git a/src/a.ts b/src/a.ts
    --- a/src/a.ts
    +++ b/src/a.ts
    @@ -1,2 +1,3 @@
     one
    +two
    -three
    diff --git a/src/b.ts b/src/b.ts
    --- a/src/b.ts
    +++ b/src/b.ts
    @@ -0,0 +1,1 @@
    +new
    """
    let files = FileDiff.files(in: patch)
    #expect(files.map(\.path) == ["src/a.ts", "src/b.ts"])
    #expect(files.map(\.additions) == [1, 1])
    #expect(files.map(\.deletions) == [1, 0])
}

// MARK: A layer's page shows that layer

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A host that answers the review routes from a script: one stack per id, a diff per layer
/// that names the layer, and a wait before chosen layers' diffs (a slow one, overtaken).
private final class ScriptedReviewHost: HTTPTransport, @unchecked Sendable {
    let slow: Set<Int>
    let failing: Set<Int>
    init(slow: Set<Int> = [], failing: Set<Int> = []) {
        self.slow = slow
        self.failing = failing
    }

    private func stack(_ id: String) -> ReviewStack {
        ReviewStack(id: id, title: "Stack \(id)", repo: "o/r", repoRoot: "/r", trunk: "main", mergeMethod: "merge", methods: ["merge"], source: "tree", ghStack: nil, origin: nil, link: nil, planPath: nil, state: "open", syncedAt: 0, syncError: nil, syncing: false, owner: nil, layers: [layer(1), layer(2)], next: 1, decisions: [])
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        func ok(_ body: Data) -> (Data, HTTPURLResponse) { (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        let parts = path.split(separator: "/").map(String.init)
        // …/stacks/<id>[/…]
        guard let at = parts.firstIndex(of: "stacks"), at + 1 < parts.count else { return ok(Data("[]".utf8)) }
        let id = parts[at + 1]
        let rest = Array(parts[(at + 2)...])
        if rest.isEmpty {
            // A second stack takes its time, so what's up while it loads can be looked at.
            if id != "s1" { try await Task.sleep(for: .milliseconds(200)) }
            return ok(try JSONEncoder().encode(stack(id)))
        }
        if rest == ["findings"] { return ok(Data("[]".utf8)) }
        if rest == ["chat"] { return ok(Data(#"{"messages":[],"findings":[],"subscriptionId":null}"#.utf8)) }
        if rest.count == 3, rest[0] == "layers", let pr = Int(rest[1]) {
            switch rest[2] {
            case "diff":
                if slow.contains(pr) { try await Task.sleep(for: .milliseconds(250)) }
                if failing.contains(pr) {
                    return (Data(#"{"error":"GitHub didn’t answer"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!)
                }
                return ok(try JSONEncoder().encode(DiffOut(kind: "diff", text: "diff --git a/f\(pr).txt b/f\(pr).txt\n@@ -1 +1 @@\n-old\n+layer \(pr) of \(id)\n", truncated: false, from: "a", to: "b")))
            case "description":
                return ok(try JSONEncoder().encode(PRDescription(body: "About \(pr)", url: "")))
            case "summary":
                return ok(Data(#"{"started":false,"reason":"no subscription"}"#.utf8))
            default:
                break
            }
        }
        return (Data(#"{"error":"no such route"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func reviewModel(_ host: ScriptedReviewHost) -> ReviewModel {
    ReviewModel(api: APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "c")))
}

@MainActor
@Test func aSlowDiffForTheLayerYouLeftNeverLandsOnTheLayerYouOpened() async throws {
    let model = reviewModel(ScriptedReviewHost(slow: [1]))
    await model.open(ReviewRoute(stack: "s1"), selecting: false)
    #expect(model.stack?.layers.map(\.pr) == [1, 2])
    // Layer 1 is asked for, and layer 2 picked before its diff is back.
    let first = Task { await model.select(1) }
    try await Task.sleep(for: .milliseconds(40))
    await model.select(2)
    #expect(model.selectedPR == 2)
    #expect(model.diffFiles.map(\.path) == ["f2.txt"])
    await first.value
    #expect(model.diffFiles.map(\.path) == ["f2.txt"], "layer 1's late diff is dropped")
    #expect(model.description?.body == "About 2")
    #expect(!model.loading.contains("diff"))
    #expect(model.diffFiles.first?.additions == 1 && model.diffFiles.first?.deletions == 1)
}

@MainActor
@Test func aDiffThatFailsSaysSoWhereTheDiffGoesAndAnotherStackStartsClean() async throws {
    let model = reviewModel(ScriptedReviewHost(failing: [1]))
    await model.open(ReviewRoute(stack: "s1", pr: 1))
    #expect(model.diff == nil)
    #expect(model.diffError == "GitHub didn’t answer")
    #expect(!model.loading.contains("diff"))
    // The layer that works clears it.
    await model.select(2)
    #expect(model.diffError == nil && model.diffFiles.map(\.path) == ["f2.txt"])
    // Another stack: while it loads, nothing of the last one is up.
    let opening = Task { await model.open(ReviewRoute(stack: "s2"), selecting: false) }
    try await Task.sleep(for: .milliseconds(60))
    #expect(model.stack == nil && model.diff == nil && model.selectedPR == nil)
    await opening.value
    #expect(model.stack?.id == "s2" && model.stack?.title == "Stack s2")
}

@MainActor
@Test func theLayerOnScreenStaysUpWhileThePageReloadsIt() async throws {
    let model = reviewModel(ScriptedReviewHost(slow: [1]))
    await model.open(ReviewRoute(stack: "s1", pr: 1))
    #expect(model.diffFiles.map(\.path) == ["f1.txt"] && model.description?.body == "About 1")
    // The page comes back into view and opens the same layer again, over a slow link.
    let again = Task { await model.open(ReviewRoute(stack: "s1", pr: 1)) }
    try await Task.sleep(for: .milliseconds(80))
    #expect(model.diffFiles.map(\.path) == ["f1.txt"], "the diff stays while it refreshes")
    #expect(model.description?.body == "About 1")
    await again.value
    #expect(model.diffFiles.map(\.path) == ["f1.txt"] && !model.loading.contains("diff"))
}

// MARK: Review v2 models, session linkage, direct removal, reject/close, approve+merge, quick comment

@Test func layerConfidenceDetectsWhenOnlyReviewRemains() {
    let clean = Layer(
        pr: 10, role: "F1", position: 0, title: "Clean PR", url: "", author: "me",
        state: "open", draft: false, headRef: "feat", baseRef: "main", headSha: String(repeating: "a", count: 40),
        mergeable: "MERGEABLE", checks: Checks(pass: 2, fail: 0, pending: 0, failing: []),
        needs: "", status: .unreviewed, approved: false, samePatch: true, rebased: false,
        current: RevView(id: 1, baseSha: "b", headSha: String(repeating: "a", count: 40), patchId: "p", files: 2, additions: 10, deletions: 3, summary: nil, verdict: nil),
        reviewed: nil, open: 0, followups: 0, blocking: 0, dispatch: nil,
        gates: [
            MergeGate(key: "reviewed", ok: false, label: "Reviewed", detail: "Not yet"),
            MergeGate(key: "findings", ok: true, label: "Findings", detail: nil),
            MergeGate(key: "checks", ok: true, label: "Checks", detail: nil),
            MergeGate(key: "order", ok: true, label: "Order", detail: nil),
        ],
        ownerUid: nil, ghStack: nil, ghPos: nil
    )
    let conf = LayerConfidence(layer: clean)
    #expect(conf.onlyNeedsReview == true)
    #expect(conf.readyToMerge == false)

    // With a failing check, onlyNeedsReview must stay false.
    let failing = Layer(
        pr: 11, role: "F2", position: 0, title: "Failing CI", url: "", author: "me",
        state: "open", draft: false, headRef: "feat2", baseRef: "main", headSha: String(repeating: "b", count: 40),
        mergeable: "MERGEABLE", checks: Checks(pass: 1, fail: 1, pending: 0, failing: ["test"]),
        needs: "", status: .unreviewed, approved: false, samePatch: true, rebased: false,
        current: nil, reviewed: nil, open: 0, followups: 0, blocking: 0, dispatch: nil,
        gates: [
            MergeGate(key: "reviewed", ok: false, label: "Reviewed", detail: nil),
            MergeGate(key: "checks", ok: false, label: "Checks", detail: "1 failing"),
        ],
        ownerUid: nil, ghStack: nil, ghPos: nil
    )
    #expect(LayerConfidence(layer: failing).onlyNeedsReview == false)
}

@Test func sessionStackStartPickDecodesAllThreeShapes() throws {
    let decoder = JSONDecoder()
    let single = try decoder.decode(SessionStack.self, from: Data(#"{"repo":"o/r","root":"/r","trunk":"main","source":"chain","branch":"b1","ghStack":null,"branches":[],"review":null,"start":{"pr":42}}"#.utf8))
    #expect(single.startPick == .chain(42))

    let manual = try decoder.decode(SessionStack.self, from: Data(#"{"repo":"o/r","root":"/r","trunk":"main","source":"chain","branch":"b1","ghStack":null,"branches":[],"review":null,"start":{"prs":[1,2]}}"#.utf8))
    #expect(manual.startPick == .manual([1, 2]))

    let native = try decoder.decode(SessionStack.self, from: Data(#"{"repo":"o/r","root":"/r","trunk":"main","source":"gh-stack","branch":"b1","ghStack":7,"branches":[],"review":null,"start":{"native":7}}"#.utf8))
    #expect(native.startPick == .native(7))
}

@Test func stackSummaryAndReviewStateDecodeBackwardsCompatibly() throws {
    let decoder = JSONDecoder()
    // Older host payload without new enriched fields still decodes cleanly.
    let oldSummary = try decoder.decode(StackSummary.self, from: Data(#"{"id":"s1","title":"Old","repo":"o/r","trunk":"main","state":"open","source":"tree","ghStack":null,"layers":1,"merged":0,"needsYou":0,"next":1,"syncedAt":0,"spine":[]}"#.utf8))
    #expect(oldSummary.linkedSession == nil)
    #expect(oldSummary.files == nil)

    // New host payload with enriched session, diff, checks, findings, readyToMerge.
    let newSummary = try decoder.decode(StackSummary.self, from: Data(#"{"id":"s2","title":"New","repo":"o/r","trunk":"main","state":"open","source":"tree","ghStack":null,"layers":1,"merged":0,"needsYou":0,"next":1,"syncedAt":0,"spine":[],"origin":{"uid":"u1","key":"claude:1","title":"Build auth","agent":"claude","status":"idle","live":true,"branch":"auth"},"files":4,"additions":120,"deletions":15,"openFindings":2,"blockingFindings":1,"checks":{"pass":3,"fail":0,"pending":0,"failing":[]},"readyToMerge":false}"#.utf8))
    #expect(newSummary.linkedSession?.title == "Build auth")
    #expect(newSummary.files == 4 && newSummary.additions == 120 && newSummary.blockingFindings == 1)

    // ReviewStateDTO decodes both with and without sessions[].
    let oldState = try decoder.decode(ReviewStateDTO.self, from: Data(#"{"alerts":[],"fixing":[],"branches":[]}"#.utf8))
    #expect(oldState.sessionLinks.isEmpty)

    let newState = try decoder.decode(ReviewStateDTO.self, from: Data(#"{"alerts":[],"fixing":[],"branches":[],"sessions":[{"uid":"u1","key":"claude:1","stackId":"s2","stackTitle":"New","pr":42,"role":"F1","relation":"owner","status":"unreviewed","openFindings":2,"readyToMerge":false,"needsYou":0}]}"#.utf8))
    #expect(newState.sessionLinks.count == 1)
    #expect(newState.sessionLinks[0].pr == 42)
}

private final class ReviewV2StubHost: HTTPTransport, @unchecked Sendable {
    var deletedStacks: [String] = []
    var closedPRs: [(Int, String?, Bool)] = []
    var mergeCalls: [(Int, String?, Bool)] = []
    var dispatchedComments: [String] = []
    let head = String(repeating: "a", count: 40)

    private func makeStack(_ id: String) -> ReviewStack {
        let l = Layer(
            pr: 7, role: "F1", position: 0, title: "Ship feature", url: "https://github.com/o/r/pull/7", author: "me",
            state: "open", draft: false, headRef: "feat", baseRef: "main", headSha: head, mergeable: "MERGEABLE",
            checks: Checks(pass: 1, fail: 0, pending: 0, failing: []), needs: "", status: .unreviewed, approved: false,
            samePatch: true, rebased: false,
            current: RevView(id: 1, baseSha: "b", headSha: head, patchId: "p", files: 1, additions: 5, deletions: 1, summary: nil, verdict: nil),
            reviewed: nil, open: 0, followups: 0, blocking: 0, dispatch: nil, gates: [], ownerUid: "u1", ghStack: nil, ghPos: nil
        )
        let origin = StackOwner(uid: "u1", key: "claude:1", title: "Auth work", agent: "claude", status: "idle", live: true, branch: "feat")
        return ReviewStack(id: id, title: "Auth stack", repo: "o/r", repoRoot: "/r", trunk: "main", mergeMethod: "merge", methods: ["merge"], source: "tree", ghStack: nil, origin: origin, link: nil, planPath: nil, state: "open", syncedAt: 0, syncError: nil, syncing: false, owner: origin, layers: [l], next: 7, decisions: [])
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let method = request.httpMethod ?? "GET"
        func ok(_ body: Data) -> (Data, HTTPURLResponse) { (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }

        if method == "POST", path == "/api/review/sessions/u1/open" {
            return ok(try JSONEncoder().encode(SessionReviewOpenResult(stack: makeStack("st1"), pr: 7, created: true)))
        }
        if method == "GET", path == "/api/review/stacks" {
            let sum = StackSummary(id: "st1", title: "Auth stack", repo: "o/r", trunk: "main", state: "open", source: "tree", ghStack: nil, layers: 1, merged: 0, needsYou: 0, next: 7, syncedAt: 0, spine: [])
            return ok(try JSONEncoder().encode(deletedStacks.contains("st1") ? [] : [sum]))
        }
        if method == "DELETE", path == "/api/review/stacks/st1" {
            deletedStacks.append("st1")
            return ok(Data(#"{"ok":true}"#.utf8))
        }
        if path == "/api/review/stacks/st1" || path == "/api/review/stacks/st1/sync" {
            return ok(try JSONEncoder().encode(makeStack("st1")))
        }
        if path == "/api/review/stacks/st1/findings" { return ok(Data("[]".utf8)) }
        if path == "/api/review/stacks/st1/chat" { return ok(Data(#"{"messages":[],"findings":[],"subscriptionId":null}"#.utf8)) }
        if path == "/api/review/stacks/st1/plan" { return ok(Data(#"{"path":null,"text":null}"#.utf8)) }
        if path == "/api/review/stacks/st1/layers/7/diff" { return ok(try JSONEncoder().encode(DiffOut(kind: "patch", text: "", truncated: false, from: "a", to: "b"))) }
        if path == "/api/review/stacks/st1/layers/7/description" { return ok(try JSONEncoder().encode(PRDescription(body: "", url: ""))) }
        if path == "/api/review/stacks/st1/layers/7/summary" { return ok(Data(#"{"started":false,"reason":"no subscription"}"#.utf8)) }
        if method == "POST", path == "/api/review/stacks/st1/layers/7/dispatch" {
            if let body = request.httpBody, let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let comment = obj["comment"] as? [String: Any], let title = comment["title"] as? String {
                dispatchedComments.append(title)
            }
            let d = DispatchView(id: 1, pr: 7, kind: "fix", state: "sent", targetUid: "u1", targetTitle: "Auth work", sentAt: 1, findings: [1], text: "Fix it")
            return ok(try JSONEncoder().encode(DispatchResult(dispatch: d, outcome: "delivered")))
        }
        if method == "POST", path == "/api/review/stacks/st1/layers/7/merge" {
            let obj = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
            mergeCalls.append((7, obj?["expectedHead"] as? String, obj?["approveHead"] as? Bool ?? false))
            return ok(try JSONEncoder().encode(LayerMergeResult(next: nil, restack: [], merged: [7], waiting: nil)))
        }
        if method == "POST", path == "/api/review/stacks/st1/layers/7/close" {
            let obj = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
            closedPRs.append((7, obj?["comment"] as? String, obj?["removeIfDone"] as? Bool ?? false))
            return ok(try JSONEncoder().encode(CloseLayerResult(stack: nil, removed: true)))
        }
        return (Data(#"{"error":"unexpected route"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func reviewV2EndToEndModelOperations() async throws {
    let host = ReviewV2StubHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "c"))
    let model = ReviewModel(api: api)

    // 1. Open or create directly from session u1.
    let opened = await model.openOrStartForSession("u1")
    #expect(opened?.created == true)
    #expect(opened?.route == ReviewRoute(stack: "st1", pr: 7))

    // 2. Quick comment dispatches directly to originating session.
    await model.open(ReviewRoute(stack: "st1", pr: 7))
    #expect(model.linkedSession?.uid == "u1")
    let sent = await model.sendQuickComment(title: "Guard nil token", path: "auth.swift", line: 42)
    #expect(sent?.outcome == "delivered")
    #expect(host.dispatchedComments == ["Guard nil token"])

    // 3. Approve & merge sends exact expectedHead + approveHead=true.
    let mergeOutcome = await model.merge(expectedHead: host.head, approveHead: true)
    #expect(mergeOutcome == .merged(next: nil, restack: [], waiting: nil))
    #expect(host.mergeCalls.count == 1 && host.mergeCalls[0].1 == host.head && host.mergeCalls[0].2 == true)

    // 4. Reject / close PR with comment and removeIfDone.
    let closed = await model.closeLayer(comment: "Closing", removeIfDone: true)
    #expect(closed == true)
    #expect(model.removed == true)
    #expect(host.closedPRs.count == 1 && host.closedPRs[0].1 == "Closing" && host.closedPRs[0].2 == true)

    // 5. Direct stack removal from list.
    await model.loadList()
    #expect(model.stacks.map(\.id) == ["st1"])
    let removed = await model.remove(stackId: "st1")
    #expect(removed == true)
    #expect(model.stacks.isEmpty)
    #expect(host.deletedStacks == ["st1"])
}

@MainActor
@Test func hubStoreReviewLinkResolvesPriorityAndAvoidsCrossRepoCollision() throws {
    let json = Data(#"""
    {
      "api": 28,
      "hostname": "desk",
      "windows": [],
      "review": {
        "stacks": 2,
        "needsYou": 1,
        "alerts": [],
        "fixing": [
          { "uid": "u-fix", "stackId": "st1", "pr": 10, "role": "1/2", "count": 2, "merge": false }
        ],
        "branches": [
          { "repo": "acme/web", "branch": "feat/auth", "stackId": "st2", "stackTitle": "Web Auth", "pr": 20, "role": "1/1", "status": "approved" }
        ],
        "sessions": [
          { "uid": "u-fix", "key": "u-fix", "stackId": "st1", "stackTitle": "Auth Stack", "pr": 10, "role": "1/2", "relation": "fixing", "status": "fixing", "openFindings": 2, "readyToMerge": false, "needsYou": 0 },
          { "uid": "u-origin", "key": "u-origin", "stackId": "st2", "stackTitle": "Web Auth", "pr": 20, "role": "1/1", "relation": "origin", "status": "approved", "openFindings": 0, "readyToMerge": true, "needsYou": 0 }
        ]
      }
    }
    """#.utf8)
    let state = try JSONDecoder().decode(HubStateDTO.self, from: json)
    let hub = HubStore(api: APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: URLSessionTransport(), credentials: AccountCredentials(token: nil, onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "c")))
    hub.useCache(HubStore.StateCache(load: { state }, store: { _ in }))

    let fix = try #require(hub.reviewLink(for: "u-fix", branch: "feat/auth", project: "web"))
    #expect(fix.stackId == "st1")
    #expect(fix.relation == "fixing")
    #expect(fix.label == "Fixing 2 · 1/2")

    let origin = try #require(hub.reviewLink(for: "u-origin", branch: "main", project: "web"))
    #expect(origin.stackId == "st2")
    #expect(origin.readyToMerge == true)
    #expect(origin.label == "Ready · 1/1")

    let branchSameRepo = try #require(hub.reviewLink(for: "u-other", branch: "feat/auth", project: "web"))
    #expect(branchSameRepo.stackId == "st2")
    #expect(branchSameRepo.relation == "branch")

    // Different repo with the same branch name must NOT collide.
    #expect(hub.reviewLink(for: "u-other", branch: "feat/auth", project: "mobile") == nil)
}


