import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// A session's source control at a glance (ah's docs/spec/02-sessions.md SES-24): windows' `scm`,
// and the glyph rows, the Commits chip and its list draw from it.

private func session(_ scm: String?) throws -> SessionDTO {
    let json = #"{"id":"@1","uid":"u1","name":"claude","statusSource":"hook","project":"ah","projectPath":"/ah","status":"idle""# + (scm.map { #","scm":\#($0)"# } ?? "") + "}"
    return try JSONDecoder().decode(SessionDTO.self, from: Data(json.utf8))
}

@Test func aSessionsSourceControlReadsAsTheHostSendsIt() throws {
    let dto = try session(#"{"dirty":3,"pull":{"number":12,"url":"https://github.com/o/r/pull/12","state":"draft","checks":"fail"}}"#)
    #expect(dto.scm == ScmDTO(dirty: 3, pull: .init(number: 12, url: "https://github.com/o/r/pull/12", state: .draft, checks: .fail)))
    #expect(try session(#"{"dirty":0,"pull":null}"#).scm == ScmDTO(dirty: 0, pull: nil))
    #expect(try session(nil).scm == nil, "an older host sends none")
    #expect(try session("null").scm == nil, "outside a repository, or switched off")
    let unknown = try session(#"{"dirty":1,"pull":{"number":1,"url":"","state":"queued","checks":null}}"#)
    #expect(unknown.scm == nil, "a state this build doesn't know drops the glyph, not the session")
    #expect(unknown.uid == "u1")
}

@Test func theGlyphSaysOneThingAboutThePullRequest() throws {
    func mark(_ state: ScmDTO.Pull.State, _ checks: ScmDTO.Pull.Checks?, dirty: Int = 0) -> SourceControlMark? {
        SourceControlMark(ScmDTO(dirty: dirty, pull: .init(number: 7, url: "", state: state, checks: checks)))
    }
    #expect(mark(.open, .pass)?.pull == .open)
    #expect(mark(.open, .pending)?.pull == .open)
    #expect(mark(.draft, nil)?.pull == .draft)
    #expect(mark(.open, .fail)?.pull == .failing)
    #expect(mark(.draft, .fail)?.pull == .failing, "failing checks matter more than a draft")
    #expect(mark(.merged, .fail)?.pull == .merged, "merged is merged, whatever its checks said")
    #expect(mark(.closed, .pass) == nil, "a closed one says nothing")
    #expect(mark(.closed, nil, dirty: 2)?.pull == nil)
    #expect(mark(.closed, nil, dirty: 2)?.dirty == 2)
    #expect(SourceControlMark(ScmDTO(dirty: 0, pull: nil)) == nil, "a clean checkout with no pull request says nothing")
    #expect(SourceControlMark(nil as ScmDTO?) == nil)
    #expect(SourceControlMark.Pull.merged.symbol == "arrow.triangle.merge")
    #expect(SourceControlMark.Pull.draft.symbol == "arrow.triangle.pull")
}

@Test func theGlyphIsSpokenInWords() {
    #expect(SourceControlMark(ScmDTO(dirty: 3, pull: .init(number: 12, url: "", state: .open, checks: .fail)))?.spoken == "3 uncommitted files, pull request 12 failing checks")
    #expect(SourceControlMark(ScmDTO(dirty: 1, pull: nil))?.spoken == "1 uncommitted file")
    #expect(SourceControlMark(ScmDTO(dirty: 0, pull: .init(number: 4, url: "", state: .draft, checks: nil)))?.spoken == "draft pull request 4")
    #expect(SourceControlMark(ScmDTO(dirty: 0, pull: .init(number: 9, url: "", state: .merged, checks: nil)))?.spoken == "pull request 9 merged")
}

@Test func aBranchInTheCommitsListReadsItsPullRequestTheSameWay() throws {
    func pr(_ state: String, draft: Bool = false, fail: Int = 0) throws -> SessionStack.PR {
        let json = #"{"number":5,"title":"T","url":"u","state":"\#(state)","draft":\#(draft),"checks":{"pass":1,"fail":\#(fail),"pending":0,"failing":[]},"additions":1,"deletions":0}"#
        return try JSONDecoder().decode(SessionStack.PR.self, from: Data(json.utf8))
    }
    #expect(SourceControlMark(try pr("OPEN"))?.pull == .open)
    #expect(SourceControlMark(try pr("OPEN", draft: true))?.pull == .draft)
    #expect(SourceControlMark(try pr("OPEN", fail: 1))?.pull == .failing)
    #expect(SourceControlMark(try pr("MERGED", fail: 1))?.pull == .merged)
    #expect(SourceControlMark(try pr("CLOSED")) == nil)
    #expect(SourceControlMark(nil as SessionStack.PR?) == nil)
    #expect(SourceControlMark(nil as SessionStack.PR?, dirty: 2)?.dirty == 2)
}
