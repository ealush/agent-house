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

// The Commits chip's list (`GET /api/review/sessions/:uid/commits`): what a session committed,
// each under its branch, and where picking one goes.

/// ah's answer for a session building base ← feat ← docs, with one more branch of its own.
private func payload(review: String? = nil, layers: Bool = false, start: String = #"{"prs":[1,2]}"#, featState: String = "OPEN") -> String {
    let layer = layers ? #"{"status":"unreviewed","role":"layer"}"# : "null"
    let checks = #"{"pass":2,"fail":0,"pending":0,"failing":[]}"#
    return """
    {"since":1763700000,
     "stack":{"repo":"me/proj","root":"/src/proj","trunk":"main","source":"gh-stack","branch":"docs","ghStack":null,
      "branches":[
       {"branch":"base","current":false,"pr":{"number":1,"title":"Base","url":"https://github.com/me/proj/pull/1","state":"OPEN","draft":false,"checks":\(checks),"additions":3,"deletions":0},"layer":\(layer)},
       {"branch":"feat","current":false,"pr":{"number":2,"title":"Feat","url":"https://github.com/me/proj/pull/2","state":"\(featState)","draft":false,"checks":\(checks),"additions":9,"deletions":1},"layer":\(layer)},
       {"branch":"docs","current":true,"pr":null,"layer":null}],
      "review":\(review.map { #"{"id":"\#($0)","title":"Proj"}"# } ?? "null"),
      "start":\(review == nil ? start : "null")},
     "commits":[
      {"sha":"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0","short":"d0d0d0d","subject":"Docs for feat","at":1763700900,"files":1,"additions":4,"deletions":0,"branch":"docs"},
      {"sha":"f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2","short":"f2f2f2f","subject":"Feat, tested","at":1763700600,"files":2,"additions":6,"deletions":1,"branch":"feat"},
      {"sha":"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1","short":"f1f1f1f","subject":"Feat","at":1763700400,"files":1,"additions":3,"deletions":0,"branch":"feat"},
      {"sha":"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1","short":"b1b1b1b","subject":"Base","at":1763700200,"files":1,"additions":3,"deletions":0,"branch":"base"}]}
    """
}

private func decode(_ json: String) throws -> SessionCommits {
    try JSONDecoder().decode(SessionCommits.self, from: Data(json.utf8))
}

@Test func sessionCommitsReadAsTheHostSendsThemGroupedByBranchTopFirst() throws {
    let value = try decode(payload())
    #expect(value.commits.map(\.short) == ["d0d0d0d", "f2f2f2f", "f1f1f1f", "b1b1b1b"])
    #expect(value.byBranch.map(\.branch) == ["docs", "feat", "base"])
    #expect(value.byBranch[1].commits.map(\.subject) == ["Feat, tested", "Feat"])
    #expect(value.branch(of: value.commits[1])?.pr?.number == 2)
    #expect(value.commits[1].additions == 6 && value.commits[1].files == 2)
}

@Test func aCommitOpensItsLayerInTheReviewItsPRIsIn() throws {
    let value = try decode(payload(review: "abcd1234", layers: true))
    #expect(value.target(of: value.commits[1]) == .review(ReviewRoute(stack: "abcd1234", pr: 2)))
    #expect(value.target(of: value.commits[3]) == .review(ReviewRoute(stack: "abcd1234", pr: 1)))
    #expect(value.target(of: value.commits[0]) == .nowhere, "a branch with no PR has nothing to review")
}

@Test func withNoReviewYetACommitStartsTheSessionsReviewAtItsPR() throws {
    let value = try decode(payload())
    #expect(value.target(of: value.commits[2]) == .start(.manual([1, 2]), pr: 2))
    let single = try decode(payload(start: #"{"pr":1}"#))
    #expect(single.target(of: single.commits[3]) == .start(.chain(1), pr: 1))
}

@Test func aMergedPRInNoReviewOpensThePRItself() throws {
    let value = try decode(payload(start: #"{"pr":1}"#, featState: "MERGED"))
    #expect(value.target(of: value.commits[1]) == .pullRequest(2, URL(string: "https://github.com/me/proj/pull/2")!))
    // A PR that's in the stack but not (yet) a layer of its review: the PR, not a missing layer.
    let partly = try decode(payload(review: "abcd1234", layers: false))
    #expect(partly.target(of: partly.commits[3]) == .pullRequest(1, URL(string: "https://github.com/me/proj/pull/1")!))
}

private actor Asks {
    var count = 0
    func ask() -> Int { count += 1; return count }
}

@MainActor
@Test func commitsAreAskedForAgainWhenATurnEndsAndNotWhileItRuns() async throws {
    let asks = Asks()
    let value = try decode(payload())
    let model = SessionCommitsModel(ref: "u1") { _ in
        _ = await asks.ask()
        return value
    }
    // Nobody asked yet: a turn ending asks for nothing.
    model.rowChanged(working: true)
    model.rowChanged(working: false)
    try await Task.sleep(for: .milliseconds(50))
    #expect(await asks.count == 0)
    await model.load()
    #expect(model.phase == .loaded)
    #expect(model.commits.count == 4)
    // Working, still working: nothing. The turn ends: once.
    model.rowChanged(working: true)
    model.rowChanged(working: true)
    try await Task.sleep(for: .milliseconds(50))
    #expect(await asks.count == 1)
    model.rowChanged(working: false)
    model.rowChanged(working: false)
    // However long the runner takes to get to it: once it's in, nothing more follows.
    for _ in 0..<150 { if await asks.count == 2 { break }; try await Task.sleep(for: .milliseconds(20)) }
    try await Task.sleep(for: .milliseconds(50))
    #expect(await asks.count == 2)
}

@MainActor
@Test func anOlderHostHasNoCommitsAndAFailureKeepsWhatWasShown() async throws {
    let missing = SessionCommitsModel(ref: "u1") { _ in throw APIError.notFound("Not found") }
    await missing.load()
    #expect(missing.phase == .unsupported)
    #expect(missing.commits.isEmpty, "no chip")

    let state = Asks()
    let value = try decode(payload())
    let flaky = SessionCommitsModel(ref: "u1") { _ in
        if await state.ask() > 1 { throw APIError.transport("offline") }
        return value
    }
    await flaky.load()
    await flaky.load()
    #expect(flaky.phase == .failed("Can’t reach your host. offline"))
    #expect(flaky.commits.count == 4)
}
