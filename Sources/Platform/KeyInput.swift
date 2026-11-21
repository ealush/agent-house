import UIKit
import CoreTransferable
import UniformTypeIdentifiers

extension KeyPress {
    /// A hardware key as UIKit reports it: the physical key's HID usage, what the layout
    /// produces without modifiers, and the modifiers held.
    init(_ key: UIKey) {
        var modifiers: KeyPress.Modifiers = []
        if key.modifierFlags.contains(.command) { modifiers.insert(.command) }
        if key.modifierFlags.contains(.control) { modifiers.insert(.control) }
        if key.modifierFlags.contains(.alternate) { modifiers.insert(.option) }
        if key.modifierFlags.contains(.shift) { modifiers.insert(.shift) }
        self.init(hidUsage: key.keyCode.rawValue, characters: key.charactersIgnoringModifiers, modifiers: modifiers)
    }

    var isModifierOnly: Bool { KeyPress.modifierUsages.contains(hidUsage) }
}

extension Chord {
    /// The UIKeyCommand input for this chord's key.
    var keyCommandInput: String {
        switch key {
        case "ArrowUp": return UIKeyCommand.inputUpArrow
        case "ArrowDown": return UIKeyCommand.inputDownArrow
        case "ArrowLeft": return UIKeyCommand.inputLeftArrow
        case "ArrowRight": return UIKeyCommand.inputRightArrow
        case "Escape": return UIKeyCommand.inputEscape
        case "End": return UIKeyCommand.inputEnd
        case "Home": return UIKeyCommand.inputHome
        case "PageUp": return UIKeyCommand.inputPageUp
        case "PageDown": return UIKeyCommand.inputPageDown
        case "Enter": return "\r"
        case "Backspace": return "\u{8}"
        case "Tab": return "\t"
        default: return key
        }
    }

    var modifierFlags: UIKeyModifierFlags {
        var flags: UIKeyModifierFlags = []
        if meta { flags.insert(.command) }
        if ctrl { flags.insert(.control) }
        if alt { flags.insert(.alternate) }
        if shift { flags.insert(.shift) }
        return flags
    }
}

/// The app's commands in the iPad menu bar and the ⌘-hold shortcut overlay, grouped as the
/// catalog groups them, with this device's bindings. Chords that also edit text (pane focus
/// at the caret's edge, close pane in an empty box) get no menu shortcut: the responders
/// that own a text field apply them only at the edge, so the menu never steals them.
enum MenuCommands {
    static let action = #selector(SceneRootController.runKeyCommand(_:))
    static let chordAction = #selector(SceneRootController.startChord(_:))

    /// How each menu reads: sections of related commands, the families of four directions
    /// folded into submenus. A command the layout doesn't name lands in a last section, so a
    /// new one is never missing from the menu bar.
    enum Part {
        case section([CommandID])
        case submenu(String, String, [CommandID])
    }

