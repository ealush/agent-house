import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@MainActor
@Test func splittingFromOneSessionAsksWhatGoesInTheNewHalf() {
    let ws = WorkspaceModel()
    ws.open("a")
    #expect(ws.visibleKeys == ["a"])
    ws.split(.horizontal)
    #expect(ws.layout?.keys == ["a", LayoutNode.pickKey()])
    #expect(ws.focusPath == [.second])
    #expect(ws.chooserFocused)
    #expect(ws.focusedKey == nil, "a chooser isn't a session")
    ws.fill([.second], with: "b")
    #expect(ws.layout?.keys == ["a", "b"])
    #expect(ws.focusedKey == "b")
    // Close the focused pane: one left is just that session, not a split.
    ws.closePane()
    #expect(ws.layout == nil)
    #expect(ws.selected == "a")
}

@MainActor
@Test func aCancelledChooserPutsBackWhatItReplacedOrCloses() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    #expect(ws.layout?.keys == ["a", "b"])
    #expect(ws.focusedKey == "b")
    ws.replaceWithChooser()
    #expect(ws.layout?.keys == ["a", LayoutNode.pickKey(previous: "b")])
    ws.cancelChooser([.second])
    #expect(ws.layout?.keys == ["a", "b"], "Escape keeps what was there")
    ws.split(.vertical)
    ws.cancelChooser([.second, .second])
    #expect(ws.layout?.keys == ["a", "b"], "a new split's chooser closes on cancel")
}

@MainActor
@Test func theSidebarReplacesTheFocusedPaneInASplit() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    ws.focusPane(.left)
    #expect(ws.focusedKey == "a")
    ws.open("c")
    #expect(ws.layout?.keys == ["c", "b"])
    ws.movePane(.right)
    #expect(ws.layout?.keys == ["b", "c"])
    #expect(ws.focusedKey == "c")
    ws.flip()
    if case .split(let direction, _, _, _)? = ws.layout { #expect(direction == .vertical) }
    #expect(ws.nudge(.down) == nil)
    if case .split(_, let ratio, _, _)? = ws.layout { #expect(abs(ratio - 0.55) < 1e-9) }
    ws.exitSplit()
    #expect(ws.layout == nil && ws.selected == "c", "the focused session stays")
    // Without a split, left/right resize the side panel instead.
    #expect(ws.nudge(.left) == -40)
    #expect(ws.nudge(.right, big: true) == 120)
}

@MainActor
@Test func paneModeKeysFocusMoveSplitAndLeave() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    ws.submap = .pane
    #expect(ws.submapKey("h", shift: false) == .handled)
    #expect(ws.focusedKey == "a")
    #expect(ws.submapKey("L", shift: true) == .handled)
    #expect(ws.layout?.keys == ["b", "a"], "Shift moves")
    #expect(ws.submapKey("v", shift: false) == .run("split-right"))
    #expect(ws.submapKey("f", shift: false) == .handled)
    #expect(ws.zoom)
    #expect(ws.submapKey("r", shift: false) == .handled)
    #expect(ws.submap == .resize)
    #expect(ws.submapKey("ArrowLeft", shift: true) == .handled)
    #expect(ws.submapKey("q", shift: false) == .left)
    #expect(ws.submap == nil, "any other key leaves resize mode")
    ws.submap = .pane
    #expect(ws.submapKey("o", shift: false) == .present(.openTileSwitcher))
    #expect(ws.submap == nil)
    ws.submap = .pane
    #expect(ws.submapKey("3", shift: false) == .handled, "a digit is nothing now: no workspaces")
    #expect(ws.submap == .pane && ws.journalSpaces.current == 1)
    #expect(ws.submapKey("Escape", shift: false) == .left)
}

@MainActor
@Test func dragAndDropSplitsReplacesAndDocks() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.drop("b", onto: nil, where: .left)
    #expect(ws.layout?.keys == ["b", "a"])
    #expect(ws.focusedKey == "b")
    ws.drop("c", onto: [.second], where: .bottom)
    #expect(ws.layout?.keys == ["b", "a", "c"])
    ws.drop("d", onto: [.first], where: .center)
    #expect(ws.layout?.keys == ["d", "a", "c"])
    ws.dropPane(from: [.second, .second], to: [.first], where: .center)
    #expect(ws.layout?.keys == ["c", "a", "d"])
    ws.dock([.second, .first], .down)
    #expect(ws.layout?.leaves().last?.sessionKey == "a")
}

