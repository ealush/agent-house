import Foundation
import Observation

/// One window's tiling workspace (`../ah/web/App.tsx`, `web/Workspace.tsx`): a single
/// session or a split of independent viewers, nine workspaces, a focused pane, a maximized
/// pane, Hyprland-style pane and resize submodes, and a floating scratchpad shell.
@MainActor
@Observable
final class WorkspaceModel {
    enum Submap: String, Sendable { case pane, resize }

    /// What the window shows: one session (nil: a page like the Inbox) or a split.
    private(set) var layout: LayoutNode?
    private(set) var selected: String?
    private(set) var focusPath: LayoutNode.Path?
    var zoom = false
    var submap: Submap?
    private(set) var spaces = Workspaces()
    var scratchVisible = false
    var scratchKey: String?
    var sidebarVisible = true
    /// A divider or pane is being dragged: hover never moves focus meanwhile.
    var dragging = false

    init() {}

    // MARK: Reading

    var splitOpen: Bool { (layout?.leaves().count ?? 0) > 1 }

    var focused: LayoutNode? { layout.flatMap { l in focusPath.flatMap { l.node(at: $0) } } }

    /// The session the keyboard and session commands act on.
    var focusedKey: String? {
        if let layout {
            let path = focusPath ?? layout.leaves().first?.path ?? []
            if case .session(let key)? = layout.node(at: path), !LayoutNode.isPick(key) { return key }
            return nil
        }
        return selected
    }

    var chooserFocused: Bool {
        guard let layout, let path = focusPath, case .session(let key)? = layout.node(at: path) else { return false }
        return LayoutNode.isPick(key)
    }

    /// Sessions on screen now (a split's panes, or the single one).
    var visibleKeys: [String] {
        if let layout { return layout.keys.filter { !LayoutNode.isPick($0) } }
        return selected.map { [$0] } ?? []
    }

    var slot: Workspaces.Slot { Workspaces.Slot(layout: layout, selected: layout == nil ? selected : nil) }

    // MARK: Opening

    /// Sidebar or switcher pick: in a split it replaces the focused pane, else it's the view.
    func open(_ key: String?) {
        if let layout, let key {
            let target = focusPath.flatMap { layout.node(at: $0) != nil ? $0 : nil } ?? layout.leaves().first?.path
            if let target {
                self.layout = layout.replacing(.path(target), with: key)
                focusPath = target
                return
            }
        }
        selected = key
    }

    /// Leaving for a page (Inbox, History…): the split goes away (it's kept in its workspace only by switching).
    func leaveSplit() {
        layout = nil
        focusPath = nil
        zoom = false
        selected = nil
    }

    /// Previous/Next session in sidebar order, from the focused one.
    func cycle(_ keys: [String], _ direction: Int) {
        if let next = cycleKey(keys, anchor: focusedKey ?? selected, direction: direction) { open(next) }
    }

    func restore(_ snapshot: SceneSnapshot) {
        spaces = snapshot.workspaces
        let slot = snapshot.workspaces.slots[snapshot.workspaces.current] ?? .empty
        layout = LayoutNode.normalized(slot.layout)
        selected = layout == nil ? (slot.selected ?? snapshot.session?.key) : nil
        focusPath = layout.flatMap { l in snapshot.focusedPane.flatMap { l.node(at: $0) != nil ? $0 : nil } ?? l.leaves().first?.path }
        zoom = snapshot.maximized && layout != nil
        sidebarVisible = snapshot.sidebarVisible
        scratchVisible = snapshot.scratchpadVisible
    }

    /// The workspaces with the current one written back, for the journal.
    var journalSpaces: Workspaces {
        var out = spaces
        out.slots[out.current] = slot
        return out
    }

    // MARK: Splitting

    /// Single view → split: the new half asks what goes there (or shows `other`). `before`
    /// puts the new half on the left or on top.
    func splitFrom(_ key: String, _ direction: LayoutNode.Direction, other: String? = nil, before: Bool = false) {
        layout = LayoutNode.session(key).splitting(.key(key), direction: direction, next: other ?? LayoutNode.pickKey(), before: before)
        selected = nil
        let added: LayoutNode.Side = before ? .first : .second
        focusPath = other != nil ? [added == .first ? .second : .first] : [added]
        zoom = false
    }

