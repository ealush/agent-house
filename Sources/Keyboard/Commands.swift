import Foundation

// The keyboard command catalog (`../ah/web/shortcuts.ts`): 71 literal commands plus
// workspace 1–9 and send-to-workspace 1–9 = 89. Defaults live here; a device may
// override them (Settings → Shortcuts). A chord needs Ctrl, Option or Command, so a plain
// letter always reaches the agent. Letters match the character the layout produces
// (Colemak included); digits and punctuation match the physical key, so Shift doesn't turn
// "1" into "!" or "\" into "|".

/// Where a chord may take the key: the app, the terminal, a text field, a dialog.
/// An `ask` (an agent's question form) owns the keyboard entirely.
enum KeyScope: String, Sendable, Codable, CaseIterable {
    case app, terminal, field, dialog, ask
}

struct Chord: Hashable, Codable, Sendable {
    /// The web's key names: a lowercase letter, a digit, punctuation, or "ArrowUp", "Enter",
    /// "Backspace", "End", " " (space)…
    let key: String
    var meta = false
    var ctrl = false
    var alt = false
    var shift = false

    init(_ key: String, meta: Bool = false, ctrl: Bool = false, alt: Bool = false, shift: Bool = false) {
        self.key = key
        self.meta = meta
        self.ctrl = ctrl
        self.alt = alt
        self.shift = shift
    }

    private enum CodingKeys: String, CodingKey { case key, meta, ctrl, alt, shift }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        meta = (try? c.decode(Bool.self, forKey: .meta)) ?? false
        ctrl = (try? c.decode(Bool.self, forKey: .ctrl)) ?? false
        alt = (try? c.decode(Bool.self, forKey: .alt)) ?? false
        shift = (try? c.decode(Bool.self, forKey: .shift)) ?? false
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        if meta { try c.encode(true, forKey: .meta) }
        if ctrl { try c.encode(true, forKey: .ctrl) }
        if alt { try c.encode(true, forKey: .alt) }
        if shift { try c.encode(true, forKey: .shift) }
    }

    /// Needs Ctrl, Option or Command: a bare key is text.
    var isUsable: Bool { meta || ctrl || alt }

    private static let keyLabel: [String: String] = ["ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→", "Enter": "Enter", "Backspace": "⌫", "Escape": "Esc", " ": "Space"]
    private static let partLabel: [String: String] = keyLabel.merging(["Enter": "↵", "Backspace": "Backspace", "Tab": "Tab"]) { $1 }

    /// "⌃⌥Enter" on Apple keyboards, "Ctrl+Alt+Enter" elsewhere.
    func formatted(mac: Bool = true) -> String {
        let name = Self.keyLabel[key] ?? (key.count == 1 ? key.uppercased() : key)
        if mac { return "\(ctrl ? "⌃" : "")\(alt ? "⌥" : "")\(shift ? "⇧" : "")\(meta ? "⌘" : "")\(name)" }
        var parts: [String] = []
        if ctrl { parts.append("Ctrl") }
        if alt { parts.append("Alt") }
        if shift { parts.append("Shift") }
        if meta { parts.append("Super") }
        parts.append(name)
        return parts.joined(separator: "+")
    }

    /// One label per key, Ctrl, Shift, Option, Command, then the key: for keycaps.
    func parts(mac: Bool = true) -> [String] {
        var out: [String] = []
        if ctrl { out.append(mac ? "⌃" : "Ctrl") }
        if shift { out.append(mac ? "⇧" : "Shift") }
        if alt { out.append(mac ? "⌥" : "Alt") }
        if meta { out.append(mac ? "⌘" : "Super") }
        out.append(Self.partLabel[key] ?? (key.count == 1 ? key.uppercased() : key))
        return out
    }
}

enum FieldEdge: String, Sendable, Codable { case start, end, empty }

/// Where the caret sits in the focused text box, for chords that also edit text there.
struct FieldState: Equatable, Sendable {
    var start = false
    var end = false
    var empty = false

