import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The native workspace beyond the web's: split left/above, balance, swap, cycling, workspace
// stepping, and the keyboard following the focused pane.

private func split(_ d: LayoutNode.Direction, _ r: Double, _ a: LayoutNode, _ b: LayoutNode) -> LayoutNode {
    .split(direction: d, ratio: r, first: a, second: b)
}

@Test func balancingGivesEachPaneItsShareAlongTheAxis() {
    // a | (b | c): three columns come out as thirds; a stacked pair counts once across.
    let three = split(.horizontal, 0.7, .session("a"), split(.horizontal, 0.2, .session("b"), .session("c"))).balanced()
    guard case .split(_, let outer, _, .split(_, let inner, _, _)) = three else { Issue.record("shape"); return }
    #expect(abs(outer - 1.0 / 3) < 1e-9)
    #expect(abs(inner - 0.5) < 1e-9)
    let mixed = split(.horizontal, 0.8, .session("a"), split(.vertical, 0.3, .session("b"), .session("c"))).balanced()
    guard case .split(_, let across, _, .split(_, let down, _, _)) = mixed else { Issue.record("shape"); return }
    #expect(abs(across - 0.5) < 1e-9)
    #expect(abs(down - 0.5) < 1e-9)
}

@Test func swappingTradesPlacesWithTheSpatialNeighbor() {
    // Two columns, the right one stacked: a | (b / c).
    let layout = split(.horizontal, 0.5, .session("a"), split(.vertical, 0.5, .session("b"), .session("c")))
    let swapped = layout.swapping([.first], .right)
    #expect(swapped.layout.keys == ["b", "a", "c"])
    #expect(swapped.path == [.second, .first], "the focus follows the pane that moved")
    let down = layout.swapping([.second, .first], .down)
    #expect(down.layout.keys == ["a", "c", "b"])
    #expect(layout.swapping([.first], .left).layout == layout, "nothing to the left")
}

@Test func aLayoutFitsOnlyWhenEveryPaneHasRoom() {
    let layout = split(.horizontal, 0.5, .session("a"), split(.vertical, 0.5, .session("b"), .session("c")))
    #expect(layout.fits(width: 1000, height: 800, minWidth: 260, minHeight: 200))
    #expect(!layout.fits(width: 480, height: 800, minWidth: 260, minHeight: 200), "a narrow Stage Manager window")
    #expect(!layout.fits(width: 1000, height: 360, minWidth: 260, minHeight: 200))
}

@MainActor
@Test func splitLeftAndAbovePutTheNewChooserFirst() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.split(.horizontal, before: true)
    #expect(ws.layout?.keys == [LayoutNode.pickKey(), "a"])
    #expect(ws.focusPath == [.first] && ws.chooserFocused)
    ws.fill([.first], with: "b")
    ws.focus([.second])
    ws.split(.vertical, before: true)
    #expect(ws.layout?.keys == ["b", LayoutNode.pickKey(), "a"])
    #expect(ws.focusPath == [.second, .first])
}

@MainActor
@Test func cyclingFocusWrapsInReadingOrder() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    ws.openTile("c", wide: false)
    #expect(ws.focusedKey == "c")
    ws.cycleFocus(1)
    #expect(ws.focusedKey == "a")
    ws.cycleFocus(-1)
    #expect(ws.focusedKey == "c")
    ws.swapPane(.up)
    #expect(ws.layout?.keys == ["a", "c", "b"])
    #expect(ws.focusedKey == "c")
    ws.balance()
    if case .split(_, let ratio, _, _)? = ws.layout { #expect(abs(ratio - 0.5) < 1e-9) }
}

@MainActor
@Test func workspaceSteppingVisitsOccupiedOnesOrTheNextNumber() {
    let ws = WorkspaceModel()
    ws.open("a")
    #expect(ws.stepWorkspace(1) == 2, "nothing else occupied: the next number")
    ws.open("b")
    ws.switchWorkspace(5)
    ws.open("c")
    #expect(ws.occupiedWorkspaces == [1, 2, 5])
    #expect(ws.stepWorkspace(1) == 1, "wraps among the occupied")
    #expect(ws.stepWorkspace(-1) == 5)
    #expect(ws.stepWorkspace(-1) == 2)
}

@MainActor
@Test func sendingAnySessionToAWorkspace() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    ws.focusPane(.left)
    // Not on screen: it joins workspace 3 and this one stays as it is.
    #expect(ws.sendSession("z", to: 3))
    #expect(ws.layout?.keys == ["a", "b"] && ws.focusedKey == "a")
    // On screen but not focused: it leaves, the focused pane keeps the focus.
    #expect(ws.sendSession("b", to: 3))
    #expect(ws.layout == nil && ws.selected == "a")
    ws.switchWorkspace(3)
    #expect(ws.layout?.keys == ["z", "b"])
    #expect(!ws.sendSession("z", to: 3), "already there")
}

