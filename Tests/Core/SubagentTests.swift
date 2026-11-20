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

// Subagents as sessions (ah's docs/spec/16-subagents.md): a child's key, what the host's tree
// and counts decode to, the browser's rows, the chip's words, the way up, and how the tree is
// asked for again only when the host says it changed.

private let rootRef = "claude:421cdc16-e954-4057-b7ac-96c5335f2256"
private func ref(_ agent: String) -> String { "\(rootRef):\(agent)" }

private func node(_ id: String, parent: String? = nil, _ state: SubagentNodeDTO.State = .running, started: Double = 0, call: String? = nil) -> SubagentNodeDTO {
    SubagentNodeDTO(ref: ref(id), parentRef: parent.map(ref) ?? rootRef, rootRef: rootRef, name: id, state: state, startedAt: started, toolCallId: call)
}

// MARK: Keys

@Test func aSubagentKeyIsNeverAHostSessionKey() throws {
    let local = try #require(SubagentKey("sub:\(ref("a5e458ae8133f318e"))"))
    #expect(local.host == nil)
    #expect(local.ref == ref("a5e458ae8133f318e"))
    #expect(local.description == "sub:\(ref("a5e458ae8133f318e"))")
    let peer = try #require(SubagentKey("sub:mac-b/codex:01a1f5ec-555a-7a62-8c26-698965b5924d"))
    #expect(peer.host == "mac-b")
    #expect(peer.ref == "codex:01a1f5ec-555a-7a62-8c26-698965b5924d")
    #expect(SubagentKey(host: "mac-b", ref: peer.ref).description == "sub:mac-b/codex:01a1f5ec-555a-7a62-8c26-698965b5924d")
    // Nothing else is one, and none is ever a host session or a note.
    for raw in ["sub:", "sub:abc", "sub:claude:a/b/c", "sub:bad host/claude:x", "claude:x:y", "note:\(NoteKey.newID())", "mac/abc123"] {
        #expect(!SubagentKey.isSubagent(raw), "\(raw)")
    }
    #expect(SessionKey(local.description) == nil)
    #expect(SessionKey(peer.description) == nil)
    #expect(!NoteKey.isNote(local.description))
}

// MARK: Wire

@Test func aRowCarriesItsSubagentCountsAndAnOlderHostNone() throws {
    let with = #"{"id":"@1","uid":"u1","name":"claude","statusSource":"hook","project":"ah","projectPath":"/ah","status":"busy","agent":"claude","subagents":{"total":3,"active":2,"completed":1,"failed":0,"rev":"9ho7zp"}}"#
    let dto = try JSONDecoder().decode(SessionDTO.self, from: Data(with.utf8))
    #expect(dto.subagents == SubagentSummaryDTO(total: 3, active: 2, completed: 1, failed: 0, rev: "9ho7zp"))
    let without = #"{"id":"@1","uid":"u1","name":"zsh","statusSource":"screen","project":"ah","projectPath":"/ah","status":"idle"}"#
    #expect(try JSONDecoder().decode(SessionDTO.self, from: Data(without.utf8)).subagents == nil)
    // A summary this build can't read is left out, never the row.
    let odd = #"{"id":"@1","uid":"u1","name":"claude","statusSource":"hook","project":"ah","projectPath":"/ah","status":"idle","subagents":{"total":"many"}}"#
    #expect(try JSONDecoder().decode(SessionDTO.self, from: Data(odd.utf8)).subagents == nil)
}

@Test func theTreeDecodesLenientlyAndAnUnknownStateIsNeverRunning() throws {
    let json = """
    {"root":{"ref":"\(rootRef)","uid":"u1","title":"Refactor","live":true},"self":null,"nodes":[
      {"ref":"\(ref("a1"))","harness":"claude","agentId":"a1","parentRef":"\(rootRef)","rootRef":"\(rootRef)","depth":1,"name":"Domain model audit","role":"Explore","prompt":"Audit","state":"completed","background":false,"startedAt":10,"updatedAt":20,"endedAt":20,"activity":"Read: src/users.ts","toolCallId":"toolu_1","capabilities":{"transcript":true,"live":false,"send":false,"cancel":false,"continue":false}},
      {"ref":"\(ref("a2"))","parentRef":"\(rootRef)","name":"From a newer host","state":"paused","capabilities":{"send":true}},
      {"ref":"../../etc/passwd","parentRef":"\(rootRef)","name":"Not a ref","state":"running"},
      {"name":"No ref at all"}
    ]}
    """
    let tree = try JSONDecoder().decode(SubagentTreeDTO.self, from: Data(json.utf8))
    #expect(tree.root == SubagentTreeDTO.Root(ref: rootRef, uid: "u1", title: "Refactor", live: true))
    #expect(tree.nodes.map(\.name) == ["Domain model audit", "From a newer host"], "the unreadable ones are left out, not the tree")
    #expect(tree.nodes[0].toolCallId == "toolu_1")
    #expect(tree.nodes[1].state == .unknown)
    #expect(!tree.nodes[1].state.isActive)
    #expect(tree.nodes[1].capabilities.send, "what the host says it can do is kept")
    #expect(!tree.nodes[1].capabilities.continue, "and what it doesn't say is no")
}