    init(start: Bool = false, end: Bool = false, empty: Bool = false) {
        self.start = start
        self.end = end
        self.empty = empty
    }

    /// From a text and its selection (UTF-16 offsets, as UIKit reports them).
    init(text: String, selection: Range<Int>?) {
        empty = text.isEmpty
        guard let selection else {
            start = empty
            end = empty
            return
        }
        let collapsed = selection.isEmpty
        start = collapsed && selection.lowerBound == 0
        end = collapsed && selection.upperBound == text.utf16.count
    }

    func allows(_ edge: FieldEdge) -> Bool {
        switch edge {
        case .start: return start
        case .end: return end
        case .empty: return empty
        }
    }
}

enum CommandGroup: String, Sendable, Codable { case navigate = "Navigate", session = "Session", workspace = "Workspace" }

struct Command: Sendable, Identifiable, Equatable {
    let id: CommandID
    let group: CommandGroup
    let label: String
    let detail: String
    let chords: [Chord]
    /// Where the chord may take the key; `ask` never appears (those forms own the keyboard).
    let scopes: Set<KeyScope>
    /// In a text box the chord also edits text, so it fires only at this edge.
    let field: FieldEdge?
    /// Related words that find it under name matches.
    let terms: [String]

    init(_ id: CommandID, _ group: CommandGroup, _ label: String, _ detail: String, chords: [Chord] = [], scopes: Set<KeyScope> = [.app, .terminal, .field], field: FieldEdge? = nil, terms: [String] = []) {
        self.id = id
        self.group = group
        self.label = label
        self.detail = detail
        self.chords = chords
        self.scopes = scopes
        self.field = field
        self.terms = terms
    }
}

struct CommandID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    init(stringLiteral value: String) { rawValue = value }
    var description: String { rawValue }

    static func workspace(_ n: Int) -> CommandID { CommandID(rawValue: "workspace-\(n)") }
    static func toWorkspace(_ n: Int) -> CommandID { CommandID(rawValue: "to-workspace-\(n)") }

    /// 1…9 for `workspace-N`.
    var workspaceNumber: Int? {
        rawValue.hasPrefix("workspace-") ? Int(rawValue.dropFirst("workspace-".count)) : nil
    }

    /// 1…9 for `to-workspace-N`.
    var sendToWorkspaceNumber: Int? {
        rawValue.hasPrefix("to-workspace-") ? Int(rawValue.dropFirst("to-workspace-".count)) : nil
    }
}

enum CommandCatalog {
    private static func c(_ key: String, meta: Bool = false, ctrl: Bool = false, alt: Bool = false, shift: Bool = false) -> Chord {
        Chord(key, meta: meta, ctrl: ctrl, alt: alt, shift: shift)
    }

    private static let everywhere: Set<KeyScope> = [.app, .terminal, .field]