    /// Split the focused pane (a session or a chooser), or the single view: right or below,
    /// or with `before`, left or above. The new half is a chooser and takes the focus.
    func split(_ direction: LayoutNode.Direction, before: Bool = false) {
        if let layout, let path = focusPath ?? layout.leaves().first?.path {
            self.layout = layout.splitting(.path(path), direction: direction, next: LayoutNode.pickKey(), before: before)
            focusPath = path + [before ? .first : .second]
            zoom = false
        } else if let selected {
            splitFrom(selected, direction, before: before)
        }
    }

    /// Even out every divider.
    func balance() {
        guard let layout else { return }
        self.layout = layout.balanced()
    }

    /// Trade places with the pane in `dir`; focus stays with the session that moved.
    func swapPane(_ dir: LayoutNode.Move) {
        guard let layout, let path = focusPath ?? layout.leaves().first?.path else { return }
        let swapped = layout.swapping(path, dir)
        self.layout = swapped.layout
        focusPath = swapped.path
    }

    /// The next or previous pane in reading order, wrapping.
    func cycleFocus(_ step: Int) {
        guard let layout else { return }
        let paths = layout.leaves().map(\.path)
        guard !paths.isEmpty else { return }
        let i = focusPath.flatMap { paths.firstIndex(of: $0) } ?? 0
        focusPath = paths[(i + step + paths.count) % paths.count]
    }

    /// Close the focused pane without stopping its session; one pane left is just that session.
    func closePane() {
        guard let layout, let path = focusPath ?? layout.leaves().first?.path else {
            selected = nil
            return
        }
        let closed = layout.closing(.path(path))
        setLayout(closed)
    }

    private func setLayout(_ next: LayoutNode?) {
        if let next, next.leaves().count >= 2 {
            layout = next
            if focusPath.map({ next.node(at: $0) == nil }) ?? true { focusPath = next.leaves().first?.path }
            if case .split? = focusPath.flatMap({ next.node(at: $0) }) { focusPath = next.leaves().first?.path }
        } else {
            // Down to one pane: that session alone (a lone chooser closes to the page).
            let remaining = next?.leaves().first?.sessionKey
            layout = nil
            focusPath = nil
            zoom = false
            selected = remaining.flatMap { LayoutNode.isPick($0) ? nil : $0 }
        }
    }

    func focusPane(_ dir: LayoutNode.Move) {
        guard let layout else { return }
        let from = focusPath ?? layout.leaves().first?.path ?? []
        if let next = layout.neighbor(of: from, dir) { focusPath = next }
    }

    func focus(_ path: LayoutNode.Path) {
        guard layout?.node(at: path) != nil else { return }
        focusPath = path
    }

    func movePane(_ dir: LayoutNode.Move) {
        guard let layout else { return }
        let moved = layout.moving(focusPath ?? layout.leaves().first?.path ?? [], dir)
        self.layout = moved.layout
        focusPath = moved.path
    }

    func flip() {
        guard let layout else { return }
        self.layout = layout.flipping(focusPath ?? layout.leaves().first?.path ?? [])
    }

    func exitSplit() {
        // The focused session stays as the single view.
        let keep = focusedKey
        layout = nil
        focusPath = nil
        zoom = false
        selected = keep
    }

    /// Keyboard resize: the nearest divider in a split; with a single session, the side
    /// panel's edge (returned in points: negative widens it).
    func nudge(_ dir: LayoutNode.Move, big: Bool = false) -> Double? {
        if let layout, splitOpen, !zoom {
            self.layout = layout.nudgingDivider(from: focusPath ?? layout.leaves().first?.path ?? [], dir, step: big ? 0.15 : 0.05)
            return nil
        }
        guard dir == .left || dir == .right else { return nil }
        return (dir == .left ? -1 : 1) * (big ? 120 : 40)
    }

    func setRatio(at path: LayoutNode.Path, _ ratio: Double) {
        guard let layout else { return }
        self.layout = layout.settingRatio(at: path, ratio)
    }

    /// Replace pane: the focused pane becomes its chooser, remembering what it showed.
    func replaceWithChooser() {
        guard let layout, let path = focusPath, case .session(let key)? = layout.node(at: path), !LayoutNode.isPick(key) else { return }
        self.layout = layout.replacing(.path(path), with: LayoutNode.pickKey(previous: key))
    }