// MARK: The browser

@Test func rowsNestUnderTheirParentsAndFoldWithThem() {
    let nodes = [node("a"), node("a1", parent: "a"), node("a1x", parent: "a1"), node("b", .completed), node("c", .waiting)]
    let rows = SubagentTree.rows(nodes)
    #expect(rows.map { "\($0.level):\($0.node.name)" } == ["0:a", "1:a1", "2:a1x", "0:b", "0:c"])
    #expect(rows[0].children == 1)
    #expect(rows[0].activeBelow == 2)
    let folded = SubagentTree.rows(nodes, collapsed: [ref("a")])
    #expect(folded.map(\.node.name) == ["a", "b", "c"])
    #expect(!folded[0].expanded)
    // A child's own browser starts below it.
    #expect(SubagentTree.rows(nodes, under: ref("a")).map(\.node.name) == ["a1", "a1x"])
    // An orphan (its parent never sent) still shows, at the top.
    #expect(SubagentTree.rows([node("x", parent: "gone")]).map(\.node.name) == ["x"])
}

@Test func aLargeTreeStaysCheapToLayOut() {
    // 2 000 subagents, eight levels deep in places.
    var nodes: [SubagentNodeDTO] = []
    for i in 0..<2000 { nodes.append(node("n\(i)", parent: i == 0 ? nil : "n\(i < 8 ? i - 1 : i % 8)", i % 3 == 0 ? .running : .completed)) }
    let clock = ContinuousClock()
    let took = clock.measure { _ = SubagentTree.rows(nodes) }
    #expect(SubagentTree.rows(nodes).count == 2000)
    #expect(took < .milliseconds(500))
    #expect(SubagentTree.summary(of: nil, in: nodes).total == 2000)
}

@Test func theChipSaysWhatsWorkingThenWhatsDone() {
    func label(_ total: Int, _ active: Int, _ completed: Int, _ failed: Int) -> SubagentChip.Label {
        SubagentChip.label(SubagentSummaryDTO(total: total, active: active, completed: completed, failed: failed, rev: "r"))
    }
    #expect(label(0, 0, 0, 0).value == nil)
    #expect(label(0, 0, 0, 0).tone == .none)
    #expect(label(5, 3, 2, 0).value == "3 active")
    #expect(label(5, 3, 2, 0).tone == .active)
    #expect(label(5, 3, 2, 0).accessibility == "Subagents, 3 active of 5")
    #expect(label(4, 0, 4, 0).value == "4 done")
    #expect(label(3, 0, 2, 1).value == "2 done · 1 failed")
    #expect(label(3, 0, 2, 1).tone == .failed)
    // Neither done nor running as far as the host can tell: not called done.
    #expect(label(3, 0, 1, 0).value == "1 done · 2 stopped")
    #expect(label(2, 0, 0, 0).value == "2")
}

@Test func aChildsDurationRunsWhileItWorksAndStopsWhenItEnds() {
    let start = 1_000_000.0
    let running = SubagentNodeDTO(ref: ref("a"), parentRef: rootRef, rootRef: rootRef, name: "a", state: .running, startedAt: start)
    #expect(SubagentChip.duration(running, now: Date(timeIntervalSince1970: start + 42)) == "42s")
    let done = SubagentNodeDTO(ref: ref("a"), parentRef: rootRef, rootRef: rootRef, name: "a", state: .completed, startedAt: start, endedAt: start + 3900)
    #expect(SubagentChip.duration(done, now: Date(timeIntervalSince1970: start + 99_999)) == "1h 5m")
}