    static let all: [Command] = {
        var list: [Command] = [
            Command("command-palette", .navigate, "Command palette", "Search the actions you can run right now. The binding sits on the right of each one.", chords: [c("p", meta: true, shift: true), c("p", ctrl: true, shift: true)]),
            Command("switcher", .navigate, "Search or jump", "Open the switcher. Also works while a text field or another dialog is open.", chords: [c("k", meta: true), c("k", ctrl: true, shift: true)], scopes: [.app, .terminal, .field, .dialog]),
            Command("cycle-prev", .navigate, "Previous session", "The previous session in sidebar order. From the inbox, this opens the last one. Also works while a text field is focused.", chords: [c("ArrowUp", alt: true)]),
            Command("cycle-next", .navigate, "Next session", "The next session in sidebar order. From the inbox, this opens the first one. Also works while a text field is focused.", chords: [c("ArrowDown", alt: true)]),
            Command("new-session", .navigate, "New session", "Open the new-session dialog.", chords: [c("Enter", ctrl: true, shift: true)]),
            Command("new-project", .navigate, "New project", "Create a folder and start a session in it."),
            Command("toggle-sidebar", .navigate, "Toggle sidebar", "Show or hide the sidebar.", chords: [c("e", ctrl: true, shift: true)]),
            Command("go-inbox", .navigate, "Inbox", "Leave the session or split and show the inbox.", chords: [c("1", ctrl: true, shift: true)]),
            Command("go-history", .navigate, "History", "Open the history page.", chords: [c("2", ctrl: true, shift: true)]),
            Command("go-review", .navigate, "Review", "Open Review: your pull request stacks, one layer at a time.", chords: [c("4", ctrl: true, shift: true)]),
            Command("go-search", .navigate, "Search", "Search every conversation and side chat, on every host.", chords: [c("5", ctrl: true, shift: true)], terms: ["find", "full text", "transcripts"]),
            Command("worktrees", .navigate, "Worktrees", "Managed worktrees: dirty, ahead, orphaned, and their size; clean up.", terms: ["branches", "checkouts", "clean"]),
            Command("go-settings", .navigate, "Settings", "Open settings.", chords: [c("3", ctrl: true, shift: true)]),
            Command("focus-sidebar", .navigate, "Focus the session list", "Move focus to the current session in the sidebar. On a phone, open the Sessions tab. Arrows move, Enter opens.", chords: [c("0", ctrl: true, shift: true)]),
            Command("focus-main", .navigate, "Focus the session", "Back to the open session: its composer in the GUI, the terminal otherwise.", chords: [c("9", ctrl: true, shift: true)]),
            Command("reload-page", .navigate, "Reload", "Reconnect to your hosts and refresh everything shown. Sessions keep running."),
            Command("show-shortcuts", .navigate, "Keyboard shortcuts", "Open the shortcut table.", chords: [c("/", ctrl: true, shift: true)]),
            Command("toggle-view", .session, "GUI or terminal", "Switch the focused session between the terminal and the transcript GUI.", chords: [c("g", ctrl: true, shift: true)]),
            Command("toggle-steps", .session, "Hide / show steps", "In the GUI, fold tool calls and thinking to one line per run, so the conversation reads as prose. Applies to every session on this device.", chords: [c("h", ctrl: true, alt: true)], terms: ["tool calls", "collapse", "thinking"]),
            Command("toggle-panel", .session, "Toggle side panel", "Show or hide the session side panel.", chords: [c("j", ctrl: true, shift: true)]),
            Command("reply", .session, "Reply", "Focus the composer, or the terminal when that is the current view.", chords: [c("r", ctrl: true, alt: true)]),
            Command("approve", .session, "Approve", "Approve the prompt on the focused session, when it is waiting for one.", chords: [c("Enter", ctrl: true, alt: true)]),
            Command("deny", .session, "Deny", "Deny the prompt on the focused session, when it is waiting for one.", chords: [c("Backspace", ctrl: true, alt: true)]),
            Command("interrupt", .session, "Stop the turn", "Interrupt what the agent is doing right now (Esc in its terminal). In the GUI, Esc in an empty composer does the same.", chords: [c("x", ctrl: true, alt: true)]),
            Command("send-now", .session, "Send next queued now", "Stop the current turn and deliver the oldest queued follow-up right away.", chords: [c("s", ctrl: true, alt: true)]),
            Command("clear-queue", .session, "Cancel all queued", "Drop every follow-up waiting for this session."),
            Command("pick-model", .session, "Switch model", "Open the model picker for this session.", chords: [c("m", ctrl: true, alt: true)]),
            Command("pick-effort", .session, "Switch reasoning effort", "Open the effort picker for this session.", chords: [c("e", ctrl: true, alt: true)]),
            Command("copy-last", .session, "Copy the agent's last reply", "Copy the newest agent message as text (GUI view).", chords: [c("c", ctrl: true, alt: true)]),
            Command("jump-latest", .session, "Jump to latest", "Scroll the conversation to its newest message.", chords: [c("End", ctrl: true, alt: true)]),
            Command("browse-messages", .session, "Browse messages", "Put the keyboard on the newest message (GUI): ↑↓ or j/k move, c copies, r restores the files to before it, Esc returns to the composer.", chords: [c("b", ctrl: true, alt: true)]),
            Command("switch-branch", .session, "Switch branch…", "Switch the session's checkout to another branch, or create one.", terms: ["git", "checkout"]),
            Command("rename", .session, "Rename session", "Edit the session name in place. Return saves, Escape cancels.", chords: [c("n", ctrl: true, alt: true)]),
            Command("fork", .session, "Fork session…", "Copy this conversation into a new session on its own worktree.", chords: [c("f", ctrl: true, alt: true)]),
            Command("send-to", .session, "Send to…", "Hand a summary and the last reply to another session or a new one.", chords: [c("t", ctrl: true, alt: true)]),
            Command("pin", .session, "Pin", "Keep the session at the top of its group, on every device; again to unpin."),
            Command("panel-diff", .session, "Diff", "Show the git changes beside the session. Again to close.", chords: [c("1", ctrl: true, alt: true)], terms: ["panel"]),
            Command("panel-files", .session, "Files", "Browse files beside the session. Again to close.", chords: [c("2", ctrl: true, alt: true)], terms: ["panel"]),
            Command("panel-chat", .session, "Chat", "Discuss this work with another model. Again to close.", chords: [c("3", ctrl: true, alt: true)], terms: ["panel"]),
            Command("panel-queue", .session, "Queue", "Review, send or cancel queued follow-ups. Again to close.", chords: [c("4", ctrl: true, alt: true)], terms: ["panel"]),
            Command("panel-snapshots", .session, "Snapshots", "Per-turn snapshots and restore. Again to close.", chords: [c("5", ctrl: true, alt: true)], terms: ["panel"]),
            Command("panel-preview", .session, "Preview", "A dev server running in this session (Storybook, Vite…), in a browser pane served from the host. Again to close.", chords: [c("6", ctrl: true, alt: true)], terms: ["browser", "storybook", "panel"]),
            Command("panel-stack", .session, "Stack", "The stack this session is building: its branches bottom to top, each with its pull request, and Review. Again to close.", chords: [c("7", ctrl: true, alt: true)], terms: ["review", "pull requests", "gh stack"]),
            Command("session-menu", .session, "Session menu", "Open the session menu; arrows move, Return runs, Escape closes.", chords: [c(".", ctrl: true, alt: true)]),
            Command("scrollback", .session, "Scrollback as text", "The terminal's scrollback as selectable, copyable text."),
            Command("copy-attach", .session, "Copy attach command", "Copy “ah attach <id>” to open this session from a terminal."),
            Command("toggle-keys", .session, "Show or hide on-screen keys", "The Esc / Tab / arrows / Ctrl key bar under the terminal.", chords: [c("k", ctrl: true, alt: true)]),
            Command("terminate", .session, "Terminate session", "Stop the focused session. Asks for confirmation first."),
            Command("split-right", .workspace, "Split right", "Open another session to the right of the focused one.", chords: [c("\\", ctrl: true, shift: true)], terms: ["pane"]),
            Command("split-below", .workspace, "Split below", "Open another session below the focused one.", chords: [c("-", ctrl: true, shift: true)], terms: ["pane"]),
            Command("close-pane", .workspace, "Close pane", "Close the focused pane, or the current tab on a narrow screen, without stopping the session.", chords: [c("Backspace", ctrl: true, shift: true)], field: .empty),
            Command("focus-pane-left", .workspace, "Pane left", "Move to the pane on the left. On a narrow screen this switches tabs.", chords: [c("ArrowLeft", ctrl: true, shift: true)], field: .start),
            Command("focus-pane-right", .workspace, "Pane right", "Move to the pane on the right. On a narrow screen this switches tabs.", chords: [c("ArrowRight", ctrl: true, shift: true)], field: .end),
            Command("focus-pane-up", .workspace, "Pane up", "Move to the pane above. On a narrow screen this switches tabs.", chords: [c("ArrowUp", ctrl: true, shift: true)], field: .start),
            Command("focus-pane-down", .workspace, "Pane down", "Move to the pane below. On a narrow screen this switches tabs.", chords: [c("ArrowDown", ctrl: true, shift: true)], field: .end),
            Command("move-pane-left", .workspace, "Move pane left", "Move the focused pane left. At the edge of its split, it spans the column beyond.", chords: [c("ArrowLeft", ctrl: true, alt: true)]),
            Command("move-pane-right", .workspace, "Move pane right", "Move the focused pane right. At the edge of its split, it spans the column beyond.", chords: [c("ArrowRight", ctrl: true, alt: true)]),
            Command("move-pane-up", .workspace, "Move pane up", "Move the focused pane up. At the edge of its split, it spans the row beyond.", chords: [c("ArrowUp", ctrl: true, alt: true)]),
            Command("move-pane-down", .workspace, "Move pane down", "Move the focused pane down. At the edge of its split, it spans the row beyond.", chords: [c("ArrowDown", ctrl: true, alt: true)]),
            Command("toggle-split", .workspace, "Flip split", "Turn the split around the focused pane the other way, side by side or stacked.", chords: [c("j", ctrl: true, alt: true)]),
            Command("resize-left", .workspace, "Resize: divider left", "Move the divider beside the focused pane left. With no split, widen the side panel.", chords: [c("ArrowLeft", ctrl: true, alt: true, shift: true)]),
            Command("resize-right", .workspace, "Resize: divider right", "Move the divider beside the focused pane right. With no split, narrow the side panel.", chords: [c("ArrowRight", ctrl: true, alt: true, shift: true)]),
            Command("resize-up", .workspace, "Resize: divider up", "Move the divider above or below the focused pane up.", chords: [c("ArrowUp", ctrl: true, alt: true, shift: true)]),
            Command("resize-down", .workspace, "Resize: divider down", "Move the divider above or below the focused pane down.", chords: [c("ArrowDown", ctrl: true, alt: true, shift: true)]),
            Command("resize-mode", .workspace, "Resize mode", "Like a Hyprland submap: arrows move the nearest divider (Shift for big steps) until Escape or Return.", chords: [c("r", ctrl: true, shift: true)]),
            Command("pane-mode", .workspace, "Pane mode", "A Hyprland-style submap: h j k l (or arrows) focus, Shift moves, v / s split, x closes, f maximizes, t flips, r resizes, 1–9 go to a workspace (Shift sends), o opens a session as a new pane, Esc leaves.", chords: [c(" ", ctrl: true, shift: true)]),
            Command("replace-pane", .workspace, "Replace pane…", "Choose another session, a new shell, or a new session for the focused pane, inside the pane. Esc keeps what was there.", chords: [c("p", ctrl: true, alt: true)]),
            Command("open-in-pane", .workspace, "Open a session as a new pane…", "Pick a session; it opens beside the focused pane, split along its longer side.", chords: [c("o", ctrl: true, shift: true)]),
            Command("scratchpad", .workspace, "Scratchpad shell", "Show or hide a floating shell over anything, like Hyprland's special workspace. It keeps running while hidden.", chords: [c("`", ctrl: true, shift: true)]),
            Command("maximize-pane", .workspace, "Maximize pane", "Show the focused pane alone, like Hyprland fullscreen. Again to bring the split back.", chords: [c("f", ctrl: true, shift: true)]),
            Command("exit-split", .workspace, "Exit split", "Leave split view and close every pane. Sessions keep running."),
        ]
        // Workspaces 1–9, Hyprland-style: Option+N goes there, Option+Shift+N sends the focused session.
        for d in 1...9 {
            list.append(Command(.workspace(d), .workspace, "Workspace \(d)", "Go to workspace \(d). What you leave is kept there: its split, or its session.", chords: [c(String(d), alt: true)]))
        }
        for d in 1...9 {
            list.append(Command(.toWorkspace(d), .workspace, "Send to workspace \(d)", "Move the focused session to workspace \(d), as a new tile beside what is there.", chords: [c(String(d), alt: true, shift: true)]))
        }
        return list
    }()

