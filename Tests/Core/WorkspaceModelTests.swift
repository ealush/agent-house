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
@Test func workspacesKeepTheirArrangement() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    #expect(ws.switchWorkspace(2))
    #expect(ws.layout == nil && ws.selected == nil, "workspace 2 starts empty")
    ws.open("c")
    #expect(ws.switchWorkspace(1))
    #expect(ws.layout?.keys == ["a", "b"])
    ws.focus([.second])
    #expect(ws.sendToWorkspace(2))
    #expect(ws.layout == nil && ws.selected == "a", "b left; one pane is a single view")
    #expect(ws.switchWorkspace(2))
    #expect(ws.layout?.keys == ["c", "b"], "b tiled beside what was there")
    #expect(!ws.switchWorkspace(2))
}

@MainActor
@Test func paneModeKeysFocusMoveSplitAndLeave() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    ws.submap = .pane
    #expect(ws.submapKey("h", shift: false, digit: nil) == .handled)
    #expect(ws.focusedKey == "a")
    #expect(ws.submapKey("L", shift: true, digit: nil) == .handled)
    #expect(ws.layout?.keys == ["b", "a"], "Shift moves")
    #expect(ws.submapKey("v", shift: false, digit: nil) == .run("split-right"))
    #expect(ws.submapKey("f", shift: false, digit: nil) == .handled)
    #expect(ws.zoom)
    #expect(ws.submapKey("r", shift: false, digit: nil) == .handled)
    #expect(ws.submap == .resize)
    #expect(ws.submapKey("ArrowLeft", shift: true, digit: nil) == .handled)
    #expect(ws.submapKey("q", shift: false, digit: nil) == .left)
    #expect(ws.submap == nil, "any other key leaves resize mode")
    ws.submap = .pane
    #expect(ws.submapKey("o", shift: false, digit: nil) == .present(.openTileSwitcher))
    #expect(ws.submap == nil)
    ws.submap = .pane
    #expect(ws.submapKey("3", shift: false, digit: 3) == .handled)
    #expect(ws.journalSpaces.current == 3)
    ws.submap = .pane
    #expect(ws.submapKey("Escape", shift: false, digit: nil) == .left)
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
@Test func restoringAWindowKeepsItsWorkspacesAndFocus() {
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
    #expect(ws.journalSpaces == snapshot.workspaces)
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
    #expect(scene.pushedReview == ReviewRoute(stack: "s1"), "the tab's root is the list, so the stack is pushed")
    scene.pushedReview = nil
    #expect(scene.route == .review(ReviewRoute()), "back returns to the list")
    scene.narrow = false
    scene.openReview(ReviewRoute(stack: "s1"))
    #expect(scene.pushedReview == nil, "an iPad's detail shows the stack itself")
}
