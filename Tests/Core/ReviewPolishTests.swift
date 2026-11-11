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