    /// A chooser picked something.
    func fill(_ path: LayoutNode.Path, with key: String) {
        guard let layout else {
            open(key)
            return
        }
        self.layout = layout.replacing(.path(path), with: key)
        focusPath = path
    }

    /// A chooser cancelled: put back what it replaced, or close it.
    func cancelChooser(_ path: LayoutNode.Path) {
        guard let layout, case .session(let key)? = layout.node(at: path) else { return }
        if let previous = LayoutNode.pickPrevious(key) {
            self.layout = layout.replacing(.path(path), with: previous)
        } else {
            setLayout(layout.closing(.path(path)))
        }
    }

    /// Open a session as a new pane, dwindle-style: beside the focused pane along its longer side.
    func openTile(_ key: String, wide: Bool) {
        let direction: LayoutNode.Direction = wide ? .horizontal : .vertical
        if let layout {
            let at = focusPath ?? layout.leaves().first?.path ?? []
            zoom = false
            self.layout = layout.splitting(.path(at), direction: direction, next: key)
            focusPath = at + [.second]
        } else if let selected, selected != key {
            splitFrom(selected, direction, other: key)
            focusPath = [.second]
        } else {
            open(key)
        }
    }

    // MARK: Drag and drop

    /// A session dragged from the sidebar onto a pane's edge (split) or center (replace).
    func drop(_ key: String, onto path: LayoutNode.Path?, where drop: LayoutNode.Drop) {
        guard let layout else {
            guard let selected, selected != key, drop != .center else {
                open(key)
                return
            }
            let direction: LayoutNode.Direction = drop == .left || drop == .right ? .horizontal : .vertical
            let before = drop == .left || drop == .top
            self.layout = LayoutNode.session(selected).splitting(.key(selected), direction: direction, next: key, before: before)
            self.selected = nil
            focusPath = [before ? .first : .second]
            zoom = false
            return
        }
        guard let path else { return }
        if drop == .center {
            fill(path, with: key)
        } else {
            let direction: LayoutNode.Direction = drop == .left || drop == .right ? .horizontal : .vertical
            let before = drop == .left || drop == .top
            self.layout = layout.splitting(.path(path), direction: direction, next: key, before: before)
            focusPath = path + [before ? .first : .second]
        }
    }

    /// A pane dragged onto another pane.
    func dropPane(from: LayoutNode.Path, to: LayoutNode.Path, where drop: LayoutNode.Drop) {
        guard let layout else { return }
        let moved = layout.movingLeaf(from: from, to: to, where: drop)
        self.layout = moved.layout
        focusPath = moved.path
    }

    /// A pane dragged to an outer edge of the workspace.
    func dock(_ path: LayoutNode.Path, _ dir: LayoutNode.Move) {
        guard let layout else { return }
        let docked = layout.docking(path, dir)
        self.layout = docked.layout
        focusPath = docked.path
    }

    // MARK: Workspaces 1–9

    @discardableResult
    func switchWorkspace(_ n: Int) -> Bool {
        guard n != spaces.current else { return false }
        let (next, shown) = spaces.switching(to: n, keeping: slot)
        spaces = next
        show(shown)
        return true
    }

    @discardableResult
    func sendToWorkspace(_ n: Int) -> Bool {
        guard let key = layout != nil ? focusedKey : selected, n != spaces.current else { return false }
        let path = layout != nil ? (focusPath ?? layout?.leaves().first?.path) : nil
        let (next, shown) = spaces.sending(key, to: n, keeping: slot, path: path)
        spaces = next
        show(shown)
        return true
    }

    /// Workspaces with something in them (the current one counts what's on screen).
    var occupiedWorkspaces: [Int] { spaces.occupied(now: slot) }
    var currentWorkspace: Int { spaces.current }

    /// The next or previous occupied workspace (or the neighboring number when no other is).
    @discardableResult
    func stepWorkspace(_ step: Int) -> Int? {
        let n = spaces.stepping(step, now: slot)
        return switchWorkspace(n) ? n : nil
    }

