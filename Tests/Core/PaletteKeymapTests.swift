import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The palette's icons, recents and session choices, and the keymap: two-key chords,
// conflicts you can resolve, reserved keys and the editor's search.

private let ctrlK = Chord("k", ctrl: true)

@Test func twoKeyChordsMatchRoundTripAndShowTheirLegend() {
    var bindings = KeyBindings()
    let chord = ctrlK.followed(by: Chord("s", ctrl: true))
    #expect(chord.formatted() == "⌃K ⌃S")
    #expect(chord.formatted(mac: false) == "Ctrl+K Ctrl+S")
    #expect(bindings.set("toggle-sidebar", chord) == nil)
    #expect(CommandMatcher.match(ctrlK, scope: .field, bindings: bindings) == nil, "the first key alone runs nothing")
    #expect(CommandMatcher.startsSequence(ctrlK, scope: .field, bindings: bindings))
    #expect(!CommandMatcher.startsSequence(ctrlK, scope: .ask, bindings: bindings))
    #expect(CommandMatcher.completeSequence(ctrlK, Chord("s", ctrl: true), scope: .app, bindings: bindings) == "toggle-sidebar")
    #expect(CommandMatcher.completeSequence(ctrlK, Chord("s"), scope: .app, bindings: bindings) == nil)
    #expect(KeyBindings(json: bindings.json()) == bindings, "stored with its second key")
    let legend = CommandMatcher.continuations(after: ctrlK, active: { _ in true }, bindings: bindings)
    #expect(legend == [CommandMatcher.WhichKeyRow(id: "toggle-sidebar", label: "Toggle sidebar", key: "⌃S")])
    let held = CommandMatcher.whichKey(ctrl: true, alt: false, shift: false, meta: false, active: { _ in true }, bindings: bindings)
    #expect(held.contains { $0.key == "K…" })
    // A bare second key is fine; Escape can't be one (it cancels).
    #expect(ctrlK.followed(by: Chord("s")).isUsable)
    #expect(bindings.bindingError("go-inbox", ctrlK.followed(by: Chord("Escape"))) != nil)
}

@Test func conflictsAreFoundAndCanBeTakenOver() {
    var bindings = KeyBindings()
    let flip = Chord("j", ctrl: true, alt: true)
    #expect(bindings.conflict("cycle-next", flip) == "toggle-split")
    #expect(bindings.set("cycle-next", flip)?.contains("Flip split") == true)
    #expect(bindings.set("cycle-next", flip, takingOver: true) == nil)
    #expect(bindings.chords("toggle-split").isEmpty, "the other command gives it up")
    #expect(CommandMatcher.match(flip, scope: .app, bindings: bindings) == "cycle-next")
    // A single key that starts another command's two-key chord clashes too.
    #expect(bindings.set("go-inbox", ctrlK.followed(by: Chord("i"))) == nil)
    #expect(bindings.bindingError("go-history", ctrlK)?.contains("Inbox") == true)
    #expect(bindings.bindingError("go-history", ctrlK.followed(by: Chord("h"))) == nil, "same first key, different second: fine")
}

@Test func addingRemovingAndResettingShortcuts() {
    var bindings = KeyBindings()
    let extra = Chord("y", ctrl: true, shift: true)
    #expect(bindings.set("switcher", extra, adding: true) == nil)
    #expect(bindings.chords("switcher") == [Chord("k", meta: true), Chord("k", ctrl: true, shift: true), extra])
    #expect(bindings.modified == ["switcher"])
    bindings.remove("switcher", extra)
    #expect(!bindings.isOverridden("switcher"), "back to the defaults clears the override")
    bindings.remove("switcher", Chord("k", meta: true))
    #expect(bindings.chords("switcher") == [Chord("k", ctrl: true, shift: true)])
    bindings.remove("switcher", Chord("k", ctrl: true, shift: true))
    #expect(bindings.chords("switcher").isEmpty && bindings.isOverridden("switcher"))
    bindings.reset("switcher")
    #expect(bindings.chords("switcher").count == 2)
}

@Test func keysTheSystemOrTypingKeepAreRefused() {
    let bindings = KeyBindings()
    #expect(bindings.bindingError("go-inbox", Chord("c", meta: true))?.contains("Copy") == true)
    #expect(bindings.bindingError("go-inbox", Chord("h", meta: true))?.contains("Home Screen") == true)
    #expect(bindings.bindingError("go-inbox", Chord("ArrowLeft", alt: true)) != nil)
    for command in CommandCatalog.all {
        for chord in command.chords {
            #expect(KeyBindings.reservedReason(chord) == nil, "\(command.id) defaults to a reserved key")
        }
    }
}

@Test func theEditorFindsCommandsByNameGroupOrKeys() {
    var bindings = KeyBindings()
    func ids(_ q: String, _ filter: KeymapSearch.Filter = .all) -> [CommandID] { KeymapSearch.commands(q, bindings: bindings, filter: filter).map(\.id) }
    #expect(ids("ctrl shift p").contains("command-palette"))
    #expect(ids("⌃⇧P").contains("command-palette"))
    #expect(ids("control+shift+p").contains("command-palette"))
    #expect(ids("cmd k") == ["switcher"])
    #expect(ids("sidebar").contains("toggle-sidebar"))
    #expect(ids("workspace").count >= 20, "by group")
    #expect(ids("alt down").contains("cycle-next"))
    #expect(ids("", .modified).isEmpty)
    _ = bindings.set("go-inbox", nil)
    #expect(ids("", .modified) == ["go-inbox"])
    #expect(ids("", .unbound).contains("go-inbox"))
    #expect(KeymapSearch.commands(pressing: Chord("p", meta: true, shift: true), bindings: bindings).map(\.id) == ["command-palette"])
}