// MARK: The way up

@Test func aChildsParentIsAnotherChildOrTheRootByItsWindowOrItsRef() {
    let live = SubagentTreeDTO.Root(ref: rootRef, uid: "u1", title: "Refactor", live: true)
    let ended = SubagentTreeDTO.Root(ref: rootRef, uid: nil, title: "Refactor", live: false)
    #expect(SubagentTree.parentKey(of: node("a"), root: live, host: nil) == "u1")
    #expect(SubagentTree.parentKey(of: node("a"), root: live, host: "mac-b") == "mac-b/u1")
    #expect(SubagentTree.parentKey(of: node("a"), root: ended, host: nil) == rootRef)
    #expect(SubagentTree.parentKey(of: node("a1", parent: "a"), root: live, host: "mac-b") == "sub:mac-b/\(ref("a"))")
    let nodes = [node("a"), node("a1", parent: "a"), node("a1x", parent: "a1")]
    #expect(SubagentTree.ancestors(of: ref("a1x"), in: nodes).map(\.name) == ["a", "a1"])
    #expect(SubagentTree.ancestors(of: ref("a"), in: nodes).isEmpty)
}

// MARK: Asking the host

private actor Asks {
    var count = 0
    func ask() -> Int { count += 1; return count }
}

@MainActor
@Test func theTreeIsAskedForAgainOnlyWhenTheRowSaysItChanged() async throws {
    let asks = Asks()
    let model = SubagentsModel(ref: "u1", host: nil, coalesce: .milliseconds(30)) { _ in
        let n = await asks.ask()
        return SubagentTreeDTO(root: .init(ref: rootRef, uid: "u1", title: "Refactor", live: true), selfRef: nil, nodes: (0..<n).map { node("n\($0)") })
    }
    // Nobody looked yet: a changing row asks for nothing.
    model.rowChanged(rev: "r1")
    try await Task.sleep(for: .milliseconds(80))
    #expect(await asks.count == 0)
    #expect(model.phase == .idle)
    await model.load()
    #expect(model.phase == .loaded)
    #expect(model.tree?.nodes.count == 1)
    // The same rev again is nothing new; a burst of changes is one ask.
    model.rowChanged(rev: "r1")
    model.rowChanged(rev: "r2")
    model.rowChanged(rev: "r3")
    model.rowChanged(rev: "r4")
    try await Task.sleep(for: .milliseconds(150))
    #expect(await asks.count == 2)
    #expect(model.tree?.nodes.count == 2)
    #expect(model.summary.total == 2)
}

@MainActor
@Test func aHostWithoutSubagentsSaysSoAndAFailureKeepsWhatWasShown() async {
    let missing = SubagentsModel(ref: "u1", host: nil) { _ in throw APIError.notFound("this session's agent has no subagents ah can read") }
    await missing.load()
    #expect(missing.phase == .unsupported)

    let state = Asks()
    let flaky = SubagentsModel(ref: "u1", host: nil) { _ in
        if await state.ask() > 1 { throw APIError.transport("offline") }
        return SubagentTreeDTO(root: .init(ref: rootRef, uid: "u1", title: "Refactor", live: true), selfRef: nil, nodes: [node("a")])
    }
    await flaky.load()
    await flaky.load()
    #expect(flaky.phase == .failed("Can’t reach your host. offline"))
    #expect(flaky.tree?.nodes.count == 1, "what it showed stays, marked as not updated")
}

@MainActor
@Test func aChildsTreeIsItsWholeTreeAndItsCountsAreItsOwn() async {
    let model = SubagentsModel(ref: ref("a"), host: nil) { _ in
        SubagentTreeDTO(root: .init(ref: rootRef, uid: "u1", title: "Refactor", live: true), selfRef: ref("a"), nodes: [node("a"), node("a1", parent: "a", .completed), node("b")])
    }
    await model.load()
    #expect(model.selfNode?.name == "a")
    #expect(model.summary.total == 1, "only what's below it")
    #expect(model.rows.map(\.node.name) == ["a1"])
}

@Test func anActivityLineReadsAsWordsNotMarkdown() {
    #expect(SubagentChip.plain("## Report: Claude Code hooks **Sources read:** `https://x`") == "Report: Claude Code hooks Sources read: https://x")
    #expect(SubagentChip.plain("Read: src/#1 notes.md") == "Read: src/#1 notes.md", "a # inside a word stays")
}
