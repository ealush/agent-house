import Foundation

/// Binary split layout (`../ah/web/layout.ts`). Each leaf is an independent viewer onto one
/// session, never tmux's own split. Ratios, not points, are stored, so a layout moves between
/// an iPad in Stage Manager and a full screen.
indirect enum LayoutNode: Hashable, Codable, Sendable {
    case session(String)
    case split(direction: Direction, ratio: Double, first: LayoutNode, second: LayoutNode)

    enum Direction: String, Codable, Sendable {
        /// Side by side.
        case horizontal
        /// Stacked.
        case vertical

        var flipped: Direction { self == .horizontal ? .vertical : .horizontal }
    }

    enum Side: String, Codable, Sendable { case first, second }
    typealias Path = [Side]

    // MARK: Codable in the web's JSON shape ({type, sessionKey} / {type, direction, ratio, first, second})

    private enum CodingKeys: String, CodingKey { case type, sessionKey, direction, ratio, first, second }

    init(from decoder: any Decoder) throws {
        guard let node = LayoutNode.parse(try JSONValue(from: decoder)) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a layout"))
        }
        self = node
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .session(let key):
            try c.encode("session", forKey: .type)
            try c.encode(key, forKey: .sessionKey)
        case .split(let direction, let ratio, let first, let second):
            try c.encode("split", forKey: .type)
            try c.encode(direction, forKey: .direction)
            try c.encode(ratio, forKey: .ratio)
            try c.encode(first, forKey: .first)
            try c.encode(second, forKey: .second)
        }
    }

    /// Parse a stored layout without trusting it: wrong shapes become nil (`parseLayout`).
    static func parse(_ value: JSONValue) -> LayoutNode? {
        switch value["type"]?.string {
        case "session":
            return value["sessionKey"]?.string.map { .session($0) }
        case "split":
            let first = value["first"].flatMap(parse)
            let second = value["second"].flatMap(parse)
            guard let first, let second else { return first ?? second }
            guard let direction = value["direction"]?.string.flatMap(Direction.init(rawValue:)) else { return nil }
            let raw = value["ratio"]?.number
            let ratio = raw.map { $0.isFinite ? min(0.85, max(0.15, $0)) : 0.5 } ?? 0.5
            return .split(direction: direction, ratio: ratio, first: first, second: second)
        default:
            return nil
        }
    }

    // MARK: Picking a pane's content

    /// A pane asking what goes in it: carries the session it replaced (restored on cancel).
    static let pickPrefix = "pick:"
    static func pickKey(previous: String = "") -> String { pickPrefix + previous }
    static func isPick(_ key: String) -> Bool { key.hasPrefix(pickPrefix) }
    static func pickPrevious(_ key: String) -> String? {
        guard isPick(key) else { return nil }
        let rest = String(key.dropFirst(pickPrefix.count))
        return rest.isEmpty ? nil : rest
    }

    // MARK: Reading

    struct Leaf: Hashable, Sendable {
        let sessionKey: String
        let path: Path
    }

    func leaves(_ path: Path = []) -> [Leaf] {
        switch self {
        case .session(let key): return [Leaf(sessionKey: key, path: path)]
        case .split(_, _, let first, let second): return first.leaves(path + [.first]) + second.leaves(path + [.second])
        }
    }

    var keys: [String] { leaves().map(\.sessionKey) }

    func node(at path: Path) -> LayoutNode? {
        var node = self
        for side in path {
            guard case .split(_, _, let first, let second) = node else { return nil }
            node = side == .first ? first : second
        }
        return node
    }

    /// A split needs two panes; one pane is just the session, so the layout goes away.
    static func normalized(_ node: LayoutNode?) -> LayoutNode? {
        guard let node, node.leaves().count >= 2 else { return nil }
        return node
    }

    // MARK: Editing

    enum Target: Equatable, Sendable {
        case key(String)
        case path(Path)
    }

    private func matches(_ path: Path, _ target: Target) -> Bool {
        guard case .session(let key) = self else { return false }
        switch target {
        case .key(let k): return key == k
        case .path(let p): return p == path
        }
    }

    /// Visit every node; nil removes it (its sibling takes the slot).
    private func map(_ path: Path = [], _ fn: (LayoutNode, Path) -> LayoutNode?) -> LayoutNode? {
        guard let next = fn(self, path) else { return nil }
        guard next == self, case .split(let direction, let ratio, let first, let second) = self else { return next }
        let a = first.map(path + [.first], fn)
        let b = second.map(path + [.second], fn)
        guard let a else { return b }
        guard let b else { return a }
        return .split(direction: direction, ratio: ratio, first: a, second: b)
    }

    /// Split the pane showing `target`: its half keeps it, the new half shows `next`.
    func splitting(_ target: Target, direction: Direction, next: String, before: Bool = false) -> LayoutNode {
        map { node, path in
            guard node.matches(path, target) else { return node }
            let added = LayoutNode.session(next)
            return before ? .split(direction: direction, ratio: 0.5, first: added, second: node) : .split(direction: direction, ratio: 0.5, first: node, second: added)
        } ?? self
    }

    func replacing(_ target: Target, with next: String) -> LayoutNode {
        map { node, path in node.matches(path, target) ? .session(next) : node } ?? self
    }

    /// Close a pane; its sibling takes the space. Nil when it was the only one.
    func closing(_ target: Target) -> LayoutNode? {
        map { node, path in node.matches(path, target) ? nil : node }
    }

    func settingRatio(at path: Path, _ ratio: Double) -> LayoutNode {
        let clamped = min(0.85, max(0.15, ratio))
        func at(_ node: LayoutNode, _ i: Int) -> LayoutNode {
            guard case .split(let direction, let r, let first, let second) = node else { return node }
            if i == path.count { return .split(direction: direction, ratio: clamped, first: first, second: second) }
            return path[i] == .first
                ? .split(direction: direction, ratio: r, first: at(first, i + 1), second: second)
                : .split(direction: direction, ratio: r, first: first, second: at(second, i + 1))
        }
        return at(self, 0)
    }

    enum Move: String, Sendable { case left, right, up, down }

    /// Keyboard resize: the nearest split of the arrow's kind above the pane moves its divider.
    func nudgingDivider(from path: Path, _ dir: Move, step: Double = 0.05) -> LayoutNode {
        let want: Direction = dir == .left || dir == .right ? .horizontal : .vertical
        let delta = dir == .right || dir == .down ? step : -step
        for depth in stride(from: path.count - 1, through: 0, by: -1) {
            let at = Array(path.prefix(depth))
            if case .split(let direction, let ratio, _, _)? = node(at: at), direction == want {
                return settingRatio(at: at, ratio + delta)
            }
        }
        return self
    }

    struct Box: Hashable, Sendable {
        var x: Double, y: Double, w: Double, h: Double
    }

    struct Tile: Hashable, Sendable { let sessionKey: String; let path: Path; let box: Box }
    struct Seam: Hashable, Sendable { let path: Path; let row: Bool; let ratio: Double; let box: Box }

    /// Every pane's box and every split's box as fractions of the workspace. Rendering panes
    /// flat from this keeps a session's view alive while the tree around it changes.
    func tiles() -> (tiles: [Tile], seams: [Seam]) {
        var tiles: [Tile] = []
        var seams: [Seam] = []
        func walk(_ node: LayoutNode, _ box: Box, _ path: Path) {
            switch node {
            case .session(let key):
                tiles.append(Tile(sessionKey: key, path: path, box: box))
            case .split(let direction, let ratio, let first, let second):
                let row = direction == .horizontal
                seams.append(Seam(path: path, row: row, ratio: ratio, box: box))
                let span = (row ? box.w : box.h) * ratio
                walk(first, row ? Box(x: box.x, y: box.y, w: span, h: box.h) : Box(x: box.x, y: box.y, w: box.w, h: span), path + [.first])
                walk(second, row ? Box(x: box.x + span, y: box.y, w: box.w - span, h: box.h) : Box(x: box.x, y: box.y + span, w: box.w, h: box.h - span), path + [.second])
            }
        }
        walk(self, Box(x: 0, y: 0, w: 1, h: 1), [])
        return (tiles, seams)
    }

    /// The pane in `dir`: it must share part of the edge you leave; the nearest edge wins,
    /// then the larger overlap, then the closer center (`neighborPane`).
    func neighbor(of from: Path, _ dir: Move) -> Path? {
        let panes = tiles().tiles
        guard let origin = panes.first(where: { $0.path == from })?.box else { return nil }
        let across = dir == .left || dir == .right
        let ranked = panes.compactMap { pane -> (Path, Double, Double, Double)? in
            guard pane.path != from else { return nil }
            let b = pane.box
            let gap: Double
            switch dir {
            case .right: gap = b.x - (origin.x + origin.w)
            case .left: gap = origin.x - (b.x + b.w)
            case .down: gap = b.y - (origin.y + origin.h)
            case .up: gap = origin.y - (b.y + b.h)
            }
            let overlap = across
                ? min(origin.y + origin.h, b.y + b.h) - max(origin.y, b.y)
                : min(origin.x + origin.w, b.x + b.w) - max(origin.x, b.x)
            guard gap >= -1e-6, overlap > 1e-6 else { return nil }
            let center = across ? abs(origin.y + origin.h / 2 - (b.y + b.h / 2)) : abs(origin.x + origin.w / 2 - (b.x + b.w / 2))
            return (pane.path, gap, overlap, center)
        }
        return ranked.sorted { a, b in
            if a.1 != b.1 { return a.1 < b.1 }
            if a.2 != b.2 { return a.2 > b.2 }
            return a.3 < b.3
        }.first?.0
    }

    private static func axisSide(_ dir: Move) -> (Direction, Side) {
        switch dir {
        case .left: return (.horizontal, .first)
        case .right: return (.horizontal, .second)
        case .up: return (.vertical, .first)
        case .down: return (.vertical, .second)
        }
    }

    private func setting(_ path: Path, to next: LayoutNode) -> LayoutNode {
        guard let side = path.first else { return next }
        guard case .split(let direction, let ratio, let first, let second) = self else { return self }
        let rest = Array(path.dropFirst())
        return side == .first
            ? .split(direction: direction, ratio: ratio, first: first.setting(rest, to: next), second: second)
            : .split(direction: direction, ratio: ratio, first: first, second: second.setting(rest, to: next))
    }

    private static func beside(_ node: LayoutNode, _ leaf: LayoutNode, _ side: Side, _ axis: Direction) -> LayoutNode {
        side == .first ? .split(direction: axis, ratio: 0.5, first: leaf, second: node) : .split(direction: axis, ratio: 0.5, first: node, second: leaf)
    }

    private func placeBeyond(_ slot: Path, _ leaf: LayoutNode, _ side: Side, _ axis: Direction) -> (LayoutNode, Path) {
        guard !slot.isEmpty else { return (LayoutNode.beside(self, leaf, side, axis), [side]) }
        let parentPath = Array(slot.dropLast())
        guard case .split(let direction, let ratio, let first, let second)? = node(at: parentPath) else { return (self, slot) }
        let slotSide = slot.last!
        if direction == axis && slotSide == side { return placeBeyond(parentPath, leaf, side, axis) }
        if direction == axis {
            let target = side == .first ? first : second
            let replaced = LayoutNode.beside(target, leaf, side, axis)
            let parent: LayoutNode = side == .first
                ? .split(direction: direction, ratio: ratio, first: replaced, second: second)
                : .split(direction: direction, ratio: ratio, first: first, second: replaced)
            return (setting(parentPath, to: parent), parentPath + [side, side])
        }
        let parent = LayoutNode.split(direction: direction, ratio: ratio, first: first, second: second)
        return (setting(parentPath, to: LayoutNode.beside(parent, leaf, side, axis)), parentPath + [side])
    }

    /// Move the pane one step: toward its sibling they trade places; at the edge it's pulled
    /// out and spans the parent beyond (`moveLeaf`).
    func moving(_ path: Path, _ dir: Move) -> (layout: LayoutNode, path: Path) {
        guard let leaf = node(at: path), case .session = leaf, !path.isEmpty else { return (self, path) }
        let (axis, side) = LayoutNode.axisSide(dir)
        let parentPath = Array(path.dropLast())
        guard case .split(let direction, let ratio, let first, let second)? = node(at: parentPath) else { return (self, path) }
        let at = path.last!
        if direction == axis && at != side {
            return (setting(parentPath, to: .split(direction: direction, ratio: ratio, first: second, second: first)), parentPath + [side])
        }
        if direction == axis && at == side && parentPath.isEmpty { return (self, path) }
        guard let removed = closing(.path(path)) else { return (self, path) }
        let placed = removed.placeBeyond(parentPath, leaf, side, axis)
        return placed.0 == self ? (self, path) : placed
    }

    /// Flip the split holding this pane between side by side and stacked.
    func flipping(_ path: Path) -> LayoutNode {
        let parentPath = Array(path.dropLast())
        guard case .split(let direction, let ratio, let first, let second)? = node(at: parentPath) else { return self }
        return setting(parentPath, to: .split(direction: direction.flipped, ratio: ratio, first: first, second: second))
    }

    /// Pull the pane out and dock it along an outer edge, spanning the workspace.
    func docking(_ path: Path, _ dir: Move) -> (layout: LayoutNode, path: Path) {
        guard let leaf = node(at: path), case .session = leaf, !path.isEmpty else { return (self, path) }
        let (axis, side) = LayoutNode.axisSide(dir)
        if path.count == 1, case .split(let direction, _, _, _)? = node(at: []), direction == axis, path[0] == side { return (self, path) }
        guard let removed = closing(.path(path)) else { return (self, path) }
        return (LayoutNode.beside(removed, leaf, side, axis), [side])
    }

    enum Drop: String, Sendable { case left, right, top, bottom, center }

    private static func pathAfterClose(_ from: Path, _ to: Path) -> Path? {
        guard !from.isEmpty else { return nil }
        if to.count >= from.count && Array(to.prefix(from.count)) == from { return nil }
        let parent = Array(from.dropLast())
        let other: Side = from.last == .first ? .second : .first
        let sibling = parent + [other]
        if to.count >= sibling.count && Array(to.prefix(sibling.count)) == sibling { return parent + to.dropFirst(sibling.count) }
        return to
    }

    /// Drag a pane onto another: an edge splits beside it, the center swaps the two sessions.
    func movingLeaf(from: Path, to: Path, where drop: Drop) -> (layout: LayoutNode, path: Path) {
        guard from != to, let leaf = node(at: from), case .session(let leafKey) = leaf,
              let target = node(at: to), case .session(let targetKey) = target else { return (self, from) }
        if drop == .center {
            return (replacing(.path(from), with: targetKey).replacing(.path(to), with: leafKey), to)
        }
        guard let dest = LayoutNode.pathAfterClose(from, to), let removed = closing(.path(from)), let staying = removed.node(at: dest) else { return (self, from) }
        let dir: Move = drop == .left ? .left : drop == .right ? .right : drop == .top ? .up : .down
        let (axis, side) = LayoutNode.axisSide(dir)
        return (removed.setting(dest, to: LayoutNode.beside(staying, leaf, side, axis)), dest + [side])
    }

    func mapKeys(_ fn: (String) -> String) -> LayoutNode {
        switch self {
        case .session(let key): return .session(fn(key))
        case .split(let direction, let ratio, let first, let second): return .split(direction: direction, ratio: ratio, first: first.mapKeys(fn), second: second.mapKeys(fn))
        }
    }
}