    static let byID: [CommandID: Command] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

    static func command(_ id: CommandID) -> Command? { byID[id] }
    static func label(_ id: CommandID) -> String { byID[id]?.label ?? id.rawValue }

    /// "Not in a dialog; while typing, only from the start of the text".
    static func whenLabel(_ id: CommandID) -> String {
        guard let command = byID[id] else { return "" }
        if let edge = command.field {
            let when = ["start": "only from the start of the text", "end": "only from the end of the text", "empty": "only in an empty box"][edge.rawValue]!
            return "Not in a dialog; while typing, \(when)"
        }
        if command.scopes.contains(.dialog) && command.scopes.contains(.field) { return "Anywhere except a confirm" }
        if command.scopes.contains(.field) { return "Not in a dialog" }
        return "Not while typing or in a dialog"
    }
}

/// This device's rebindings: a command → its chords, or nil (explicitly unbound).
struct KeyBindings: Equatable, Sendable, Codable {
    private(set) var overrides: [CommandID: [Chord]?]

    init(overrides: [CommandID: [Chord]?] = [:]) {
        self.overrides = overrides
    }

    /// From a stored blob: unknown ids and bare-key chords are dropped (`readOverrides`).
    init(json: Data?) {
        guard let json, let object = try? JSONDecoder().decode([String: JSONValue].self, from: json) else {
            overrides = [:]
            return
        }
        var out: [CommandID: [Chord]?] = [:]
        for command in CommandCatalog.all {
            guard let value = object[command.id.rawValue] else { continue }
            if value.isNull {
                out[command.id] = .some(nil)
                continue
            }
            guard let array = value.array else { continue }
            let chords = array.compactMap { item -> Chord? in
                guard let data = try? JSONEncoder().encode(item), let chord = try? JSONDecoder().decode(Chord.self, from: data), !chord.key.isEmpty, chord.isUsable else { return nil }
                return chord
            }
            out[command.id] = .some(chords)
        }
        overrides = out
    }

