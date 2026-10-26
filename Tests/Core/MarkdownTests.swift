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
    #expect(LinkPolicy.classify("file:///etc/passwd") == .refused("file:///etc/passwd"))
    #expect(Markdown.plain(Markdown.parse("# T\n\nsome **bold**")) == "T\n\nsome bold")
}
