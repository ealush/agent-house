import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func aPullRequestIsReadFromAnyPageOfItOnGitHubAndNothingElse() {
    #expect(PullLinks.pull(of: "https://github.com/ealush/agent-house/pull/223") == PullRef(repo: "ealush/agent-house", number: 223))
    #expect(PullLinks.pull(of: "https://github.com/ealush/agent-house/pull/223/files#diff-1") == PullRef(repo: "ealush/agent-house", number: 223))
    #expect(PullLinks.pull(of: "https://www.github.com/a/b.c/pull/7?w=1") == PullRef(repo: "a/b.c", number: 7))
    #expect(PullLinks.pull(of: "https://github.com/ealush/agent-house/issues/223") == nil)
    #expect(PullLinks.pull(of: "https://github.com/ealush/agent-house/pull/223x") == nil)
    #expect(PullLinks.pull(of: "https://gitlab.com/ealush/agent-house/pull/223") == nil)
    #expect(PullRef(repo: "ealush/agent-house", number: 223).label == "agent-house#223")
}

@Test func pullRequestLinksInProseLeaveOutTheBracketsAndStopRoundThem() {
    let text = "The confirmation fix is up as PR #223 (https://github.com/ealush/agent-house/pull/223). Also https://github.com/o/r/pull/9/files, and #12."
    let ns = text as NSString
    #expect(PullLinks.find(text).map { [$0.pull.repo, "\($0.pull.number)", ns.substring(with: $0.range), $0.url] } == [
        ["ealush/agent-house", "223", "https://github.com/ealush/agent-house/pull/223", "https://github.com/ealush/agent-house/pull/223"],
        ["o/r", "9", "https://github.com/o/r/pull/9/files", "https://github.com/o/r/pull/9/files"],
    ])
}

@Test func onlyARepositoryTheHostReviewsMakesAChipThatKeepsItsAddress() throws {
    let text = "Up as PR #223 (https://github.com/ealush/agent-house/pull/223), on [the fix](https://github.com/Ealush/Agent-House/pull/224/files), upstream https://github.com/other/repo/pull/5."
    let linked = Markdown.linkingPulls(Markdown.parse(text), repos: ["ealush/agent-house"])
    guard case .paragraph(let inlines) = linked.first else { Issue.record("not a paragraph"); return }
    let links = inlines.compactMap { inline -> [String]? in
        guard case .link(let label, let url) = inline else { return nil }
        return [label.map(\.plain).joined(), url]
    }
    #expect(links == [
        ["agent\u{2011}house#223", "ah-pull:https://github.com/ealush/agent-house/pull/223"],
        ["the fix", "ah-pull:https://github.com/Ealush/Agent-House/pull/224/files"],
        ["https://github.com/other/repo/pull/5", "https://github.com/other/repo/pull/5"],
    ])
    let target = try #require(PullLinks.target(fromLink: links[1][1]))
    #expect(target.pull == PullRef(repo: "Ealush/Agent-House", number: 224))
    #expect(target.url.absoluteString == "https://github.com/Ealush/Agent-House/pull/224/files")
    #expect(Markdown.linkingPulls(Markdown.parse(text), repos: []) == Markdown.parse(text))
}