    static let layout: [(CommandGroup, String, [Part])] = [
        (.navigate, "Go", [
            .section(["switcher", "go-to-session", "cycle-prev", "cycle-next"]),
            .section(["go-inbox", "go-review", "go-search", "go-jobs", "go-usage", "worktrees"]),
            .section(["new-session", "new-project", "new-note"]),
            .section(["toggle-sidebar", "focus-sidebar", "focus-main"]),
            .section(["copy-link", "share-link", "open-link", "reload-page"]),
            .section(["show-shortcuts"]),
        ]),
        (.session, "Session", [
            .section(["reply", "approve", "deny", "interrupt"]),
            .section(["send-now", "clear-queue", "pick-model", "pick-effort"]),
            .section(["rename", "pin", "switch-branch", "fork", "send-to"]),
            .section(["toggle-view", "toggle-steps", "jump-latest", "browse-messages", "copy-last"]),
            .submenu("Side Panel", "sidebar.right", ["toggle-panel", "panel-diff", "panel-files", "panel-chat", "panel-queue", "panel-snapshots", "panel-preview", "panel-stack"]),
            .submenu("Terminal", "terminal", ["toggle-keys", "terminal-text-bigger", "terminal-text-smaller", "terminal-text-reset", "scrollback", "copy-attach"]),
            .section(["session-menu", "terminate"]),
            .submenu("Note", "note.text", ["note-preview", "note-send", "note-insert", "note-new-session", "note-new-session-file", "note-save-file", "note-project", "note-duplicate", "note-delete"]),
        ]),
        (.workspace, "Workspace", [
            .section(["split-right", "split-below", "split-left", "split-above", "toggle-split", "exit-split"]),
            .section(["open-in-pane", "replace-pane", "maximize-pane", "close-pane", "scratchpad"]),
            .submenu("Focus Pane", "arrow.up.and.down.and.arrow.left.and.right", ["focus-pane-left", "focus-pane-right", "focus-pane-up", "focus-pane-down", "focus-pane-next", "focus-pane-prev"]),
            .submenu("Move Pane", "arrow.left.circle", ["move-pane-left", "move-pane-right", "move-pane-up", "move-pane-down"]),
            .submenu("Swap Pane", "arrow.left.arrow.right", ["swap-pane-left", "swap-pane-right", "swap-pane-up", "swap-pane-down"]),
            .submenu("Resize", "arrow.left.and.right", ["resize-left", "resize-right", "resize-up", "resize-down", "balance-panes", "resize-mode"]),
            .section(["pane-mode"]),
            .section(["new-window", "open-in-new-window"]),
            .section(["focus-follows-pointer"]),
        ]),
    ]

    /// Every command the layout names, per menu, in order.
    static var placed: [(CommandGroup, [CommandID])] {
        layout.map { group, _, parts in
            (group, parts.flatMap { part -> [CommandID] in
                switch part {
                case .section(let ids), .submenu(_, _, let ids): return ids
                }
            })
        }
    }