@MainActor
@Test func restoringAWindowKeepsTheWorkspaceItWasOnAndFocus() {
    var snapshot = SceneSnapshot(sceneID: "w", hostOrigin: nil)
    snapshot.workspaces = Workspaces(current: 4, slots: [4: .init(layout: .split(direction: .horizontal, ratio: 0.3, first: .session("a"), second: .session("b")), selected: nil)])
    snapshot.focusedPane = [.second]
    snapshot.maximized = true
    snapshot.sidebarVisible = false
    let ws = WorkspaceModel()
    ws.restore(snapshot)
    #expect(ws.focusedKey == "b")
    #expect(ws.zoom)
    #expect(!ws.sidebarVisible)
    // A journal from when there were workspaces 1–9: the one it was on is what it shows,
    // and what it writes back is that alone.
    #expect(ws.journalSpaces == Workspaces(current: 1, slots: [1: snapshot.workspaces.slots[4]!]))
}

@MainActor
@Test func aPhonesReviewTabPushesTheStackOverItsList() throws {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(), device: DeviceDescriptor(name: "iPhone", client: DeviceDescriptor.newClientID()), allowLoopback: true
    )
    let scene = SceneModel(sceneID: "phone-review", app: AppModel(services: services))
    scene.narrow = true
    scene.openReview(ReviewRoute(stack: "s1"))
    #expect(scene.reviewPath == [ReviewRoute(stack: "s1")], "the tab's root is the list, so the stack is pushed")
    scene.reviewPath = []
    #expect(scene.route == .review(ReviewRoute()), "back returns to the list")
}

@MainActor
@Test func resizingStopsWhereAPaneWouldGetTooSmall() throws {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.split(.horizontal)
    ws.fill([.second], with: "b")
    ws.focus([.first])
    // 700 pt wide: each pane needs 300, so the divider can't pass about 0.57.
    ws.canvas = (700, 800)
    for _ in 0..<6 { _ = ws.nudge(.right) }
    let layout = try #require(ws.layout)
    #expect(ws.fits(layout), "the right pane never drops below the minimum")
    guard case .split(_, let ratio, _, _) = layout else { Issue.record("still a split"); return }
    #expect(ratio > 0.52 && ratio <= 300.0 / 700 + 0.15 + 0.01)
    // A drag past the limit stops at it; a drag that fits goes all the way.
    ws.setRatio(at: [], 0.95)
    guard case .split(_, let dragged, _, _)? = ws.layout else { Issue.record("still a split"); return }
    #expect(ws.fits(ws.layout!) && dragged > 0.55 && dragged < 0.58)
    ws.setRatio(at: [], 0.5)
    guard case .split(_, let back, _, _)? = ws.layout else { Issue.record("still a split"); return }
    #expect(back == 0.5)
    // Without a known canvas (or a window already too small) nothing is held back.
    ws.canvas = nil
    ws.setRatio(at: [], 0.8)
    guard case .split(_, let free, _, _)? = ws.layout else { Issue.record("still a split"); return }
    #expect(free == 0.8)
}

@MainActor
@Test func aWindowIsNamedAfterWhatItShows() throws {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(), device: DeviceDescriptor(name: "iPad", client: DeviceDescriptor.newClientID()), allowLoopback: true
    )
    let scene = SceneModel(sceneID: "titles", app: AppModel(services: services))
    #expect(scene.windowTitle == "Inbox")
    scene.show(.review(ReviewRoute()))
    #expect(scene.windowTitle == "Review")
    scene.show(.settings(nil))
    #expect(scene.windowTitle == "Settings")
    // A session no host lists (yet) still names the window plainly.
    scene.open("abc")
    #expect(scene.windowTitle == "Session")
    scene.workspace.split(.horizontal)
    #expect(scene.windowTitle == "New Pane", "a split goes to its new, empty pane")
    scene.workspace.focus([.first])
    #expect(scene.windowTitle == "Session", "then after the focused pane's session")
}
