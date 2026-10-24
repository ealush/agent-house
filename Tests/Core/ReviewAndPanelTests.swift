import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

private func layer(_ pr: Int, approved: Bool = true, samePatch: Bool = true, rebased: Bool = false, checks: Checks = Checks(pass: 3, fail: 0, pending: 0, failing: []), gates: [MergeGate]? = nil, headRef: String? = nil, baseRef: String = "main", blocking: Int = 0, open: Int = 0) -> Layer {
    let rev = RevView(id: 1, baseSha: "b", headSha: "h\(pr)", patchId: "p", files: 1, additions: 1, deletions: 0, summary: nil, verdict: nil)
    let defaultGates = [
        MergeGate(key: "reviewed", ok: approved && samePatch, label: "Reviewed revision is current", detail: approved ? (samePatch ? nil : "Changed since your review") : "Not marked reviewed yet"),
        MergeGate(key: "findings", ok: blocking == 0, label: "No open blocking findings", detail: nil),
        MergeGate(key: "checks", ok: checks.fail == 0 && checks.pending == 0, label: "Checks passed", detail: nil),
        MergeGate(key: "mergeable", ok: true, label: "Mergeable", detail: nil),
        MergeGate(key: "base", ok: baseRef == "main", label: "Targets main", detail: baseRef == "main" ? nil : "Targets \(baseRef)"),
    ]
    return Layer(pr: pr, role: "", position: pr, title: "PR \(pr)", url: "", author: "a", state: "open", draft: false, headRef: headRef ?? "b\(pr)", baseRef: baseRef, headSha: "h\(pr)", mergeable: "MERGEABLE", checks: checks, needs: "", status: approved ? .approved : .unreviewed, approved: approved, samePatch: samePatch, rebased: rebased, current: rev, reviewed: approved ? rev : nil, open: open, followups: 0, blocking: blocking, dispatch: nil, gates: gates ?? defaultGates, ownerUid: nil, ghStack: nil, ghPos: nil)
}

private func stack(_ layers: [Layer]) -> ReviewStack {
    ReviewStack(id: "s1", title: "S", repo: "o/r", repoRoot: "/r", trunk: "main", mergeMethod: "merge", methods: ["merge"], source: "tree", ghStack: nil, origin: nil, link: nil, planPath: nil, state: "open", syncedAt: 0, syncError: nil, syncing: false, owner: nil, layers: layers, next: layers.first?.pr, decisions: [])
}

@Test func noChecksReportedIsNeverReadAsPassed() {
    let none = LayerConfidence(layer: layer(1, checks: Checks(pass: 0, fail: 0, pending: 0, failing: [])))
    #expect(none.checks == .none)
    #expect(none.checksText == "No checks reported")
    #expect(LayerConfidence(layer: layer(1)).checksText == "Checks passed")
    let failing = LayerConfidence(layer: layer(1, checks: Checks(pass: 1, fail: 1, pending: 0, failing: ["lint"])))
    #expect(failing.checksText == "Failing: lint")
    #expect(failing.missing.contains("Passing checks"))
}

@Test func reviewStateFollowsTheExactRevision() {
    #expect(LayerConfidence(layer: layer(1, approved: false)).review == .notReviewed)
    #expect(LayerConfidence(layer: layer(1)).review == .current)
    #expect(LayerConfidence(layer: layer(1, rebased: true)).review == .rebasedSamePatch)
    let changed = LayerConfidence(layer: layer(1, samePatch: false))
    #expect(changed.review == .changedSinceReview)
    #expect(!changed.readyToMerge)
    #expect(changed.missing.first == "A re-review of what changed")
    #expect(LayerConfidence(layer: layer(1)).readyToMerge)
    #expect(!LayerConfidence(layer: layer(1, blocking: 2, open: 3)).readyToMerge)
}

@Test func aStackMergeStopsAtTheFirstLayerYouHaventReviewed() {
    let plan = StackMergePlan(stack: stack([layer(1), layer(2, approved: false), layer(3)]), method: "merge")
    #expect(plan.rows.map(\.state) == [.ready, .review, .waits])
    #expect(plan.lands.map(\.pr) == [1], "never marks a layer reviewed for you")
    #expect(plan.upTo?.pr == 1)
    #expect(plan.stop?.why == "Review #2 first")
}

@Test func aStackMergeHoldsOnFailingGatesAndRestacksSquashedChains() {
    let held = StackMergePlan(stack: stack([layer(1), layer(2, checks: Checks(pass: 0, fail: 1, pending: 0, failing: ["ci"]))]), method: "merge")
    #expect(held.rows.map(\.state) == [.ready, .held])
    // A layer targeting the one below lands once that one does (base gate waived for its head).
    let chain = StackMergePlan(stack: stack([layer(1, headRef: "one"), layer(2, gates: [MergeGate(key: "base", ok: false, label: "Targets main", detail: "Targets one")], baseRef: "one")]), method: "merge")
    #expect(chain.rows.map(\.state) == [.ready, .ready])
    let squash = StackMergePlan(stack: stack([layer(1, headRef: "one"), layer(2, gates: [], baseRef: "one")]), method: "squash")
    #expect(squash.rows.map(\.state) == [.ready, .restack])
}

