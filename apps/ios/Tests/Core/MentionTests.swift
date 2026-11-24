import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func mentionsAreEachAtPathNotTheSentenceAroundIt() {
    let text = "@rust.md first, then @apps/server/http.ts, (see @docs/a.md) and mail me@example.com or `@code`"
    let ns = text as NSString
    #expect(Mentions.find(text).map { [$0.path, ns.substring(with: $0.range)] } == [
        ["rust.md", "@rust.md"],
        ["apps/server/http.ts", "@apps/server/http.ts"],
        ["docs/a.md", "@docs/a.md"],
    ])
    // UTF-16, as a text view counts: an emoji before it is two.
    #expect(Mentions.find("😀 @a.md.\n@b.ts") == [
        Mention(range: NSRange(location: 3, length: 5), path: "a.md"),
        Mention(range: NSRange(location: 10, length: 5), path: "b.ts"),
    ])
}

@Test func aMentionResolvesInTheSessionFolderUnlessAbsoluteOrHome() {
    #expect(Mentions.resolve("src/a.ts", in: "/work/my repo/") == "/work/my repo/src/a.ts")
    #expect(Mentions.resolve("./a.ts", in: "/work") == "/work/a.ts")
    #expect(Mentions.resolve("/etc/hosts", in: "/work") == "/etc/hosts")
    #expect(Mentions.resolve("~/notes.md", in: "/work") == "~/notes.md")
    #expect(Mentions.resolve("a.ts", in: "/") == "/a.ts")
}

@Test func removingAMentionTakesOneSpaceWithIt() {
    func removing(_ text: String, _ path: String) -> (String, Int) {
        let r = Mentions.removing(Mentions.find(text).first { $0.path == path }!, from: text)
        return (r.text, r.caret)
    }
    #expect(removing("read @a.md and go", "a.md") == ("read and go", 5))
    #expect(removing("read @a.md, then", "a.md") == ("read, then", 4))
    #expect(removing("read @a.md", "a.md") == ("read", 4))
    #expect(removing("@a.md", "a.md") == ("", 0))
}

@Test func aMentionsLinkRoundTripsItsPath() {
    let link = Mentions.link("my docs/a b.md")
    #expect(link.hasPrefix(Mentions.scheme))
    #expect(Mentions.path(fromLink: link) == "my docs/a b.md")
    #expect(Mentions.path(fromLink: "https://x.test") == nil)
}

@Test func mentionsLinkInProseNeverInCodeOrInsideALink() {
    let blocks = Markdown.parse("Read @a.md and @gone.md, **@a.md** again, `@a.md` in code, [see @a.md](https://x.test)\n\n```\n@a.md\n```")
    #expect(Markdown.mentionPaths(blocks) == ["a.md", "gone.md"])
    let linked = Markdown.linkingMentions(blocks, files: ["a.md": "/w/a.md"])
    guard case .paragraph(let inlines) = linked.first else { Issue.record("a paragraph first"); return }
    var links: [[String]] = []
    func collect(_ list: [MarkdownInline]) {
        for inline in list {
            switch inline {
            case .link(let text, let url): links.append([text.map(\.plain).joined(), url])
            case .strong(let c), .emphasis(let c), .strike(let c): collect(c)
            default: break
            }
        }
    }
    collect(inlines)
    #expect(links == [["@a.md", Mentions.link("/w/a.md")], ["@a.md", Mentions.link("/w/a.md")], ["see @a.md", "https://x.test"]])
    #expect(inlines.contains(.code("@a.md")))
    #expect(linked.last == .code(language: nil, text: "@a.md"))
}

@MainActor
@Test func mentionFilesListsEachFolderOnceAndOnlyFilesCount() async throws {
    let asked = Asked()
    let files = MentionFiles { dir in
        await asked.add(dir)
        if dir == "/gone" { throw URLError(.fileDoesNotExist) }
        return [FsEntry(name: "a.md", type: .file, size: 1, mtime: 0), FsEntry(name: "src", type: .dir, size: 0, mtime: 0)]
    }
    #expect(files.exists("/w/a.md") == nil, "not known before its folder is listed")
    #expect(files.exists("/w/b.md") == nil)
    #expect(files.exists("/gone/a.md") == nil)
    for _ in 0..<50 where files.exists("/w/a.md") == nil || files.exists("/gone/a.md") == nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(files.exists("/w/a.md") == true)
    #expect(files.exists("/w/b.md") == false)
    #expect(files.exists("/w/src") == false, "a folder isn't a file to open")
    #expect(files.exists("/gone/a.md") == false)
    // Each once; the two lists run side by side, so in either order.
    #expect(await asked.dirs.sorted() == ["/gone", "/w"])
    #expect(files.found(in: "see @a.md and @b.md", cwd: "/w").map(\.path) == ["a.md"])
    #expect(files.found(in: "see @a.md", cwd: "/w", skipping: 4).isEmpty, "the one still being typed")
}

private actor Asked {
    var dirs: [String] = []
    func add(_ dir: String) { dirs.append(dir) }
}

@Test func movingAChipTakesItOutWithASpaceAndPutsItInWithOneEachSide() {
    let text = "read @a.md then fix it"
    let a = Mentions.find(text)[0]
    #expect(Mentions.moving(a, in: text, to: (text as NSString).length) == ("read then fix it @a.md ", 23))
    #expect(Mentions.moving(a, in: text, to: 0) == ("@a.md read then fix it", 6))
    #expect(Mentions.moving(a, in: text, to: (text as NSString).range(of: "fix").location + 1).text == "read then f @a.md ix it")
    #expect(Mentions.moving(a, in: text, to: a.range.location + 2).text == text, "on itself, nothing moves")
    let two = "see @a.md and @bb/long.md"
    let m = Mentions.find(two)
    #expect(Mentions.moving(m[0], in: two, to: m[1].range.location + 2, others: [m[1]]).text == "see and @a.md @bb/long.md")
    #expect(Mentions.moving(m[0], in: two, to: NSMaxRange(m[1].range) - 1, others: [m[1]]).text == "see and @bb/long.md @a.md ")
}

@Test func sessionMentionsResolveHashBareUidAndFullUrlIntoChips() {
    let uid1 = "u1234567890"
    let uid2 = "a1b2c3d4"
    let sessions = [uid1: "Launch Chief", uid2: "API Worker"]

    let text = "Check #\(uid1), ask \(uid2), and see https://hub.tail.ts.net/#\(uid1) or `#\(uid1)`"
    let blocks = Markdown.parse(text)
    let linked = Markdown.linkingSessions(blocks, sessions: sessions)
    guard case .paragraph(let inlines) = linked.first else {
        Issue.record("expected paragraph")
        return
    }
    var found: [[String]] = []
    for inline in inlines {
        if case .link(let label, let url) = inline {
            found.append([label.map(\.plain).joined(), url])
        }
    }
    #expect(found == [
        ["Launch Chief", SessionMentions.link(uid1)],
        ["API Worker", SessionMentions.link(uid2)],
        ["Launch Chief", SessionMentions.link(uid1)],
    ])
    #expect(inlines.contains(.code("#\(uid1)")))
    #expect(SessionMentions.uid(fromLink: SessionMentions.link(uid1)) == uid1)
    #expect(SessionMentions.uid(fromWebURL: "https://hub.tail.ts.net/#\(uid2)") == uid2)
}
