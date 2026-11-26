import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func aMermaidFenceIsADiagram() {
    #expect(Diagram.isMermaid("mermaid"))
    #expect(Diagram.isMermaid(" Mermaid "))
    #expect(!Diagram.isMermaid("mmd"))
    #expect(!Diagram.isMermaid(nil))
    let blocks = Markdown.parse("```mermaid\nflowchart LR\n  A --> B\n```")
    guard case .code(let language, let text) = blocks.first else { Issue.record("a fence"); return }
    #expect(Diagram.isMermaid(language))
    #expect(text == "flowchart LR\n  A --> B")
}

@Test func aDiagramIsNamedByItsKind() {
    #expect(Diagram.kind("flowchart LR\n  A --> B") == "Flowchart")
    #expect(Diagram.kind("%% a comment\n\nsequenceDiagram\n  A->>B: hi") == "Sequence diagram")
    #expect(Diagram.kind("pie title Pets") == "Pie chart")
    #expect(Diagram.kind("") == "Diagram")
}

@Test func whyADiagramWasntDrawnIsMermaidsOwnWords() {
    #expect(Diagram.reason("UnknownDiagramError: No diagram type detected matching given configuration for text: x") == "No diagram type detected matching given configuration for text: x")
    #expect(Diagram.reason("Error: Parse error on line 2:") == "Parse error on line 2:")
    #expect(Diagram.reason("Parse error on line 2: expecting 'NODE_ID'") == "Parse error on line 2: expecting 'NODE_ID'")
    #expect(Diagram.reason("Error: ") == "Error:")
}

@Test func theDiagramsPageLoadsNothingButItsOwnScript() {
    let page = Diagram.page(script: "window.mermaid = {}; const s = '</script><script>alert(1)</script>';")
    #expect(page.contains("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"))
    #expect(page.contains("securityLevel: 'strict'"))
    #expect(!page.contains("'</script><script>alert(1)"), "a closing tag in the script can't end it")
    #expect(page.contains("<\\/script><script>alert(1)<\\/script>"))
    #expect(!page.contains("://"), "nothing on the page names the network")
}