@MainActor
@Test func paneModeSplitsBeforeSwapsBalancesAndCycles() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    ws.submap = .pane
    #expect(ws.submapKey("v", shift: true, digit: nil) == .run("split-left"))
    #expect(ws.submapKey("s", shift: true, digit: nil) == .run("split-above"))
    #expect(ws.submapKey("h", shift: false, alt: true, digit: nil) == .handled)
    #expect(ws.layout?.keys == ["b", "a"], "⌥h swaps left")
    #expect(ws.focusedKey == "b")
    #expect(ws.submapKey("Tab", shift: false, digit: nil) == .handled)
    #expect(ws.focusedKey == "a")
    ws.setRatio(at: [], 0.8)
    #expect(ws.submapKey("=", shift: false, digit: nil) == .handled)
    if case .split(_, let ratio, _, _)? = ws.layout { #expect(abs(ratio - 0.5) < 1e-9) }
    #expect(ws.submapKey("]", shift: false, digit: nil) == .handled)
    #expect(ws.submap == nil && ws.currentWorkspace == 2)
}

@Test func nativeCommandsKeepTheWebCatalogAndClashWithNothing() {
    #expect(CommandCatalog.web.count == 89)
    #expect(CommandCatalog.native.count == 13)
    #expect(Set(CommandCatalog.all.map(\.id)).count == CommandCatalog.all.count)
    var seen: [Chord: CommandID] = [:]
    for command in CommandCatalog.all {
        for chord in command.chords {
            #expect(seen[chord] == nil, "\(chord.formatted()) is both \(seen[chord]?.rawValue ?? "") and \(command.id.rawValue)")
            seen[chord] = command.id
        }
    }
    #expect(CommandMatcher.match(Chord("=", ctrl: true, shift: true), scope: .app) == "balance-panes")
    #expect(CommandMatcher.match(Chord("Tab", ctrl: true), scope: .field) == "focus-pane-next")
    #expect(CommandMatcher.match(Chord("]", ctrl: true, alt: true), scope: .terminal) == "workspace-next")
}

// MARK: The keyboard follows the focused pane

@MainActor
private func windowWithoutHost() throws -> SceneModel {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(), device: DeviceDescriptor(name: "iPad", client: DeviceDescriptor.newClientID()), allowLoopback: true
    )
    let scene = SceneModel(sceneID: "focus", app: AppModel(services: services))
    scene.hardwareKeyboard = true
    return scene
}

@MainActor
@Test func openingASessionPutsTheKeyboardInItsRememberedSpot() throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    #expect(scene.focusRequest?.target == .composer("a"), "the GUI's composer by default")
    scene.didFocus(.terminal("b"))
    scene.open("b")
    #expect(scene.focusRequest?.target == .terminal("b"), "where the keyboard was last in b")
    scene.hardwareKeyboard = false
    let nonce = scene.focusRequest?.nonce
    scene.open("a")
    #expect(scene.focusRequest?.nonce == nonce, "on touch alone, nothing raises the software keyboard")
}

@MainActor
@Test func focusingAComposerMakesItsPaneTheFocusedOne() throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    scene.workspace.openTile("b", wide: true)
    #expect(scene.workspace.focusedKey == "b")
    scene.didFocus(.composer("a"))
    #expect(scene.workspace.focusedKey == "a", "what looks focused is what gets the keys")
    scene.didBlur(.composer("a"))
    #expect(scene.currentFocus == nil)
}

@MainActor
@Test func aDismissedSheetPutsTheKeyboardBackOrDeliversWhatWasAsked() throws {
    let scene = try windowWithoutHost()
    scene.didFocus(.composer("a"))
    scene.palette = SceneModel.PaletteState()
    scene.modalWillPresent()
    scene.didBlur(.composer("a"))
    scene.palette = nil
    scene.modalDidDismiss()
    #expect(scene.focusRequest?.target == .composer("a"), "Escape out of the palette returns to the composer")

    scene.didFocus(.composer("a"))
    scene.modalWillPresent()
    scene.requestFocus(.terminal("b"))
    #expect(scene.focusRequest?.target == .composer("a"), "nothing behind the sheet takes the keyboard meanwhile")
    scene.modalDidDismiss()
    #expect(scene.focusRequest?.target == .terminal("b"), "what was asked for while it was up wins")
}