    func json() -> Data {
        var object: [String: JSONValue] = [:]
        for (id, chords) in overrides {
            if let chords {
                object[id.rawValue] = .array(chords.map { chord in
                    var o: [String: JSONValue] = ["key": .string(chord.key)]
                    if chord.meta { o["meta"] = .bool(true) }
                    if chord.ctrl { o["ctrl"] = .bool(true) }
                    if chord.alt { o["alt"] = .bool(true) }
                    if chord.shift { o["shift"] = .bool(true) }
                    return .object(o)
                })
            } else {
                object[id.rawValue] = .null
            }
        }
        return (try? JSONEncoder().encode(object)) ?? Data("{}".utf8)
    }

    func chords(_ id: CommandID) -> [Chord] {
        if let override = overrides[id] { return override ?? [] }
        return CommandCatalog.byID[id]?.chords ?? []
    }

    func isOverridden(_ id: CommandID) -> Bool { overrides[id] != nil }

    /// The chord to show as a hint: a Command chord on Apple keyboards when there is one.
    func hint(_ id: CommandID, mac: Bool = true) -> Chord? {
        let list = chords(id)
        return list.first { mac ? $0.meta : !$0.meta } ?? list.first
    }

    /// Why `chord` can't be bound to `id`, or nil.
    func bindingError(_ id: CommandID, _ chord: Chord, mac: Bool = true) -> String? {
        guard chord.isUsable else { return "Use Control, Option, or Command together with another key." }
        for command in CommandCatalog.all where command.id != id {
            if chords(command.id).contains(chord) { return "\(chord.formatted(mac: mac)) is already \(command.label)." }
        }
        return nil
    }