    /// Move any session to workspace `n`: off this screen if it's here, beside what's there.
    @discardableResult
    func sendSession(_ key: String, to n: Int) -> Bool {
        guard n != spaces.current else { return false }
        if let layout, let leaf = layout.leaves().first(where: { $0.sessionKey == key }) {
            let keep = focusedKey == key ? nil : focusedKey
            let (next, shown) = spaces.sending(key, to: n, keeping: slot, path: leaf.path)
            spaces = next
            show(shown)
            // The pane you were in keeps the focus when it's still here.
            if let keep, let path = self.layout?.leaves().first(where: { $0.sessionKey == keep })?.path { focusPath = path }
        } else if layout == nil, selected == key {
            let (next, shown) = spaces.sending(key, to: n, keeping: slot, path: nil)
            spaces = next
            show(shown)
        } else {
            spaces = spaces.adding(key, to: n, keeping: slot)
        }
        return true
    }

    private func show(_ slot: Workspaces.Slot) {
        zoom = false
        layout = LayoutNode.normalized(slot.layout)
        selected = layout == nil ? slot.selected : nil
        focusPath = layout?.leaves().first?.path
    }

    // MARK: Submaps

    /// What a key does in pane or resize mode. Directions stay in the mode; actions that open
    /// something leave it and tell the window to present it.
    enum SubmapResult: Equatable, Sendable {
        case handled
        case left
        case run(CommandID)
        case present(Presentation)
    }

    enum Presentation: Equatable, Sendable { case openTileSwitcher, newSession, scratchpad }

    func submapKey(_ key: String, shift: Bool, alt: Bool = false, digit: Int?) -> SubmapResult {
        guard let mode = submap else { return .left }
        let directions: [String: LayoutNode.Move] = ["arrowleft": .left, "arrowright": .right, "arrowup": .up, "arrowdown": .down, "h": .left, "l": .right, "k": .up, "j": .down]
        let lowered = key.lowercased()
        if lowered == "escape" || lowered == "enter" {
            submap = nil
            return .left
        }
        let dir = directions[lowered]
        if mode == .resize {
            if let dir {
                _ = nudge(dir, big: shift)
                return .handled
            }
            submap = nil
            return .left
        }
        if let dir {
            if alt { swapPane(dir) } else if shift { movePane(dir) } else { focusPane(dir) }
            return .handled
        }
        if let digit, (1...9).contains(digit) {
            submap = nil
            if shift { sendToWorkspace(digit) } else { switchWorkspace(digit) }
            return .handled
        }
        switch lowered {
        case "v": return .run(shift ? "split-left" : "split-right")
        case "s": return .run(shift ? "split-above" : "split-below")
        case "=":
            balance()
            return .handled
        case "tab":
            cycleFocus(shift ? -1 : 1)
            return .handled
        case "[", "]":
            submap = nil
            stepWorkspace(lowered == "]" ? 1 : -1)
            return .handled
        case "x": return .run("close-pane")
        case "p":
            submap = nil
            return .run("replace-pane")
        case "f":
            zoom.toggle()
            return .handled
        case "t":
            flip()
            return .handled
        case "r":
            submap = .resize
            return .handled
        case "o":
            submap = nil
            return .present(.openTileSwitcher)
        case "n":
            submap = nil
            return .present(.newSession)
        case "`":
            submap = nil
            return .present(.scratchpad)
        default:
            return .handled
        }
    }

    static let submapKeys: [Submap: [(keys: [String], label: String)]] = [
        .resize: [(["←", "↓", "↑", "→"], "move the divider"), (["H", "J", "K", "L"], "same"), (["⇧"], "bigger steps"), (["Esc"], "done")],
        .pane: [
            (["H", "J", "K", "L"], "focus"), (["⇧", "HJKL"], "move"), (["⌥", "HJKL"], "swap"), (["Tab"], "next pane"),
            (["V"], "split right"), (["⇧", "V"], "split left"), (["S"], "split below"), (["⇧", "S"], "split above"), (["="], "balance"),
            (["P"], "replace"), (["X"], "close"), (["F"], "maximize"), (["T"], "flip"), (["R"], "resize"), (["O"], "open here"),
            (["N"], "new session"), (["1–9"], "workspace"), (["[", "]"], "prev / next workspace"), (["Esc"], "done"),
        ],
    ]
}