@Test func everyCommandHasItsOwnIcon() {
    for command in CommandCatalog.all where command.id != "command-palette" {
        #expect(CommandCatalog.icon(command.id) != "command", "\(command.id) has no icon")
    }
    let tree = PaletteTree.resolve(active: { _ in true }, provide: { _ in [] })
    #expect(PaletteTree.search(tree, "split right").first?.node.icon == "rectangle.split.2x1")
}

@Test func recentRowsComeFirstOnlyAmongEqualMatches() {
    let tree = PaletteNode(key: "root", label: "Commands", children: [
        PaletteNode(key: "a", label: "Alpha one", action: .command("go-inbox")),
        PaletteNode(key: "b", label: "Alpha two", action: .command("go-history")),
        PaletteNode(key: "c", label: "Alphabet", action: .command("go-search")),
        PaletteNode(key: "s", label: "Sessions", children: [
            PaletteNode(key: "session:x", label: "fix flaky tests", action: .openSession("x"), children: [
                PaletteNode(key: "pane", label: "Open as a new pane", action: .openAsPane("x")),
            ]),
        ]),
    ])
    #expect(PaletteTree.search(tree, "alpha").map(\.node.key).prefix(2) == ["a", "b"])
    let recent = ["command:go-history", "session:x", "command:gone"]
    #expect(PaletteTree.search(tree, "alpha", recent: recent).map(\.node.key).prefix(2) == ["b", "a"])
    #expect(PaletteTree.recent(tree, keys: recent).map(\.key) == ["b", "session:x"], "what can't run here is skipped")
    // A session runs on Enter and keeps its choices out of search.
    let session = tree.children![3].children![0]
    #expect(session.hasChoices && !session.isCategory)
    #expect(!PaletteTree.search(tree, "new pane").contains { $0.node.key == "pane" })
    #expect(tree.children![3].leafCount == 1)
    #expect(PaletteAction.command("command-palette").recentKey == nil)
}

@MainActor
@Test func aTwoKeyChordWaitsForItsSecondKeyInTheWindow() throws {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(), device: DeviceDescriptor(name: "iPad", client: DeviceDescriptor.newClientID()), allowLoopback: true
    )
    let scene = SceneModel(sceneID: "chords", app: AppModel(services: services))
    #expect(scene.app.keyBindings.set("go-settings", ctrlK.followed(by: Chord(",", ctrl: true))) == nil)
    let k = KeyPress(hidUsage: 0x0E, characters: "k", modifiers: [.control])
    let comma = KeyPress(hidUsage: 0x36, characters: ",", modifiers: [.control])
    #expect(scene.handle(k, scope: .field))
    #expect(scene.pendingChord == ctrlK)
    #expect(scene.whichKey.map(\.label) == ["Settings"], "the legend shows what can follow")
    #expect(scene.handle(comma, scope: .field))
    #expect(scene.sheet == .settings(nil))
    #expect(scene.pendingChord == nil && scene.whichKey.isEmpty)
    // A pair that means nothing says so; Escape cancels quietly.
    scene.sheet = nil
    #expect(scene.handle(k, scope: .app))
    #expect(scene.handle(KeyPress(hidUsage: 0x04, characters: "a", modifiers: []), scope: .app))
    #expect(scene.toasts.last?.text == "⌃K A isn’t a shortcut")
    #expect(scene.handle(k, scope: .app))
    #expect(scene.handle(KeyPress(hidUsage: 0x29, characters: "", modifiers: []), scope: .app))
    #expect(scene.pendingChord == nil && scene.sheet == nil)
    // A menu key command arriving mid-chord is its second key.
    #expect(scene.handle(k, scope: .app))
    #expect(scene.allowsMenuCommand("switcher", chord: Chord(",", ctrl: true)))
    scene.runMenuCommand("switcher", chord: Chord(",", ctrl: true))
    #expect(scene.sheet == .settings(nil) && scene.switcher == nil)
}

@MainActor
@Test func behindASheetKeysReachOnlyDialogCommandsAndEscapeClosesIt() throws {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()), keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(), device: DeviceDescriptor(name: "iPad", client: DeviceDescriptor.newClientID()), allowLoopback: true
    )
    let scene = SceneModel(sceneID: "modal", app: AppModel(services: services))
    // The Apple keys sit beside ah's own.
    #expect(scene.app.keyBindings.chords("new-session").contains(Chord("n", meta: true)))
    #expect(scene.app.keyBindings.chords("interrupt").contains(Chord(".", meta: true)))
    let cmdComma = KeyPress(hidUsage: 0x36, characters: ",", modifiers: [.command])
    #expect(scene.handle(cmdComma, scope: .field), "⌘, opens Settings while typing")
    #expect(scene.sheet == .settings(nil))
    scene.modalWillPresent()
    // A command that would change what's under the sheet doesn't reach the app (with no
    // host, Settings and the shortcut table are what's available).
    #expect(!scene.allowsMenuCommand("show-shortcuts", chord: Chord("/", meta: true)))
    #expect(!scene.allowsMenuCommand("show-shortcuts", chord: nil))
    #expect(scene.allowsMenuCommand("go-settings", chord: Chord(",", meta: true)), "Settings works over a dialog")
    #expect(scene.handle(KeyPress(hidUsage: 0x29, characters: "", modifiers: []), scope: .app))
    #expect(scene.sheet == nil, "Esc closes the sheet though nothing in it has the keyboard")
    scene.modalDidDismiss()
    #expect(scene.allowsMenuCommand("show-shortcuts", chord: Chord("/", meta: true)))
}