    /// Binds `chord` (nil unbinds). Choosing a default chord clears the override. Returns an error and changes nothing when illegal or taken.
    mutating func set(_ id: CommandID, _ chord: Chord?, mac: Bool = true) -> String? {
        if let chord, let error = bindingError(id, chord, mac: mac) { return error }
        let defaults = CommandCatalog.byID[id]?.chords ?? []
        if let chord {
            if defaults.contains(chord) { overrides[id] = nil } else { overrides[id] = .some([chord]) }
        } else {
            overrides[id] = .some(nil)
        }
        return nil
    }

    mutating func reset(_ id: CommandID) { overrides[id] = nil }
    mutating func resetAll() { overrides = [:] }
}

/// The handlers that can run right now (registered by what's on screen, newest wins).
protocol CommandAvailability {
    func isActive(_ id: CommandID) -> Bool
}

enum CommandMatcher {
    /// The command a chord runs in `scope`, or nil (`matchShortcut`).
    static func match(_ chord: Chord, scope: KeyScope, bindings: KeyBindings = KeyBindings(), field: FieldState = FieldState()) -> CommandID? {
        guard scope != .ask, chord.isUsable else { return nil }
        for command in CommandCatalog.all where command.scopes.contains(scope) {
            if scope == .field, let edge = command.field, !field.allows(edge) { continue }
            if bindings.chords(command.id).contains(chord) { return command.id }
        }
        return nil
    }

