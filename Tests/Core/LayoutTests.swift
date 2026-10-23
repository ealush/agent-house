import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Ports of ../ah/test/layout.test.ts and workspaces.test.ts.

private func leaf(_ key: String) -> LayoutNode { .session(key) }
private func row(_ a: LayoutNode, _ b: LayoutNode, _ ratio: Double = 0.5) -> LayoutNode { .split(direction: .horizontal, ratio: ratio, first: a, second: b) }
private func col(_ a: LayoutNode, _ b: LayoutNode, _ ratio: Double = 0.5) -> LayoutNode { .split(direction: .vertical, ratio: ratio, first: a, second: b) }

@Test func splitsReplaceAndCloseCollapse() {
    var l = leaf("a").splitting(.key("a"), direction: .horizontal, next: "b")
    #expect(l.keys == ["a", "b"])
    l = l.splitting(.key("b"), direction: .vertical, next: "c")
    #expect(l.keys == ["a", "b", "c"])
    let pair = leaf("a").splitting(.key("a"), direction: .horizontal, next: "b").replacing(.key("b"), with: "c")
    #expect(pair.keys == ["a", "c"])
    #expect(pair.closing(.key("a")) == leaf("c"))
    #expect(leaf("a").closing(.key("a")) == nil)
    #expect(pair.closing(.key("zzz")) == pair)
    #expect(LayoutNode.normalized(pair) == pair)
    #expect(LayoutNode.normalized(pair.closing(.key("c"))) == nil)
}

@Test func panePathsDistinguishDuplicateViewers() {
    let l = leaf("a").splitting(.path([]), direction: .horizontal, next: "a")
    #expect(l.leaves() == [.init(sessionKey: "a", path: [.first]), .init(sessionKey: "a", path: [.second])])
    #expect(l.closing(.path([.first])) == leaf("a"))
    #expect(l.replacing(.path([.second]), with: "b").keys == ["a", "b"])
    let split = l.splitting(.path([.second]), direction: .vertical, next: "b")
    #expect(split.keys == ["a", "a", "b"])
    #expect(split.node(at: [.second, .second]) == leaf("b"))
    #expect(l.node(at: [.first, .second]) == nil)
    #expect(l.closing(.path([.first, .second])) == l, "a stale path leaves the layout alone")
}

@Test func ratiosAreClampedAndTargeted() {
    var l = row(leaf("a"), leaf("b"))
    l = l.settingRatio(at: [], 0.99)
    if case .split(_, let ratio, _, _) = l { #expect(ratio == 0.85) }
    l = l.settingRatio(at: [], 0.01)
    if case .split(_, let ratio, _, _) = l { #expect(ratio == 0.15) }
}

@Test func neighborsFollowTheSharedEdge() {
    let stack = row(leaf("a"), col(leaf("b"), leaf("c")))
    #expect(stack.neighbor(of: [.first], .right) == [.second, .first])
    #expect(stack.neighbor(of: [.first], .down) == nil)
    #expect(stack.neighbor(of: [.second, .first], .left) == [.first])
    #expect(stack.neighbor(of: [.second, .first], .down) == [.second, .second])
    #expect(stack.neighbor(of: [.second, .second], .up) == [.second, .first])
    let grid = col(row(leaf("tl"), leaf("tr")), row(leaf("bl"), leaf("br")))
    #expect(grid.neighbor(of: [.first, .first], .right) == [.first, .second])
    #expect(grid.neighbor(of: [.first, .first], .down) == [.second, .first])
    #expect(grid.neighbor(of: [.first, .first], .left) == nil)
    let uneven = row(col(leaf("a"), leaf("b"), 0.7), col(leaf("c"), leaf("d"), 0.4), 0.3)
    #expect(uneven.neighbor(of: [.first, .second], .right) == [.second, .second])
    #expect(uneven.neighbor(of: [.first, .first], .right) == [.second, .first])
    #expect(row(leaf("a"), row(leaf("b"), leaf("c")), 1.0 / 3).neighbor(of: [.first], .right) == [.second, .first])
    #expect(leaf("a").neighbor(of: [], .right) == nil)
}

@Test func storedLayoutsAreParsedWithoutTrust() throws {
    func parse(_ json: String) -> LayoutNode? { LayoutNode.parse(try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))) }
    #expect(parse("null") == nil)
    #expect(parse(#"{"type":"nope"}"#) == nil)
    #expect(parse(#"{"type":"session","sessionKey":"a"}"#) == leaf("a"))
    #expect(parse(#"{"type":"split","direction":"sideways","ratio":9,"first":{"type":"session","sessionKey":"a"},"second":{"type":"session","sessionKey":"b"}}"#) == nil)
    #expect(parse(#"{"type":"split","direction":"horizontal","ratio":9,"first":{"type":"session","sessionKey":"a"},"second":{"type":"session","sessionKey":"b"}}"#) == row(leaf("a"), leaf("b"), 0.85))
    #expect(parse(#"{"type":"split","direction":"horizontal","first":{"type":"session","sessionKey":"a"},"second":null}"#) == leaf("a"))
    // The web's JSON shape round-trips.
    let tree = row(leaf("a"), col(leaf("b"), leaf("c"), 0.3), 0.6)
    #expect(try JSONDecoder().decode(LayoutNode.self, from: JSONEncoder().encode(tree)) == tree)
}

