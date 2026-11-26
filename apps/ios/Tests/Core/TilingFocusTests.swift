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
@Test func paneModeSplitsBeforeSwapsBalancesAndCycles() {
    let ws = WorkspaceModel()
    ws.open("a")
    ws.openTile("b", wide: true)
    ws.submap = .pane
    #expect(ws.submapKey("v", shift: true) == .run("split-left"))
    #expect(ws.submapKey("s", shift: true) == .run("split-above"))
    #expect(ws.submapKey("h", shift: false, alt: true) == .handled)
    #expect(ws.layout?.keys == ["b", "a"], "⌥h swaps left")
    #expect(ws.focusedKey == "b")
    #expect(ws.submapKey("Tab", shift: false) == .handled)
    #expect(ws.focusedKey == "a")
    ws.setRatio(at: [], 0.8)
    #expect(ws.submapKey("=", shift: false) == .handled)
    if case .split(_, let ratio, _, _)? = ws.layout { #expect(abs(ratio - 0.5) < 1e-9) }
}

@Test func nativeCommandsKeepTheWebCatalogAndClashWithNothing() {
    #expect(CommandCatalog.web.count == 73)
    #expect(CommandCatalog.native.count == 32)
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
    #expect(CommandMatcher.match(Chord("]", ctrl: true, alt: true), scope: .terminal) == nil, "no workspaces to step through")
    #expect(CommandMatcher.match(Chord("c", meta: true, alt: true), scope: .app) == "copy-link")
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
@Test func aBoxThatLosesTheKeyboardToARebuiltColumnGetsItBack() throws {
    let scene = try windowWithoutHost()
    let took = Date()
    scene.didFocus(.composer(SceneModel.newSessionKey), now: took)
    // The split rebuilt its column: UIKit gave the root the keyboard, then the box said so.
    let asked = scene.focusRequest?.nonce
    scene.rootTookKeyboard(now: took.addingTimeInterval(0.7))
    #expect(scene.focusRequest?.nonce == asked, "the box still has it, as far as anyone has said")
    scene.didBlur(.composer(SceneModel.newSessionKey))
    #expect(scene.focusRequest?.target == .composer(SceneModel.newSessionKey), "New session's box takes it back, so Return starts the session")
    let nonce = scene.focusRequest?.nonce
    scene.rootTookKeyboard(now: took.addingTimeInterval(0.8))
    #expect(scene.focusRequest?.nonce == nonce, "once")

    scene.didFocus(.composer("a"), now: took)
    scene.didBlur(.composer("a"))
    scene.rootTookKeyboard(now: took.addingTimeInterval(SceneModel.rebuildWindow + 1))
    #expect(scene.focusRequest?.nonce == nonce, "long after, the root having it is someone's doing")

    scene.didFocus(.composer("a"), now: took)
    scene.didBlur(.composer("a"))
    scene.didFocus(.terminal("b"), now: took)
    scene.rootTookKeyboard(now: took.addingTimeInterval(0.5))
    #expect(scene.focusRequest?.nonce == nonce, "nor when something else has it")

    scene.hardwareKeyboard = false
    scene.didFocus(.composer("a"), now: took)
    scene.didBlur(.composer("a"))
    scene.rootTookKeyboard(now: took.addingTimeInterval(0.5))
    #expect(scene.focusRequest?.nonce == nonce, "on touch alone, the on-screen keyboard stays down")
}

@Test func aBoxMadeLaterTakesOnlyARecentFocusRequest() {
    let asked = Date()
    let request = SceneModel.FocusRequest(target: .composer("a"), nonce: 1, at: asked)
    #expect(request.isFresh(forBoxMadeAt: asked.addingTimeInterval(-60), now: asked.addingTimeInterval(30)), "a box already there takes what's asked of it")
    #expect(request.isFresh(forBoxMadeAt: asked.addingTimeInterval(0.3), now: asked.addingTimeInterval(0.4)), "the screen a request opened comes in and takes it")
    #expect(!request.isFresh(forBoxMadeAt: asked.addingTimeInterval(20), now: asked.addingTimeInterval(20)), "opening the session again later leaves the keyboard down")
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

private func row(_ key: String, _ title: String, status: String) throws -> SessionRow {
    let object: [String: Any] = ["id": "%\(key)", "uid": key, "name": title, "title": title, "statusSource": "hook", "project": "web", "projectPath": "/p/web", "status": status, "command": "node", "agent": "claude"]
    return SessionRow(key: key, host: "desk", isLocal: true, dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
}

@MainActor
@Test func sessionsOffScreenNudgeWhenTheyNeedYouOrFinish() throws {
    let scene = try windowWithoutHost()
    scene.open("a")
    let start = Date()
    scene.notice([try row("a", "Here", status: "busy"), try row("b", "Keys", status: "busy"), try row("c", "Docs", status: "busy")], at: start)
    #expect(scene.nudges.isEmpty, "a first look nudges nothing")
    let ended = [try row("a", "Here", status: "attention"), try row("b", "Keys", status: "waiting"), try row("c", "Docs", status: "attention")]
    scene.notice(ended, at: start.addingTimeInterval(1))
    #expect(scene.nudges.map(\.key) == ["b"], "needing you nudges at once; a turn's end waits to see it stays ended")
    scene.notice(ended, at: start.addingTimeInterval(31))
    #expect(scene.nudges.map(\.key) == ["b", "c"], "the open session is on screen: no nudge for it")
    #expect(scene.nudges.first?.kind == .needsYou && scene.nudges.last?.kind == .finished)
    // Answered from another device: the nudge goes.
    scene.notice([try row("a", "Here", status: "idle"), try row("b", "Keys", status: "busy"), try row("c", "Docs", status: "attention")], at: start.addingTimeInterval(32))
    #expect(scene.nudges.map(\.key) == ["c"])
    // Opening it from the nudge takes you there and clears it.
    scene.openNudge(scene.nudges[0])
    #expect(scene.nudges.isEmpty)
    #expect(scene.workspace.focusedKey == "c" || scene.route == .session("c"))
}

@MainActor
@Test func aSessionThatKeepsPausingBetweenBurstsOfWorkIsNotNudgedAsFinished() throws {
    let scene = try windowWithoutHost()
    let start = Date()
    scene.notice([try row("c", "Chief", status: "busy")], at: start)
    for s in stride(from: 0.0, to: 60, by: 3) {
        scene.notice([try row("c", "Chief", status: "attention")], at: start.addingTimeInterval(s + 1))
        scene.notice([try row("c", "Chief", status: "busy")], at: start.addingTimeInterval(s + 2))
    }
    #expect(scene.nudges.isEmpty, "twenty pauses in a minute, no card")
    scene.notice([try row("c", "Chief", status: "attention")], at: start.addingTimeInterval(70))
    scene.notice([try row("c", "Chief", status: "attention")], at: start.addingTimeInterval(100))
    #expect(scene.nudges.map(\.kind) == [.finished], "once it stays done: one card")
}

@MainActor
@Test func theCachedListAtLaunchIsNotALook() throws {
    let scene = try windowWithoutHost()
    // Sealed while it was working; by the time the host answers, it needs you. That's
    // the Inbox's news, not a nudge popping up over a cold launch.
    scene.notice([try row("b", "Keys", status: "busy")], live: false)
    scene.notice([try row("b", "Keys", status: "waiting")])
    #expect(scene.nudges.isEmpty)
    // From then on, changes nudge as usual.
    scene.notice([try row("b", "Keys", status: "busy")])
    scene.notice([try row("b", "Keys", status: "waiting")])
    #expect(scene.nudges.map(\.key) == ["b"])
}

private func forked(_ key: String, _ title: String, root: String?, created: Double) throws -> SessionRow {
    var object: [String: Any] = ["id": "%\(key)", "uid": key, "name": title, "title": title, "statusSource": "hook", "project": "web", "projectPath": "/p/web", "status": "idle", "command": "node", "agent": "claude", "branch": "ah/\(key)", "createdAt": created]
    if let root { object["fork"] = ["parentUid": root, "parentTitle": "Root", "rootUid": root, "forks": 0] }
    return SessionRow(key: key, host: "desk", isLocal: true, dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
}

@Test func aForkKnowsItsFamily() throws {
    let root = try forked("r", "Parser", root: nil, created: 1)
    let a = try forked("a", "Parser (fork)", root: "r", created: 3)
    let b = try forked("b", "Parser (risky)", root: "r", created: 2)
    let other = try forked("x", "Unrelated", root: nil, created: 4)
    let lines = ForkFamily.lines(of: a, rows: [other, a, root, b], history: [])
    #expect(lines.map(\.uid) == ["r", "b", "a"], "the root first, then forks as they were opened")
    #expect(lines.first?.isRoot == true && lines.last?.isCurrent == true)
    #expect(ForkFamily.lines(of: other, rows: [other, a, root, b], history: []).isEmpty, "no family, no list")
    // The root ended: it comes from History, with nowhere to open it as a live session.
    let past = HistoryRow(host: "desk", isLocal: true, dto: try JSONDecoder().decode(HistoryItemDTO.self, from: JSONSerialization.data(withJSONObject: ["ref": "r", "kind": "ended", "harness": "claude", "title": "Parser", "cwd": "/p", "project": "web", "at": 0] as [String: Any])))
    let orphaned = ForkFamily.lines(of: a, rows: [a, b], history: [past])
    #expect(orphaned.first?.key == nil && orphaned.first?.title == "Parser")
}

// MARK: Links

@MainActor
@Test func copyLinkNamesWhatsOnScreenAndALinkWaitsForTheWindowsState() throws {
    let scene = try windowWithoutHost()
    var copied: String?
    scene.clipboard = { copied = $0 }
    #expect(!scene.isAvailable("copy-link"), "no host, no link")
    #expect(scene.isAvailable("open-link"), "a link names its own host")
    scene.useAccount("https://desk.tail1234.ts.net")
    scene.copyLink(to: scene.place)
    #expect(copied == "https://desk.tail1234.ts.net/")
    scene.copyLink(to: Place(.session("a1b2c3"), message: 9))
    #expect(copied == "https://desk.tail1234.ts.net/#a1b2c3?m=9")
    #expect(scene.toasts.last?.text == "Copied a link to the message")

    // Before the window's own state is back, a link's place waits instead of being covered.
    scene.go(Place(.review(ReviewRoute())))
    #expect(scene.route == .inbox)

    // Nothing on the clipboard that's a link: said so.
    scene.pasteboard = { "not a link" }
    scene.perform("open-link")
    #expect(scene.toasts.last?.text == "There’s no link on the clipboard")

    // Typed into a search field, a link to a place is offered; other text and addresses aren't.
    #expect(scene.pastedLink("https://desk.tail1234.ts.net/#history")?.summary == "Inbox · Search")
    #expect(scene.pastedLink("agenthub://desk/a1b2c3?m=4")?.summary == "a1b2c3 · message 4")
    #expect(scene.pastedLink("https://example.com/pricing") == nil)
    #expect(scene.pastedLink("users latency") == nil)
}

@MainActor
@Test func theReviewPathFollowsTheRouteAndOutlivesIt() throws {
    let scene = try windowWithoutHost()
    let stack = ReviewRoute(stack: "abcd")
    let layer = ReviewRoute(stack: "abcd", pr: 7)

    scene.openReview(layer)
    #expect(scene.reviewPath == [stack, layer], "a link to a layer has its stack under it")
    scene.reviewPath = [stack]
    #expect(scene.route == .review(stack), "back from the layer")

    // A session opened from the stack: the stack stays pushed, and the tab returns to it.
    scene.open("a")
    #expect(scene.reviewPath == [stack])
    #expect(scene.tabRoute(.review(ReviewRoute())) == .review(stack))
    #expect(scene.tabRoute(.inbox) == .inbox)

    scene.show(.review(stack))
    scene.reviewPath.append(layer)
    #expect(scene.route == .review(layer), "pushing a layer is the route")
    scene.reviewPath = []
    #expect(scene.route == .review(ReviewRoute()), "back to the list")

    scene.show(.review(ReviewRoute(pick: true)))
    #expect(scene.route == .review(ReviewRoute(pick: true)) && scene.reviewPath.isEmpty, "the picker has nothing pushed")
}
