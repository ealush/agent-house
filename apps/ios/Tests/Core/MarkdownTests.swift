import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func blocksOfAnAgentReply() {
    let source = """
    ## Plan

    Echoed **hello** and `ls -la`.

    - [x] read the code
    - [ ] write the fix
      with a second line
    1. first
    2. second

    > quoted *thought*

    ```swift
    let x = 1
      indented
    ```

    | key | value |
    |:---|---:|
    | a | 1 |
    | b \\| c | `x|y` |

    ---
    <details>raw</details>
    """
    let blocks = Markdown.parse(source)
    #expect(blocks.count == 9)
    #expect(blocks[0] == .heading(level: 2, [.text("Plan")]))
    #expect(blocks[1] == .paragraph([.text("Echoed "), .strong([.text("hello")]), .text(" and "), .code("ls -la"), .text(".")]))
    guard case .list(false, _, let tasks) = blocks[2] else { Issue.record("task list"); return }
    #expect(tasks.map(\.task) == [true, false])
    #expect(tasks[1].blocks == [.paragraph([.text("write the fix\nwith a second line")])])
    guard case .list(true, 1, let numbered) = blocks[3] else { Issue.record("ordered list"); return }
    #expect(numbered.count == 2)
    #expect(blocks[4] == .quote([.paragraph([.text("quoted "), .emphasis([.text("thought")])])]))
    #expect(blocks[5] == .code(language: "swift", text: "let x = 1\n  indented"))
    guard case .table(let header, let aligns, let rows) = blocks[6] else { Issue.record("table"); return }
    #expect(header == [[.text("key")], [.text("value")]])
    #expect(aligns == [.leading, .trailing])
    #expect(rows[1][0] == [.text("b | c")])
    #expect(rows[1][1] == [.code("x|y")], "a pipe inside code stays in its cell")
    #expect(blocks[7] == .rule)
    #expect(blocks[8] == .html("<details>raw</details>"), "HTML is shown as text, never rendered")
}

@Test func inlineRunsLinksAndImages() {
    #expect(Markdown.inline("see [docs](https://example.com/a_(b)) and <https://x.dev>") == [
        .text("see "), .link(text: [.text("docs")], url: "https://example.com/a_(b)"), .text(" and "), .link(text: [.text("https://x.dev")], url: "https://x.dev"),
    ])
    #expect(Markdown.inline("bare https://github.com/o/r/pull/12.") == [.text("bare "), .link(text: [.text("https://github.com/o/r/pull/12")], url: "https://github.com/o/r/pull/12"), .text(".")])
    #expect(Markdown.inline("![a shot](/tmp/x.png)") == [.image(alt: "a shot", src: "/tmp/x.png")])
    #expect(Markdown.inline("snake_case_name stays") == [.text("snake_case_name stays")])
    #expect(Markdown.inline("~~gone~~ ***both***") == [.strike([.text("gone")]), .text(" "), .strong([.emphasis([.text("both")])])])
    #expect(Markdown.inline("a * b * c") == [.text("a * b * c")], "spaced asterisks are not emphasis")
    #expect(Markdown.inline("``code with ` tick``") == [.code("code with ` tick")])
    #expect(Markdown.inline("escaped \\*not\\*") == [.text("escaped *not*")])
    #expect(Markdown.inline("line  \nbreak") == [.text("line"), .lineBreak, .text("break")])
}

@Test func linksAreVettedBeforeOpening() {
    #expect(LinkPolicy.classify("https://github.com") == .external(URL(string: "https://github.com")!))
    #expect(LinkPolicy.classify("~/code/plan.md") == .hostFile("~/code/plan.md"))
    #expect(LinkPolicy.classify("javascript:alert(1)") == .refused("javascript:alert(1)"))
    // A file:// URL is a file on the host (agents link their files so), which the host confines to
    // the folders it serves; never this device's, nor another machine's.
    #expect(LinkPolicy.classify("file:///home/u/Videos/agent house.mp4") == .hostFile("/home/u/Videos/agent house.mp4"))
    #expect(LinkPolicy.classify("file://localhost/tmp/a.png?x=1#top") == .hostFile("/tmp/a.png"))
    #expect(LinkPolicy.classify("FILE:///etc/passwd") == .hostFile("/etc/passwd"))
    #expect(LinkPolicy.classify("file://server/share/a.mp4") == .refused("file://server/share/a.mp4"))
    #expect(LinkPolicy.classify("file:///") == .refused("file:///"))
    #expect(Markdown.plain(Markdown.parse("# T\n\nsome **bold**")) == "T\n\nsome bold")
}