@Test func movingPanes() {
    let stack = row(leaf("a"), col(leaf("b"), leaf("c")))
    let down = stack.moving([.second, .second], .down)
    #expect(down.layout == col(row(leaf("a"), leaf("b")), leaf("c")))
    #expect(down.path == [.second])
    let sized = col(row(leaf("a"), leaf("b")), leaf("c"), 0.7)
    #expect(sized.moving([.second], .down).layout == sized)
    let pair = row(leaf("a"), leaf("b"), 0.7)
    let swapped = pair.moving([.first], .right)
    #expect(swapped.layout == row(leaf("b"), leaf("a"), 0.7))
    #expect(swapped.path == [.second])
    #expect(col(row(leaf("a"), leaf("b")), leaf("c")).moving([.second], .up).layout == col(leaf("c"), row(leaf("a"), leaf("b"))))
    let left = stack.moving([.second, .second], .left)
    #expect(left.layout == row(row(leaf("c"), leaf("a")), leaf("b")))
    #expect(left.path == [.first, .first])
    #expect(pair.flipping([.second]) == col(leaf("a"), leaf("b"), 0.7))
    #expect(leaf("a").flipping([]) == leaf("a"))
}

@Test func dockingAndDropping() {
    let stack = row(leaf("a"), col(leaf("b"), leaf("c"), 0.4), 0.3)
    let docked = stack.docking([.second, .second], .down)
    #expect(docked.layout == col(row(leaf("a"), leaf("b"), 0.3), leaf("c")))
    #expect(docked.path == [.second])
    #expect(docked.layout.docking([.second], .down).layout == docked.layout)
    let even = row(leaf("a"), col(leaf("b"), leaf("c")))
    let dropped = even.movingLeaf(from: [.second, .second], to: [.first], where: .bottom)
    #expect(dropped.layout == row(col(leaf("a"), leaf("c")), leaf("b")))
    #expect(dropped.path == [.first, .second])
    let center = even.movingLeaf(from: [.second, .second], to: [.first], where: .center)
    #expect(center.layout == row(leaf("c"), col(leaf("b"), leaf("a"))))
    #expect(center.path == [.first])
    #expect(even.movingLeaf(from: [.first], to: [.first], where: .left).layout == even)
}

@Test func keyboardResizeMovesTheNearestDividerOfTheArrowsKind() {
    let tree = row(leaf("A"), col(leaf("B"), leaf("C")))
    if case .split(_, let ratio, _, _) = tree.nudgingDivider(from: [.second, .first], .right) { #expect(abs(ratio - 0.55) < 1e-9) }
    if case .split(_, _, _, .split(_, let ratio, _, _)) = tree.nudgingDivider(from: [.second, .first], .down) { #expect(abs(ratio - 0.55) < 1e-9) }
    #expect(tree.nudgingDivider(from: [.first], .up) == tree)
    var far = tree
    for _ in 0..<20 { far = far.nudgingDivider(from: [.first], .left) }
    if case .split(_, let ratio, _, _) = far { #expect(ratio == 0.15) }
    #expect(LayoutNode.isPick(LayoutNode.pickKey()))
    #expect(LayoutNode.pickPrevious(LayoutNode.pickKey()) == nil)
    #expect(LayoutNode.pickPrevious(LayoutNode.pickKey(previous: "u4")) == "u4")
}

@Test func tileBoxesAreFractionsOfTheWorkspace() {
    let l = row(leaf("a"), col(leaf("b"), leaf("c")), 0.25)
    let (tiles, seams) = l.tiles()
    #expect(tiles == [
        .init(sessionKey: "a", path: [.first], box: .init(x: 0, y: 0, w: 0.25, h: 1)),
        .init(sessionKey: "b", path: [.second, .first], box: .init(x: 0.25, y: 0, w: 0.75, h: 0.5)),
        .init(sessionKey: "c", path: [.second, .second], box: .init(x: 0.25, y: 0.5, w: 0.75, h: 0.5)),
    ])
    #expect(seams == [
        .init(path: [], row: true, ratio: 0.25, box: .init(x: 0, y: 0, w: 1, h: 1)),
        .init(path: [.second], row: false, ratio: 0.5, box: .init(x: 0.25, y: 0, w: 0.75, h: 1)),
    ])
}

@Test func workspacesKeepWhatYouLeaveAndSendTilesAcross() {
    var spaces = Workspaces()
    let one = Workspaces.Slot(layout: nil, selected: "u1")
    let (afterSwitch, shown) = spaces.switching(to: 2, keeping: one)
    #expect(shown == .empty)
    spaces = afterSwitch
    let (back, restored) = spaces.switching(to: 1, keeping: Workspaces.Slot(layout: row(leaf("u2"), leaf("u3")), selected: nil))
    #expect(restored == one)
    #expect(back.slots[2]?.isOccupied == true)

    let start = Workspaces(current: 1, slots: [2: Workspaces.Slot(layout: nil, selected: "u9")])
    let (sent, left) = start.sending("u3", to: 2, keeping: Workspaces.Slot(layout: row(leaf("u2"), leaf("u3")), selected: nil), path: [.second])
    #expect(left == Workspaces.Slot(layout: nil, selected: "u2"), "one pane left: that session alone")
    #expect(sent.slots[2]?.layout?.keys == ["u9", "u3"])
    let (alone, emptied) = start.sending("u1", to: 3, keeping: Workspaces.Slot(layout: nil, selected: "u1"), path: nil)
    #expect(emptied == .empty)
    #expect(alone.slots[3] == Workspaces.Slot(layout: nil, selected: "u1"))
}