/// Workspaces 1–9, Hyprland-style (`../ah/web/workspaces.ts`): each holds an arrangement on
/// this device and window. Switching keeps the one you leave; sending moves a session over.
struct Workspaces: Equatable, Codable, Sendable {
    struct Slot: Equatable, Codable, Sendable {
        var layout: LayoutNode?
        var selected: String?

        static let empty = Slot(layout: nil, selected: nil)
        var isOccupied: Bool { selected != nil || layout != nil }
    }

    var current = 1
    var slots: [Int: Slot] = [:]

    /// Leave the current workspace (keeping `now` in it) for `n`; returns what to show.
    func switching(to n: Int, keeping now: Slot) -> (Workspaces, Slot) {
        var next = self
        next.slots[current] = now
        next.current = n
        return (next, n == current ? now : (next.slots[n] ?? .empty))
    }

    /// Send `key` (at `path` in a split) to workspace `n`: it leaves here and joins there,
    /// beside what's there or alone.
    func sending(_ key: String, to n: Int, keeping now: Slot, path: LayoutNode.Path?) -> (Workspaces, Slot) {
        guard n != current else { return (self, now) }
        var left = Slot.empty
        if let layout = now.layout, let path {
            let closed = layout.closing(.path(path))
            left = Slot(layout: LayoutNode.normalized(closed), selected: nil)
            if left.layout == nil {
                left.selected = (closed ?? layout).leaves().first { $0.sessionKey != key }?.sessionKey
            }
        }
        let there = slots[n] ?? .empty
        let joined: Slot
        if let layout = there.layout, let last = layout.leaves().last {
            joined = Slot(layout: layout.splitting(.path(last.path), direction: .horizontal, next: key), selected: nil)
        } else if let selected = there.selected, selected != key {
            joined = Slot(layout: LayoutNode.session(selected).splitting(.key(selected), direction: .horizontal, next: key), selected: nil)
        } else {
            joined = Slot(layout: nil, selected: key)
        }
        var next = self
        next.slots[current] = left
        next.slots[n] = joined
        return (next, left)
    }
}