@Test func diffCommentsReadAsTheWebSendsThem() {
    #expect(DiffModel.comment(file: "src/a.ts", line: DiffLine(kind: .add, text: "  let x = 1", number: 12), text: " why? ") == "Comment on src/a.ts:12:\n> let x = 1\n\nwhy?")
    #expect(DiffModel.comment(file: "b.py", line: DiffLine(kind: .del, text: "old()", number: nil), text: "keep this") == "Comment on b.py (removed line):\n> old()\n\nkeep this")
}

@Test func previewsStayOnTheirOwnOrigin() {
    let origin = URL(string: "https://box.tail.ts.net")!
    let preview = PreviewModel.url(origin: origin, port: 47600)!
    #expect(preview.absoluteString == "https://box.tail.ts.net:47600/")
    #expect(PreviewModel.allows(URL(string: "https://box.tail.ts.net:47600/assets/app.js")!, preview: preview))
    #expect(!PreviewModel.allows(URL(string: "https://box.tail.ts.net/api/state")!, preview: preview), "never the hub itself")
    #expect(!PreviewModel.allows(URL(string: "https://evil.example:47600/")!, preview: preview))
}

@Test func historyFiltersAndFileMentions() {
    let row = HistoryRow(host: "box", isLocal: true, dto: HistoryItemDTO(ref: "r", kind: .ended, harness: "codex", harnessId: nil, title: "Fix login flash", cwd: "/code/web", project: "web", model: "gpt-6", at: 0, pinned: false, worktree: nil, fork: nil))
    #expect(HistoryFilter.matches(row, "login"))
    #expect(HistoryFilter.matches(row, "CODEX"))
    #expect(!HistoryFilter.matches(row, "billing"))
    #expect(FilesModel.mention("/code/web/a b.ts", shell: true) == "'/code/web/a b.ts' ")
    #expect(FilesModel.mention("/code/web/a.ts", shell: false) == "@/code/web/a.ts ")
}

@Test func filePathsGoInRelativeToTheSessionAndDrawByKind() {
    #expect(FilesModel.mention("/code/web/src/a.ts", shell: false, cwd: "/code/web") == "@src/a.ts ")
    #expect(FilesModel.mention("/code/web/a b.ts", shell: true, cwd: "/code/web/") == "'a b.ts' ")
    #expect(FilesModel.mention("/code/api/x.ts", shell: false, cwd: "/code/web") == "@/code/api/x.ts ")
    #expect(FilesModel.relative("/code/web", to: "/code/web") == ".")
    #expect(FilesModel.relative("/code/webby/a", to: "/code/web") == "/code/webby/a")
    #expect(FilesModel.crumbs("/code/web").map(\.path) == ["/", "/code", "/code/web"])
    #expect(FilesModel.crumbs("/").map(\.name) == ["/"])
    let entry = { (name: String) in FsEntry(name: name, type: .file, size: 1, mtime: 0) }
    #expect(FilesModel.Kind(entry("router.ts")) == .code)
    #expect(FilesModel.Kind(entry("README.md")) == .text)
    #expect(FilesModel.Kind(entry("Makefile")) == .text)
    #expect(FilesModel.Kind(entry("shot.PNG")) == .image)
    #expect(FilesModel.Kind(entry("build.tar.gz")) == .archive)
    #expect(FilesModel.Kind(FsEntry(name: "src", type: .dir, size: 0, mtime: 0)) == .folder)
    #expect(FilesModel.Kind(entry("router.ts")).readsAsText)
    #expect(FilesModel.text(Data("hi\n".utf8)) == "hi\n")
    #expect(FilesModel.text(Data([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])) == nil)
}

@Test func theDiffCursorWalksCommentableLinesAcrossFiles() {
    let a = [DiffLine(kind: .file, text: "a.swift", number: nil), DiffLine(kind: .hunk, text: "@@", number: nil), DiffLine(kind: .ctx, text: "x", number: 1), DiffLine(kind: .add, text: "y", number: 2)]
    let b = [DiffLine(kind: .hunk, text: "@@", number: nil), DiffLine(kind: .del, text: "z", number: 7)]
    var cursor = DiffCursor(files: [a, b])
    #expect(cursor.current == nil, "nothing until the first move")
    cursor.move(1)
    #expect(cursor.current == .init(file: 0, line: 2), "hunks and file headers are skipped")
    cursor.move(1)
    cursor.move(1)
    #expect(cursor.current == .init(file: 1, line: 1), "on into the next file")
    cursor.move(1)
    #expect(cursor.current == .init(file: 1, line: 1), "stops at the end")
    cursor.home()
    #expect(cursor.current == .init(file: 0, line: 2))
    var fresh = DiffCursor(files: [a, b])
    fresh.move(-1)
    #expect(fresh.current == .init(file: 1, line: 1), "↑ first goes to the last line")
    // A poll that changes the diff keeps the cursor where it was when it can.
    cursor.end()
    cursor.update(files: [a + [DiffLine(kind: .add, text: "new", number: 3)], b])
    #expect(cursor.current == .init(file: 1, line: 1))
    #expect(DiffCursor(files: [a], maxLines: 3).positions == [.init(file: 0, line: 2)], "only lines on screen")
}
