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
