import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Ports of ../ah/test/shortcuts.test.ts, keyboard.test.ts and palette.test.ts.

private func press(_ key: String, meta: Bool = false, ctrl: Bool = false, alt: Bool = false, shift: Bool = false, scope: KeyScope = .app, bindings: KeyBindings = KeyBindings(), field: FieldState = FieldState()) -> CommandID? {
    CommandMatcher.match(Chord(key, meta: meta, ctrl: ctrl, alt: alt, shift: shift), scope: scope, bindings: bindings, field: field)
}

@Test func theCatalogHasEightyNineCommandsAndNoSharedDefaults() {
    #expect(CommandCatalog.all.count == 89)
    #expect(Set(CommandCatalog.all.map(\.id)).count == 89)
    var seen: [String: CommandID] = [:]
    for command in CommandCatalog.all {
        for chord in command.chords {
            let key = chord.formatted(mac: false)
            #expect(seen[key] == nil, "\(key) is both \(seen[key]?.rawValue ?? "") and \(command.id.rawValue)")
            seen[key] = command.id
        }
    }
    #expect(CommandCatalog.all.filter { $0.group == .navigate }.count == 17)
    #expect(CommandCatalog.all.filter { $0.group == .session }.count == 31)
    #expect(CommandCatalog.all.filter { $0.group == .workspace }.count == 41)
}

@Test func switcherAndCyclingMatchTheirChords() {
    #expect(press("k", meta: true) == "switcher")
    #expect(press("k", ctrl: true, shift: true) == "switcher")
    #expect(press("ArrowUp", alt: true) == "cycle-prev")
    #expect(press("ArrowDown", alt: true) == "cycle-next")
    #expect(press("ArrowUp", alt: true, shift: true) == nil)
    #expect(press("k") == nil, "a plain letter is never a shortcut")
}

@Test func digitsAndPunctuationKeepTheirPhysicalName() {
    // Shift+1 on a US layout produces "!", but the physical key is 1.
    let bang = KeyPress(hidUsage: 0x1E, characters: "!", modifiers: [.control, .shift])
    #expect(bang.chord == Chord("1", ctrl: true, shift: true))
    #expect(CommandMatcher.match(bang.chord!, scope: .app) == "go-inbox")
    let pipe = KeyPress(hidUsage: 0x31, characters: "|", modifiers: [.control, .shift])
    #expect(CommandMatcher.match(pipe.chord!, scope: .app) == "split-right")
    let underscore = KeyPress(hidUsage: 0x2D, characters: "_", modifiers: [.control, .shift])
    #expect(CommandMatcher.match(underscore.chord!, scope: .app) == "split-below")
    let question = KeyPress(hidUsage: 0x38, characters: "?", modifiers: [.control, .shift])
    #expect(CommandMatcher.match(question.chord!, scope: .app) == "show-shortcuts")
    // Colemak: the physical E key produces "f"; letters follow the layout.
    let colemak = KeyPress(hidUsage: 0x08, characters: "f", modifiers: [.control, .option])
    #expect(CommandMatcher.match(colemak.chord!, scope: .app) == "fork")
    #expect(KeyPress(hidUsage: 0xE0, characters: "", modifiers: [.control]).chord == nil, "a modifier alone is not a chord")
    #expect(KeyPress(hidUsage: 0x52, characters: "UIKeyInputUpArrow", modifiers: [.option]).chord == Chord("ArrowUp", alt: true))
}

@Test func scopesDecideWhoOwnsTheKey() {
    #expect(press("ArrowDown", alt: true, scope: .field) == "cycle-next")
    #expect(press("g", ctrl: true, shift: true, scope: .field) == "toggle-view")
    #expect(press("g", scope: .field) == nil)
    #expect(press("k", meta: true, scope: .field) == "switcher")
    #expect(press("Enter", ctrl: true, shift: true, scope: .dialog) == nil)
    #expect(press("k", ctrl: true, shift: true, scope: .dialog) == "switcher")
    #expect(press("k", meta: true, scope: .ask) == nil, "an agent's question form owns the keyboard")
    #expect(press("g", ctrl: true, shift: true, scope: .terminal) == "toggle-view")
    #expect(press("p", ctrl: true, shift: true, scope: .dialog) == nil)
    #expect(press("j", ctrl: true, shift: true) == "toggle-panel")
}