@MainActor
@Test func hoverFocusesAPaneOnlyWhenNothingElseIsGoingOn() throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    scene.workspace.openTile("b", wide: true)
    #expect(!scene.hoverFocus([.first]), "quiet right after the layout changed")
    let now = Date().addingTimeInterval(1)
    #expect(scene.hoverFocus([.first], now: now))
    #expect(scene.workspace.focusedKey == "a")
    #expect(scene.focusRequest?.target == .composer("a"), "hover moves the real keyboard focus too")
    #expect(!scene.hoverFocus([.first], now: now), "already focused")

    scene.workspace.dragging = true
    #expect(!scene.hoverFocus([.second], now: now), "not while a divider is dragged")
    scene.workspace.dragging = false
    scene.palette = SceneModel.PaletteState()
    #expect(!scene.hoverFocus([.second], now: now), "not under the palette")
    scene.palette = nil
    scene.suppressHover(now: now)
    #expect(!scene.hoverFocus([.second], now: now.addingTimeInterval(0.1)), "not just after the layout moved under the pointer")
    #expect(scene.hoverFocus([.second], now: now.addingTimeInterval(0.5)))
    scene.app.preferences.focusFollowsPointer = false
    #expect(!scene.hoverFocus([.first], now: now.addingTimeInterval(1)), "turned off")
}

@MainActor
@Test func tappingAPaneOutsideItsTextBoxBringsTheKeyboard() async throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    scene.workspace.openTile("b", wide: true)
    scene.didFocus(.composer("b"))
    await scene.tapPane([.first])
    #expect(scene.workspace.focusedKey == "a")
    #expect(scene.focusRequest?.target == .composer("a"))
    // A chooser pane's search takes the keyboard after a split.
    scene.workspace.split(.vertical)
    await scene.tapPane(scene.workspace.focusPath!)
    #expect(scene.focusRequest?.target == .chooser([.first, .second]))
}

@Test func panesTravelAsDragTextAndBadTextIsRefused() {
    #expect(LayoutNode.encode([.first, .second]) == "pane:f.s")
    #expect(LayoutNode.decodePath("pane:f.s") == [.first, .second])
    #expect(LayoutNode.decodePath("pane:") == [])
    #expect(LayoutNode.decodePath("pane:x") == nil)
    #expect(LayoutNode.decodePath("abc123") == nil, "a session key isn't a pane")
}

@MainActor
@Test func droppingOnPanesSplitsSwapsAndCarriesTheKeyboard() throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    // A sidebar session dropped on the single view's right edge splits beside it.
    scene.dropText("b", onto: nil, where: .right)
    #expect(scene.workspace.layout?.keys == ["a", "b"])
    #expect(scene.focusRequest?.target == .composer("b"))
    // Dropping the left pane on the right one's center swaps them.
    scene.dropText(LayoutNode.encode([.first]), onto: [.second], where: .center)
    #expect(scene.workspace.layout?.keys == ["b", "a"])
    // A new session dropped on a pane's bottom edge splits it.
    scene.dropText("c", onto: [.first], where: .bottom)
    #expect(scene.workspace.layout?.keys == ["b", "c", "a"])
    #expect(scene.workspace.focusedKey == "c")
    // An empty pane picks a session, or cancels and closes.
    scene.workspace.split(.horizontal)
    let chooser = scene.workspace.focusPath!
    scene.fillPane(chooser, with: "d")
    #expect(scene.workspace.focusedKey == "d")
    #expect(scene.focusRequest?.target == .composer("d"))
    scene.workspace.split(.vertical)
    scene.cancelChooser(scene.workspace.focusPath!)
    #expect(scene.workspace.layout?.keys.contains { LayoutNode.isPick($0) } == false)
}

@MainActor
@Test func whatACommandFocusedWinsOverTheKeyboardUIKitGivesBack() throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    scene.workspace.openTile("b", wide: true)
    scene.workspace.focus([.first])
    scene.didFocus(.composer("a"))
    scene.modalWillPresent()
    scene.requestFocus(.composer("b"))
    scene.workspace.focus([.second])
    scene.modalDidDismiss()
    // UIKit restores the composer that had the keyboard before the palette.
    scene.didFocus(.composer("a"))
    #expect(scene.workspace.focusedKey == "b", "the old composer doesn't pull the pane focus back")
    #expect(scene.focusRequest?.target == .composer("b"), "the asked-for focus is asked for again")
    scene.didFocus(.composer("b"))
    // Later, the user moving focus is just that.
    scene.didFocus(.composer("a"), now: Date().addingTimeInterval(1))
    #expect(scene.workspace.focusedKey == "a")
}

@MainActor
@Test func closingThePaletteAfterASplitDoesntSendTheKeyboardBack() throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    scene.didFocus(.composer("a"))
    let before = scene.focusRequest?.nonce
    scene.modalWillPresent()
    scene.workspace.openTile("b", wide: true)
    scene.modalDidDismiss()
    #expect(scene.focusRequest?.nonce == before, "the layout changed under the palette: no going back to the old composer")
}
