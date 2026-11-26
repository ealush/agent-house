import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func aMarkdownFileIsKnownByItsExtension() {
    #expect(Markdown.isDocument("/home/me/brain/review.md"))
    #expect(Markdown.isDocument("~/notes/PLAN.Markdown"))
    #expect(!Markdown.isDocument("/home/me/review.md.txt"))
    #expect(!Markdown.isDocument("/home/me/README"))
}

@Test func aRelativeTargetIsTheFileBesideTheDocument() {
    let folder = "/home/me/brain/c0ffee"
    #expect(Markdown.hostPath("evidence/shot.png", in: folder) == "/home/me/brain/c0ffee/evidence/shot.png")
    #expect(Markdown.hostPath("./evidence/clip%20one.mp4", in: folder) == "/home/me/brain/c0ffee/evidence/clip one.mp4")
    #expect(Markdown.hostPath("../other/notes.md#top", in: folder) == "/home/me/brain/other/notes.md")
    #expect(Markdown.hostPath("plan.md?raw=1", in: folder + "/") == "/home/me/brain/c0ffee/plan.md")
    #expect(Markdown.hostPath("../../../../../x.md", in: folder) == "/x.md", "never above the root")
    #expect(Markdown.hostPath("../../x.md", in: "~/code") == "~/x.md", "nor above home")
    #expect(Markdown.hostPath("shot.png", in: "~") == "~/shot.png")
    for absolute in ["/etc/hosts", "~/a.md", "#section", "https://example.com/a.png", "mailto:me@example.com", "data:image/png;base64,AA==", "file:///tmp/a.png", "javascript:alert(1)", ""] {
        #expect(Markdown.hostPath(absolute, in: folder) == nil, "\(absolute)")
    }
    #expect(Markdown.hostPath("a.md", in: "relative/folder") == nil)
}

@Test func aDocumentsLinksAndPicturesAreResolvedWhereverTheyAre() {
    let source = """
    # Review ![logo](logo.png)

    See [the plan](plan.md) and [the web](https://example.com), ![shot](evidence/a.png).

    > a [quoted](../q.md) link

    - an item with **[bold](b.md)**

    | Shot |
    |---|
    | <img src="evidence/b.png" alt="b"> |

    ![absolute](file:///tmp/c%20d.png) ![remote](https://example.com/e.png)

    ```
    [not a link](code.md)
    ```
    """
    let blocks = Markdown.resolving(Markdown.parse(source), in: "/home/me/brain/x")
    #expect(blocks[0] == .heading(level: 1, [.text("Review "), .image(alt: "logo", src: "/home/me/brain/x/logo.png")]))
    #expect(blocks[1] == .paragraph([
        .text("See "), .link(text: [.text("the plan")], url: "/home/me/brain/x/plan.md"),
        .text(" and "), .link(text: [.text("the web")], url: "https://example.com"),
        .text(", "), .image(alt: "shot", src: "/home/me/brain/x/evidence/a.png"), .text("."),
    ]))
    #expect(blocks[2] == .quote([.paragraph([.text("a "), .link(text: [.text("quoted")], url: "/home/me/brain/q.md"), .text(" link")])]))
    guard case .list(_, _, let items) = blocks[3] else { Issue.record("list"); return }
    #expect(items[0].blocks == [.paragraph([.text("an item with "), .strong([.link(text: [.text("bold")], url: "/home/me/brain/x/b.md")])])])
    guard case .table(_, _, let rows) = blocks[4] else { Issue.record("table"); return }
    #expect(rows[0][0].contains(.image(alt: "b", src: "/home/me/brain/x/evidence/b.png")))
    #expect(blocks[5] == .paragraph([.image(alt: "absolute", src: "/tmp/c d.png"), .text(" "), .image(alt: "remote", src: "https://example.com/e.png")]))
    #expect(blocks[6] == .code(language: nil, text: "[not a link](code.md)"))
}
