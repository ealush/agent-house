import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Ports of apps/server/test/layout.test.ts and workspaces.test.ts.

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

// A folded iPhone Duo: the fold is the divider when a split can take it.

@Test func aBooksFoldIsTheDividerOfPanesSideBySide() {
    let fold = LayoutNode.Fold(vertical: true, start: 0.49, end: 0.51)
    let (tiles, seams) = row(leaf("a"), leaf("b"), 0.3).tiles(fold: fold)
    #expect(tiles == [
        .init(sessionKey: "a", path: [.first], box: .init(x: 0, y: 0, w: 0.49, h: 1)),
        .init(sessionKey: "b", path: [.second], box: .init(x: 0.51, y: 0, w: 0.49, h: 1)),
    ])
    #expect(seams == [.init(path: [], row: true, ratio: 0.5, box: .init(x: 0, y: 0, w: 1, h: 1), onFold: true)])
    // Only what's drawn: the layout keeps its own ratio for when the device lies flat.
    #expect(row(leaf("a"), leaf("b"), 0.3).tiles().tiles[0].box.w == 0.3)
}

@Test func aFoldAcrossTakesStackedPanesNotSideBySideOnes() {
    let across = LayoutNode.Fold(vertical: false, start: 0.5, end: 0.5)
    #expect(row(leaf("a"), leaf("b")).tiles(fold: across) == row(leaf("a"), leaf("b")).tiles())
    let (tiles, seams) = col(leaf("a"), leaf("b"), 0.7).tiles(fold: across)
    #expect(tiles.map(\.box) == [.init(x: 0, y: 0, w: 1, h: 0.5), .init(x: 0, y: 0.5, w: 1, h: 0.5)])
    #expect(seams.map(\.onFold) == [true])
}

@Test func theFoldGoesToTheNearestDividerThatHasRoomForIt() {
    let fold = LayoutNode.Fold(vertical: true, start: 0.5, end: 0.5)
    // Three columns: the inner divider (at 0.6) is nearer than the outer one (at 0.2).
    let three = row(leaf("a"), row(leaf("b"), leaf("c")), 0.2)
    let (tiles, seams) = three.tiles(fold: fold)
    #expect(seams.map(\.onFold) == [false, true])
    #expect(tiles.map(\.box.x) == [0, 0.2, 0.5])
    #expect(tiles.map(\.box.w) == [0.2, 0.3, 0.5])
    // The nearer one can't leave the minimum on both sides of it: the next one takes the fold.
    let narrow = LayoutNode.Box(x: 0, y: 0, w: 0.35, h: 0.2)
    let next = three.tiles(fold: fold, minimum: narrow)
    #expect(next.seams.map(\.onFold) == [true, false])
    #expect(next.tiles.map(\.box.x) == [0, 0.5, 0.75])
    // None can: every divider stays where it was.
    #expect(row(leaf("a"), leaf("b")).tiles(fold: LayoutNode.Fold(vertical: true, start: 0.2, end: 0.2), minimum: narrow) == row(leaf("a"), leaf("b")).tiles())
}

@Test func aSinglePaneSpansTheFold() {
    let fold = LayoutNode.Fold(vertical: true, start: 0.5, end: 0.5)
    #expect(leaf("a").tiles(fold: fold).tiles.map(\.box) == [.init(x: 0, y: 0, w: 1, h: 1)])
}