    /// Subsequence score; contiguous runs and word starts count more; zero when a character is missing.
    static func fuzzy(_ query: String, _ text: String) -> Double {
        guard !query.isEmpty else { return 1 }
        let t = Array(text.lowercased())
        var score = 0.0
        var ti = 0
        var run = 0.0
        for ch in query.lowercased() {
            guard ti <= t.count, let found = t[ti...].firstIndex(of: ch) else { return 0 }
            run = found == ti ? run + 1 : 1
            let wordStart = found == 0 || " /+·:_-\t\n".contains(t[found - 1])
            score += run + (wordStart ? 3 : 0)
            ti = found + 1
        }
        return score
    }

    /// The palette's flat command search: catalog order when empty; a query ranks label,
    /// group and binding, with the detail counting only as a whole phrase.
    static func search(_ query: String, active: (CommandID) -> Bool, bindings: KeyBindings = KeyBindings(), mac: Bool = true) -> [Command] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let candidates = CommandCatalog.all.enumerated().filter { $0.element.id != "command-palette" && active($0.element.id) }
        guard !q.isEmpty else { return candidates.map(\.element) }
        let scored = candidates.compactMap { index, command -> (Command, Double, Bool, Int)? in
            let chordScore = bindings.chords(command.id).map { fuzzy(q, $0.formatted(mac: mac)) }.max() ?? 0
            let detail = command.detail.lowercased().contains(q) ? Double(q.count) : 0
            let own = max(fuzzy(q, command.label), fuzzy(q, command.group.rawValue), chordScore, detail)
            let related = own > 0 ? 0 : (command.terms.map { fuzzy(q, $0) }.max() ?? 0)
            let score = own > 0 ? own : related
            return score > 0 ? (command, score, own == 0 && related > 0, index) : nil
        }
        return scored.sorted { a, b in
            if a.2 != b.2 { return !a.2 }
            if a.1 != b.1 { return a.1 > b.1 }
            return a.3 < b.3
        }.map(\.0)
    }

    struct WhichKeyRow: Equatable, Sendable {
        let id: CommandID
        let label: String
        let key: String
    }

    /// What answers these held modifiers right now, plus one key: the which-key overlay.
    static func whichKey(ctrl: Bool, alt: Bool, shift: Bool, meta: Bool, active: (CommandID) -> Bool, bindings: KeyBindings = KeyBindings(), mac: Bool = true) -> [WhichKeyRow] {
        var rows: [WhichKeyRow] = []
        for command in CommandCatalog.all where active(command.id) {
            if let chord = bindings.chords(command.id).first(where: { (mac || !$0.meta) && $0.ctrl == ctrl && $0.alt == alt && $0.shift == shift && $0.meta == meta }) {
                rows.append(WhichKeyRow(id: command.id, label: command.label, key: chord.parts(mac: mac).last!))
            }
        }
        return rows.sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }
}