    static func menus(bindings: KeyBindings) -> [UIMenu] {
        layout.map { group, title, parts in
            // The palette and Settings have their own items in the app menu.
            let commands = CommandCatalog.all.filter { $0.group == group && $0.id != "command-palette" && $0.id != "go-settings" }
            let byID = Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })
            var placed: Set<CommandID> = []
            func items(_ ids: [CommandID]) -> [UIMenuElement] {
                ids.compactMap { id in byID[id].map { placed.insert(id); return element(for: $0, bindings: bindings) } }
            }
            var children: [UIMenuElement] = parts.compactMap { part in
                switch part {
                case .section(let ids):
                    let elements = items(ids)
                    return elements.isEmpty ? nil : UIMenu(title: "", options: .displayInline, children: elements)
                case .submenu(let name, let symbol, let ids):
                    let elements = items(ids)
                    return elements.isEmpty ? nil : UIMenu(title: name, image: UIImage(systemName: symbol), children: elements)
                }
            }
            let rest = commands.filter { !placed.contains($0.id) }.map { element(for: $0, bindings: bindings) }
            if !rest.isEmpty { children.append(UIMenu(title: "", options: .displayInline, children: rest)) }
            return UIMenu(title: title, identifier: UIMenu.Identifier("dev.ealush.ah.native.\(title.lowercased())"), options: [], children: children)
        }
    }

    private static func element(for command: Command, bindings: KeyBindings) -> UIMenuElement {
        let image = UIImage(systemName: CommandCatalog.icon(command.id))
        // A two-key chord can't be a menu key equivalent; the menu shows it in the title's
        // discoverability text and `chordStarts` catches its first key.
        let singles = bindings.chords(command.id).filter { !$0.isSequence }
        // The ⌘ chord where there is one, as the menu bar and the ⌘-hold overlay expect.
        let chord = singles.first { $0.meta } ?? singles.first
        if let chord, command.field == nil {
            let element = UIKeyCommand(title: command.title, image: image, action: action, input: chord.keyCommandInput, modifierFlags: chord.modifierFlags, propertyList: command.id.rawValue, alternates: [], discoverabilityTitle: command.detail, attributes: [], state: .off)
            element.wantsPriorityOverSystemBehavior = command.scopes.contains(.field)
            return element
        }
        return UICommand(title: command.title, image: image, action: action, propertyList: command.id.rawValue, alternates: [], discoverabilityTitle: command.detail, attributes: [], state: .off)
    }

    /// Hidden key commands for the first key of every two-key chord, so a chord starts
    /// wherever the keyboard is (the second key arrives through `runKeyCommand` or a
    /// responder's `pressesBegan`).
    static func chordStarts(bindings: KeyBindings) -> UIMenu {
        var leads: [Chord] = []
        for command in CommandCatalog.all {
            for chord in bindings.chords(command.id) where chord.isSequence && !leads.contains(chord.lead) { leads.append(chord.lead) }
        }
        let elements: [UIMenuElement] = leads.map { lead in
            let element = UIKeyCommand(title: lead.formatted(), image: nil, action: chordAction, input: lead.keyCommandInput, modifierFlags: lead.modifierFlags, propertyList: "chord", alternates: [], discoverabilityTitle: nil, attributes: .hidden, state: .off)
            element.wantsPriorityOverSystemBehavior = true
            return element
        }
        return UIMenu(title: "", identifier: UIMenu.Identifier("dev.ealush.ah.native.chords"), options: .displayInline, children: elements)
    }

    /// New Window on ⌥⌘N: ⌘N makes a session, as ⌘N makes the main thing in Mail or Notes.
    static func newWindow() -> UIMenu {
        let element = UIKeyCommand(title: "New Window", image: UIImage(systemName: "macwindow.badge.plus"), action: #selector(AppDelegate.newWindow(_:)), input: "n", modifierFlags: [.command, .alternate], propertyList: nil, alternates: [], discoverabilityTitle: "Open another window", attributes: [], state: .off)
        return UIMenu(title: "", identifier: UIMenu.Identifier("dev.ealush.ah.native.new-window"), options: .displayInline, children: [element])
    }

    /// Settings… on ⌘, as every app has it, whatever else Settings is bound to.
    static func settings() -> UIMenu {
        let element = UIKeyCommand(title: "Settings…", image: UIImage(systemName: "gearshape"), action: action, input: ",", modifierFlags: .command, propertyList: "go-settings", alternates: [], discoverabilityTitle: "Open settings", attributes: [], state: .off)
        element.wantsPriorityOverSystemBehavior = true
        return UIMenu(title: "", identifier: UIMenu.Identifier("dev.ealush.ah.native.settings"), options: .displayInline, children: [element])
    }

    /// The palette's own chord, at the top of the app menu.
    static func palette(bindings: KeyBindings) -> UIMenu {
        let chord = bindings.hint("command-palette") ?? Chord("p", meta: true, shift: true)
        let element = UIKeyCommand(title: "Command Palette…", image: UIImage(systemName: "command"), action: action, input: chord.keyCommandInput, modifierFlags: chord.modifierFlags, propertyList: "command-palette", alternates: [], discoverabilityTitle: "Search the actions you can run right now", attributes: [], state: .off)
        element.wantsPriorityOverSystemBehavior = true
        return UIMenu(title: "", identifier: UIMenu.Identifier("dev.ealush.ah.native.palette"), options: .displayInline, children: [element])
    }
}

/// Short, native feedback for holds, thresholds and outcomes.
@MainActor
enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func threshold() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func failure() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    static func selection() { UISelectionFeedbackGenerator().selectionChanged() }
}

/// A session (by key) or a pane (`pane:…`) on the move between the sidebar and panes. Its
/// own content type, so a pane reacts to sessions and panes only, never to a file path or
/// a queued message dragged past it (those travel as plain text).
struct SessionDrag: Codable, Transferable {
    let key: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .agentHubSession)
    }
}

/// A sidebar block (project or host) on the move to a new place in the list.
struct GroupDrag: Codable, Transferable {
    let id: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .agentHubGroup)
    }
}

extension UTType {
    /// Declared in Info.plist (UTExportedTypeDeclarations).
    static let agentHubSession = UTType(exportedAs: "dev.ealush.ah.native.session")
    static let agentHubGroup = UTType(exportedAs: "dev.ealush.ah.native.group")
}

extension UIResponder {
    nonisolated(unsafe) private static weak var found: UIResponder?

    /// Whatever has the keyboard in the app right now.
    @MainActor static var current: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.recordFirstResponder), to: nil, from: nil, for: nil)
        return found
    }

    @objc private func recordFirstResponder() { UIResponder.found = self }
}