@Test func yourOwnLineBreaksStayAsWritten() {
    let source = "First line\nSecond **bold\nstill bold**\n\n- one\n  two\n\n```\na\nb\n```"
    // As Markdown has it, a single new line is a space…
    #expect(Markdown.parse(source)[0] == .paragraph([.text("First line\nSecond "), .strong([.text("bold\nstill bold")])]))
    // …but in words you typed, each one is a new line, code untouched.
    let kept = Markdown.parse(source, keepingLineBreaks: true)
    #expect(kept[0] == .paragraph([.text("First line"), .lineBreak, .text("Second "), .strong([.text("bold"), .lineBreak, .text("still bold")])]))
    #expect(kept[1] == .list(ordered: false, start: 1, items: [.init(task: nil, blocks: [.paragraph([.text("one"), .lineBreak, .text("two")])])]))
    #expect(kept[2] == .code(language: nil, text: "a\nb"))
    #expect(Markdown.plain(kept) == "First line\nSecond bold\nstill bold\n\none\ntwo\n\na\nb")
}

@Test func proseRunsHoldWhatOneSelectionCanCross() {
    let blocks = Markdown.parse("""
    # Plan

    First **step**.

    - one
    - two
      1. nested

    ```sh
    ls
    ```

    After the code.

    > quoted

    ![shot](/tmp/x.png)

    - item with code:

      ```
      x
      ```
    """)
    let runs = Markdown.runs(blocks)
    #expect(runs.count == 6)
    guard case .prose(let first) = runs[0] else { Issue.record("heading, paragraph and list make one run"); return }
    #expect(first.count == 3)
    #expect(runs[1] == .block(.code(language: "sh", text: "ls")))
    #expect(runs[2] == .prose([.paragraph([.text("After the code.")])]), "code ends a run; the prose after it starts another")
    #expect(runs[3] == .block(.quote([.paragraph([.text("quoted")])])))
    #expect(runs[4] == .block(.paragraph([.image(alt: "shot", src: "/tmp/x.png")])), "a paragraph with an image stands alone")
    guard case .block(.list) = runs[5] else { Issue.record("a list holding code stands alone"); return }
}

@Test func quotingForAReply() {
    #expect(Markdown.quote("one\n\ntwo") == "> one\n> \n> two\n\n")
    #expect(Markdown.quote("a\nb\nc", limit: 2) == "> a\n> b\n\n")
}

@Test func selectedProseQuotesAsMarkdown() {
    let drawn = "Shipped it.\n•\t`a.ts`: the flow\n12.\tstep\u{2028}more\n\u{FFFC}\ttask\nkept\ttab"
    #expect(Markdown.source(ofSelected: drawn) == "Shipped it.\n- `a.ts`: the flow\n12. step\nmore\n- task\nkept\ttab")
}

@MainActor
@Test func rememberedParsesReadTheSameAsAFreshParse() {
    let reply = "# Done\n\nFixed **two** things:\n- one\n- two\n\n```swift\nlet a = 1\n```"
    #expect(Markdown.remembered(reply, keepingLineBreaks: false) == Markdown.parse(reply, keepingLineBreaks: false))
    #expect(Markdown.remembered(reply, keepingLineBreaks: false) == Markdown.parse(reply, keepingLineBreaks: false), "a second read comes back the same")
    #expect(Markdown.remembered("a\nb", keepingLineBreaks: true) == Markdown.parse("a\nb", keepingLineBreaks: true))
    #expect(Markdown.remembered("a\nb", keepingLineBreaks: true) != Markdown.remembered("a\nb", keepingLineBreaks: false), "the line-break rule is part of what's remembered")
}