@Test func overridesReplaceDefaultsAndNilUnbinds() {
    var bindings = KeyBindings()
    #expect(bindings.set("cycle-next", Chord("j", ctrl: true, alt: true)) != nil, "taken by Flip split")
    #expect(bindings.set("cycle-next", Chord("y", ctrl: true, shift: true)) == nil)
    #expect(bindings.set("toggle-sidebar", nil) == nil)
    #expect(press("y", ctrl: true, shift: true, bindings: bindings) == "cycle-next")
    #expect(press("ArrowDown", alt: true, bindings: bindings) == nil)
    #expect(press("e", ctrl: true, shift: true, bindings: bindings) == nil)
    #expect(bindings.chords("toggle-sidebar").isEmpty)
    #expect(bindings.hint("switcher", mac: false)?.meta == false)
    #expect(bindings.hint("switcher", mac: true)?.meta == true)
    // Choosing a default clears the override, so both defaults come back.
    #expect(bindings.set("cycle-next", Chord("ArrowDown", alt: true)) == nil)
    #expect(!bindings.isOverridden("cycle-next"))
    #expect(bindings.bindingError("new-session", Chord("n")) != nil)
    #expect(bindings.bindingError("new-session", Chord("k", ctrl: true, shift: true))?.contains("Search or jump") == true)
    #expect(bindings.bindingError("switcher", Chord("k", meta: true)) == nil)
}