@Test func aLongLineOfStrayMarkersReadsQuickly() {
    // A pasted log: thousands of stars, underscores and angle brackets that close nothing.
    let log = String(repeating: "x * y < z _ w ", count: 3000)
    let took = ContinuousClock().measure { _ = Markdown.parse(log) }
    #expect(took < .seconds(1), "took \(took)")
    #expect(Markdown.parse("a *b* and <https://x.dev> and *c")[0] == .paragraph([.text("a "), .emphasis([.text("b")]), .text(" and "), .link(text: [.text("https://x.dev")], url: "https://x.dev"), .text(" and *c")]))
}

/// An `<img>` is read as the picture it names (as agents write a table of screenshots); every
/// other tag stays text, and of an `<img>` only its src and alt are read.
@Test func anImgTagIsAPicture() {
    let table = Markdown.parse("""
    | Before | After |
    |---|---|
    | <img src="https://example.com/a.png" width="300"> | <img src='/tmp/b.png' alt="After &amp; all"/> |
    """)
    guard case .table(_, _, let rows) = table.first else { Issue.record("a table"); return }
    #expect(rows[0][0] == [.image(alt: "", src: "https://example.com/a.png")])
    #expect(rows[0][1] == [.image(alt: "After & all", src: "/tmp/b.png")])

    // Pictures alone on their lines: a paragraph of them, not markup shown as text.
    #expect(Markdown.parse("<img src=\"a.png\">\n<IMG SRC=b.png>") == [.paragraph([.image(alt: "", src: "a.png"), .image(alt: "", src: "b.png")])])
    // In a sentence, where it stands.
    #expect(Markdown.inline("see <img src=\"x.png\" alt=\"X\"> here") == [.text("see "), .image(alt: "X", src: "x.png"), .text(" here")])
    // No src, another tag, or markup around it: text, as before.
    #expect(Markdown.inline("<img alt=\"none\">") == [.text("<img alt=\"none\">")])
    #expect(Markdown.inline("<imgx src=\"x.png\">") == [.text("<imgx src=\"x.png\">")])
    #expect(Markdown.parse("<p><img src=\"a.png\"></p>") == [.html("<p><img src=\"a.png\"></p>")])
    #expect(Markdown.parse("<details>raw</details>") == [.html("<details>raw</details>")])
}

@Test func codeThatIsAPicturesPathIsThatPicture() {
    // As Claude Code names a screenshot it took: the path in code.
    let shot = "/tmp/claude-1000/-home-me-code/dae747f1/scratchpad/11143FC8-77C9.png"
    #expect(Markdown.codedPicture(shot) == shot)
    #expect(Markdown.codedPicture(" ~/Pictures/Before After.JPG ") == "~/Pictures/Before After.JPG", "spaces are its name")
    #expect(Markdown.codedPicture("/tmp/100%25.png") == "/tmp/100%25.png", "code is read as written")
    #expect(Markdown.codedPicture("file:///tmp/a%20b.webp") == "/tmp/a b.webp", "a file:// URL is a link: unescaped")
    for code in ["/tmp/clip.mp4", "/tmp/a.svg", "shot.png", "./shot.png", "//cdn.example.com/a.png", "https://example.com/a.png", "open /tmp/a.png", "/tmp/a.png\n/tmp/b.png", "file://server/a.png", ""] {
        #expect(Markdown.codedPicture(code) == nil, "\(code)")
    }

    // Its words stay as written; the picture is drawn after them, so it's no run of prose.
    let blocks = Markdown.parse("Screenshots: `\(shot)` and `/tmp/run.log`.")
    guard case .paragraph(let inlines) = blocks.first else { Issue.record("a paragraph"); return }
    #expect(inlines == [.text("Screenshots: "), .code(shot), .text(" and "), .code("/tmp/run.log"), .text(".")])
    #expect(inlines.compactMap(\.picture).map(\.src) == [shot])
    #expect(inlines.compactMap(\.picture).map(\.alt) == ["11143FC8-77C9.png"])
    #expect(!blocks[0].isProse)
    #expect(Markdown.parse("The log: `/tmp/run.log`.")[0].isProse, "code that isn't a picture is prose")
    #expect(MarkdownInline.link(text: [.code(shot)], url: "https://x.test").picture == nil, "a link's code is its link")
}