@Test func storedBindingsDropUnknownIdsAndBareKeys() {
    let blob = Data(#"{"switcher":[{"key":"p","ctrl":true}],"nope":[{"key":"a","ctrl":true}],"new-session":[{"key":"x"}],"go-inbox":null}"#.utf8)
    let parsed = KeyBindings(json: blob)
    #expect(parsed.chords("switcher") == [Chord("p", ctrl: true)])
    #expect(parsed.chords("new-session").isEmpty)
    #expect(parsed.chords("go-inbox").isEmpty)
    #expect(parsed.isOverridden("go-inbox"))
    let roundTrip = KeyBindings(json: parsed.json())
    #expect(roundTrip == parsed)
}

@Test func paneFocusWaitsForTheCaretToReachAnEdge() {
    let mid = FieldState(text: "hello", selection: 3..<3)
    let start = FieldState(text: "hello", selection: 0..<0)
    let end = FieldState(text: "hello", selection: 5..<5)
    let selecting = FieldState(text: "hello", selection: 2..<5)
    let empty = FieldState(text: "", selection: 0..<0)
    #expect(press("ArrowLeft", ctrl: true, shift: true, scope: .field, field: mid) == nil)
    #expect(press("ArrowLeft", ctrl: true, shift: true, scope: .field, field: start) == "focus-pane-left")
    #expect(press("ArrowUp", ctrl: true, shift: true, scope: .field, field: start) == "focus-pane-up")
    #expect(press("ArrowRight", ctrl: true, shift: true, scope: .field, field: start) == nil)
    #expect(press("ArrowRight", ctrl: true, shift: true, scope: .field, field: end) == "focus-pane-right")
    #expect(press("ArrowRight", ctrl: true, shift: true, scope: .field, field: selecting) == nil, "a selection still grows")
    #expect(press("ArrowRight", ctrl: true, shift: true, scope: .field, field: empty) == "focus-pane-right")
    #expect(press("Backspace", ctrl: true, shift: true, scope: .field, field: start) == nil)
    #expect(press("Backspace", ctrl: true, shift: true, scope: .field, field: empty) == "close-pane")
    #expect(press("ArrowLeft", ctrl: true, alt: true, scope: .field) == "move-pane-left")
    #expect(press("ArrowUp", ctrl: true, alt: true, shift: true, scope: .field) == "resize-up")
    #expect(press("k", ctrl: true, alt: true, scope: .terminal) == "toggle-keys")
    #expect(press("s", ctrl: true, alt: true, scope: .field) == "send-now")
    #expect(press("4", ctrl: true, alt: true, scope: .field) == "panel-queue")
}

@Test func whenLabelsAndChordGlyphs() {
    #expect(CommandCatalog.whenLabel("switcher") == "Anywhere except a confirm")
    #expect(CommandCatalog.whenLabel("cycle-next") == "Not in a dialog")
    #expect(CommandCatalog.whenLabel("focus-pane-left") == "Not in a dialog; while typing, only from the start of the text")
    #expect(CommandCatalog.whenLabel("close-pane") == "Not in a dialog; while typing, only in an empty box")
    #expect(Chord("k", meta: true).formatted(mac: true) == "⌘K")
    #expect(Chord("k", ctrl: true, shift: true).formatted(mac: false) == "Ctrl+Shift+K")
    #expect(Chord("ArrowUp", alt: true).formatted(mac: false) == "Alt+↑")
    #expect(Chord("Enter", ctrl: true, alt: true).formatted(mac: true) == "⌃⌥Enter")
    #expect(Chord("k", ctrl: true, shift: true).parts(mac: true) == ["⌃", "⇧", "K"])
    #expect(Chord("p", meta: true, shift: true).parts(mac: true) == ["⇧", "⌘", "P"])
    #expect(Chord("Enter", ctrl: true, alt: true).parts(mac: false) == ["Ctrl", "Alt", "↵"])
    #expect(CommandCatalog.command("terminate")?.chords.isEmpty == true)
    #expect(CommandCatalog.command("exit-split")?.chords.isEmpty == true)
}

@Test func paletteSearchRanksNamesAboveRelatedWords() {
    let active: Set<CommandID> = ["go-inbox", "toggle-panel"]
    let open = CommandMatcher.search("", active: { active.contains($0) }).map(\.id)
    #expect(open == ["go-inbox", "toggle-panel"])
    #expect(CommandMatcher.search("inbox", active: { _ in true }).first?.id == "go-inbox")
    #expect(CommandMatcher.search("panel", active: { _ in true }, mac: false).first?.id == "toggle-panel")
    #expect(CommandMatcher.search("ctrl+shift+j", active: { _ in true }, mac: false).first?.id == "toggle-panel")
    #expect(!CommandMatcher.search("", active: { _ in true }).contains { $0.id == "command-palette" })
    let pane = CommandMatcher.search("pane", active: { _ in true }).map(\.id)
    #expect(pane.firstIndex(of: "focus-pane-left")! < pane.firstIndex(of: "split-right")!)
    #expect(CommandMatcher.search("no-such-command", active: { _ in true }).isEmpty)
}

@Test func whichKeyListsOnlyWhatAnswersTheHeldModifiers() {
    let mounted: Set<CommandID> = ["reply", "split-right"]
    let rows = CommandMatcher.whichKey(ctrl: true, alt: true, shift: false, meta: false, active: { mounted.contains($0) }, mac: false)
    #expect(rows.contains { $0.id == "reply" && $0.key == "R" })
    #expect(!rows.contains { $0.id == "split-right" })
    #expect(CommandMatcher.whichKey(ctrl: true, alt: false, shift: true, meta: false, active: { mounted.contains($0) }, mac: false).contains { $0.id == "split-right" })
}

@Test func terminalKeyBytesMatchTheWebKeyBar() {
    for (input, expected) in [("a", "A"), ("1", "!"), ("/", "?"), ("-", "_"), ("\\", "|"), ("\t", "\u{1b}[Z"), ("\r", "\n")] {
        #expect(TerminalKeys.applyModifiers(input, ctrl: false, alt: false, shift: true) == expected)
    }
    #expect(TerminalKeys.applyModifiers("already pasted text", ctrl: false, alt: false, shift: true) == "already pasted text")
    #expect(TerminalKeys.applyModifiers("\u{1b}[A", ctrl: false, alt: false, shift: true) == "\u{1b}[1;2A")
    #expect(TerminalKeys.applyModifiers("\u{1b}OD", ctrl: true, alt: true, shift: true) == "\u{1b}[1;8D")
    #expect(TerminalKeys.applyModifiers("\u{1b}[1;2C", ctrl: true, alt: false) == "\u{1b}[1;6C")
    #expect(TerminalKeys.applyModifiers("c", ctrl: true, alt: false) == "\u{03}")
    #expect(TerminalKeys.applyModifiers("c", ctrl: true, alt: true, shift: true) == "\u{1b}\u{03}")
    #expect(TerminalKeys.applyModifiers(" ", ctrl: true, alt: false) == "\u{0}")
    #expect(TerminalKeys.applyModifiers("-", ctrl: true, alt: false, shift: true) == "\u{1f}")
    #expect(TerminalKeys.applyModifiers("\u{1b}[D", ctrl: false, alt: true) == "\u{1b}b")
    #expect(TerminalKeys.applyModifiers("\u{1b}OD", ctrl: false, alt: true) == "\u{1b}b")
    #expect(TerminalKeys.applyModifiers("\u{1b}[A", ctrl: false, alt: true) == "\u{1b}[1;3A")
    #expect(TerminalKeys.applyModifiers("\u{1b}[D", ctrl: true, alt: true) == "\u{1b}[1;7D")
    #expect(TerminalKeys.arrow("ArrowLeft", meta: true, alt: false, ctrl: false, shift: false) == "\u{1b}[H")
    #expect(TerminalKeys.arrow("ArrowRight", meta: false, alt: true, ctrl: false, shift: false) == "\u{1b}f")
    #expect(TerminalKeys.arrow("ArrowUp", meta: false, alt: true, ctrl: false, shift: false) == nil, "Option+Up cycles sessions")
    #expect(TerminalKeys.arrow("ArrowLeft", meta: false, alt: true, ctrl: false, shift: true) == nil)
    #expect(TerminalKeys.paste("a\nb", bracketed: true) == "\u{1b}[200~a\rb\u{1b}[201~")
    #expect(cycleKey([String](), anchor: "a", direction: 1) == nil)
    #expect(cycleKey(["a", "b", "c"], anchor: "c", direction: 1) == "a")
    #expect(cycleKey(["a", "b", "c"], anchor: "a", direction: -1) == "c")
    #expect(cycleKey(["a", "b"], anchor: "gone", direction: -1) == "b")
}

@Test func thePaletteTreeDropsWhatCannotRunAndPlacesLiveBranches() {
    let tree = PaletteTree.resolve(active: { $0 == "go-inbox" || $0 == "panel-diff" }, provide: { _ in [] })
    #expect(tree.children?.map(\.key) == ["go", "session"])
    let session = tree.children!.first { $0.key == "session" }!
    #expect(session.children?.map(\.key) == ["panels"])
    #expect(session.children?.first?.children?.map(\.action) == [.command("panel-diff")])

    let live = PaletteTree.resolve(active: { _ in true }, provide: { $0 == .queue ? [PaletteNode(key: "queued:a", label: "fix the tests", children: [PaletteNode(key: "send", label: "Send now", action: .sendQueuedNow(uid: "u", item: "a"))])] : [] })
    let turn = live.children!.first { $0.key == "session" }!.children!.first { $0.key == "turn" }!
    #expect(turn.children?.map(\.key) == ["interrupt", "send-now", "queued:a", "clear-queue"])

    let full = PaletteTree.resolve(active: { _ in true }, provide: { _ in [] })
    let first = PaletteTree.search(full, "panels").first
    #expect(first?.node.key == "panels")
    #expect(first?.trail.map(\.key) == ["session"])
    let diff = PaletteTree.search(full, "panels diff").first
    #expect(diff?.node.action == .command("panel-diff"))
    let workspace = full.children!.first { $0.key == "workspace" }!
    #expect(PaletteTree.search(workspace, "diff").allSatisfy { !($0.node.key.hasPrefix("panel")) })
    #expect(PaletteTree.search(full, "   ").isEmpty)
    #expect(workspace.children!.first { $0.key == "move" }!.leafCount == 4)
    let pane = PaletteTree.search(full, "pane")
    let firstRelated = pane.firstIndex { $0.related } ?? pane.count
    #expect(firstRelated > 0)
    #expect(pane[..<firstRelated].allSatisfy { !$0.related } && pane[firstRelated...].allSatisfy { $0.related })
}

@Test func everyCommandHasAPlaceInThePaletteTree() {
    var placed = Set<CommandID>()
    func walk(_ spec: PaletteTree.Spec) {
        switch spec {
        case .command(let id): placed.insert(id)
        case .provider: break
        case .category(_, _, _, _, _, let children): children.forEach(walk)
        }
    }
    walk(PaletteTree.root)
    #expect(CommandCatalog.all.map(\.id).filter { $0 != "command-palette" && !placed.contains($0) } == [])
}
