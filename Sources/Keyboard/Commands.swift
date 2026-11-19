import Foundation

// The keyboard command catalog (`../ah/web/shortcuts.ts`): its 71 literal commands (not
// the web's workspaces 1–9 and send-to-workspace 1–9, left out until they're wanted), then
// the native workspace's own (split left/above, balance, swap, pane cycling…). Defaults live here; a device may
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
    /// A second key pressed after this one, like VS Code's two-key chords ("⌃K ⌃S"). Native
    /// only, at most one step; an array because a struct can't hold an optional of itself.
    private(set) var then: [Chord] = []

    init(_ key: String, meta: Bool = false, ctrl: Bool = false, alt: Bool = false, shift: Bool = false, then next: Chord? = nil) {
        self.key = key
        self.meta = meta
        self.ctrl = ctrl
        self.alt = alt
        self.shift = shift
        then = next.map { [$0.lead] } ?? []
    }

    private enum CodingKeys: String, CodingKey { case key, meta, ctrl, alt, shift, then }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        meta = (try? c.decode(Bool.self, forKey: .meta)) ?? false
        ctrl = (try? c.decode(Bool.self, forKey: .ctrl)) ?? false
        alt = (try? c.decode(Bool.self, forKey: .alt)) ?? false
        shift = (try? c.decode(Bool.self, forKey: .shift)) ?? false
        then = (try? c.decodeIfPresent(Chord.self, forKey: .then)).flatMap { $0 }.map { [$0.lead] } ?? []
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        if meta { try c.encode(true, forKey: .meta) }
        if ctrl { try c.encode(true, forKey: .ctrl) }
        if alt { try c.encode(true, forKey: .alt) }
        if shift { try c.encode(true, forKey: .shift) }
        if let next { try c.encode(next, forKey: .then) }
    }

    /// The second key of a two-key chord.
    var next: Chord? { then.first }
    var isSequence: Bool { !then.isEmpty }
    /// The first key alone.
    var lead: Chord { Chord(key, meta: meta, ctrl: ctrl, alt: alt, shift: shift) }
    /// Every key in order: one, or two for a two-key chord.
    var steps: [Chord] { [lead] + then }

    func followed(by next: Chord) -> Chord { Chord(key, meta: meta, ctrl: ctrl, alt: alt, shift: shift, then: next) }

    /// The first key needs Ctrl, Option or Command (a bare key is text); a second key may be
    /// bare, but never Escape, which cancels a chord in progress.
    var isUsable: Bool {
        guard meta || ctrl || alt else { return false }
        guard let next else { return true }
        return !next.key.isEmpty && next.key != "Escape"
    }

    private static let keyLabel: [String: String] = ["ArrowUp": "↑", "ArrowDown": "↓", "ArrowLeft": "←", "ArrowRight": "→", "Enter": "Enter", "Backspace": "⌫", "Escape": "Esc", " ": "Space"]
    private static let partLabel: [String: String] = keyLabel.merging(["Enter": "↵", "Backspace": "Backspace", "Tab": "Tab"]) { $1 }

    /// "⌃⌥Enter" on Apple keyboards, "Ctrl+Alt+Enter" elsewhere; a two-key chord is both, spaced.
    func formatted(mac: Bool = true) -> String {
        if let next { return lead.formatted(mac: mac) + " " + next.formatted(mac: mac) }
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

    /// One label per key of the first step, Ctrl, Shift, Option, Command, then the key: for
    /// keycaps (`steps` gives each step of a two-key chord).
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

    /// The label as a menu writes it: the menu bar, the ⌘-hold overlay, the palette and the
    /// shortcut table say "New Session" and "Copy the Agent's Last Reply", as every Apple
    /// menu does, where ah's web table says "New session".
    var title: String { TitleCase.apply(label) }
}

/// Apple's title case for menu items and buttons: every word capitalized except articles,
/// short conjunctions and short prepositions, which stay lowercase unless they open or close
/// the title. Words already holding a capital (GUI, PR, iPad) and symbols are left as written.
enum TitleCase {
    private static let minor: Set<String> = ["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "via", "vs"]

    static func apply(_ text: String) -> String {
        let words = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        let last = words.lastIndex { $0.first?.isLetter == true }
        return words.enumerated().map { index, word in
            guard let first = word.first, first.isLetter, first.isLowercase, !word.dropFirst().contains(where: \.isUppercase) else { return word }
            let edge = index == 0 || index == last
            if !edge, minor.contains(word) { return word }
            // A word after a slash ("Hide / show") starts a title of its own.
            return first.uppercased() + word.dropFirst()
        }.joined(separator: " ")
    }
}

struct CommandID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    init(stringLiteral value: String) { rawValue = value }
    var description: String { rawValue }
}

enum CommandCatalog {
    private static func c(_ key: String, meta: Bool = false, ctrl: Bool = false, alt: Bool = false, shift: Bool = false) -> Chord {
        Chord(key, meta: meta, ctrl: ctrl, alt: alt, shift: shift)
    }

    private static let everywhere: Set<KeyScope> = [.app, .terminal, .field]

    /// The web's 89, in its order.
    static let web: [Command] = {
        var list: [Command] = [
            Command("command-palette", .navigate, "Command palette", "Search the actions you can run right now. The binding sits on the right of each one.", chords: [c("p", meta: true, shift: true), c("p", ctrl: true, shift: true)]),
            Command("switcher", .navigate, "Search or jump", "Open the switcher. Also works while a text field or another dialog is open.", chords: [c("k", meta: true), c("k", ctrl: true, shift: true)], scopes: [.app, .terminal, .field, .dialog]),
            Command("cycle-prev", .navigate, "Previous session", "The previous session in sidebar order. From the inbox, this opens the last one. Also works while a text field is focused.", chords: [c("[", meta: true), c("ArrowUp", alt: true)]),
            Command("cycle-next", .navigate, "Next session", "The next session in sidebar order. From the inbox, this opens the first one. Also works while a text field is focused.", chords: [c("]", meta: true), c("ArrowDown", alt: true)]),
            Command("new-session", .navigate, "New session", "Open the new-session dialog.", chords: [c("n", meta: true), c("Enter", ctrl: true, shift: true)]),
            Command("new-project", .navigate, "New project", "Create a folder and start a session in it."),
            Command("toggle-sidebar", .navigate, "Toggle sidebar", "Show or hide the sidebar.", chords: [c("s", meta: true, ctrl: true), c("e", ctrl: true, shift: true)]),
            Command("go-inbox", .navigate, "Inbox", "Leave the session or split and show the inbox.", chords: [c("1", ctrl: true, shift: true)]),
            Command("go-history", .navigate, "History", "Open the history page.", chords: [c("2", ctrl: true, shift: true)]),
            Command("go-review", .navigate, "Review", "Open Review: your pull request stacks, one layer at a time.", chords: [c("4", ctrl: true, shift: true)]),
            Command("go-search", .navigate, "Search", "Search every conversation and side chat, on every host.", chords: [c("f", meta: true), c("5", ctrl: true, shift: true)], terms: ["find", "full text", "transcripts"]),
            Command("worktrees", .navigate, "Worktrees", "Managed worktrees: dirty, ahead, orphaned, and their size; clean up.", terms: ["branches", "checkouts", "clean"]),
            Command("go-settings", .navigate, "Settings", "Open settings.", chords: [c(",", meta: true), c("3", ctrl: true, shift: true)], scopes: [.app, .terminal, .field, .dialog]),
            Command("focus-sidebar", .navigate, "Focus the session list", "Move focus to the current session in the sidebar. On a phone, open the Sessions tab. Arrows move, Enter opens.", chords: [c("0", ctrl: true, shift: true)]),
            Command("focus-main", .navigate, "Focus the session", "Back to the open session: its composer in the GUI, the terminal otherwise.", chords: [c("9", ctrl: true, shift: true)]),
            Command("reload-page", .navigate, "Reload", "Reconnect to your hosts and refresh everything shown. Sessions keep running."),
            Command("show-shortcuts", .navigate, "Keyboard shortcuts", "Open the shortcut table.", chords: [c("/", meta: true), c("/", ctrl: true, shift: true)]),
            Command("toggle-view", .session, "GUI or terminal", "Switch the focused session between the terminal and the transcript GUI.", chords: [c("g", ctrl: true, shift: true)]),
            Command("toggle-steps", .session, "Hide / show steps", "In the GUI, fold tool calls and thinking to one line per run, so the conversation reads as prose (every session on this device). In focus mode, show or hide this session's steps.", chords: [c("h", ctrl: true, alt: true)], terms: ["tool calls", "collapse", "thinking"]),
            Command("toggle-panel", .session, "Toggle side panel", "Show or hide the session side panel.", chords: [c("i", meta: true, alt: true), c("j", ctrl: true, shift: true)]),
            Command("reply", .session, "Reply", "Focus the composer, or the terminal when that is the current view.", chords: [c("r", ctrl: true, alt: true)]),
            Command("approve", .session, "Approve", "Approve the prompt on the focused session, when it is waiting for one.", chords: [c("Enter", ctrl: true, alt: true)]),
            Command("deny", .session, "Deny", "Deny the prompt on the focused session, when it is waiting for one.", chords: [c("Backspace", ctrl: true, alt: true)]),
            Command("interrupt", .session, "Stop the turn", "Interrupt what the agent is doing right now (Esc in its terminal). In the GUI, Esc in an empty composer does the same.", chords: [c(".", meta: true), c("x", ctrl: true, alt: true)]),
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
            Command("panel-terminal", .session, "Terminal", "Open this session’s attached shell. It stays running when hidden.", terms: ["shell", "command", "panel"]),
            Command("session-menu", .session, "Session menu", "Open the session menu; arrows move, Return runs, Escape closes.", chords: [c(".", ctrl: true, alt: true)]),
            Command("scrollback", .session, "Scrollback as text", "The terminal's scrollback as selectable, copyable text."),
            Command("copy-attach", .session, "Copy attach command", "Copy “ah attach <id>” to open this session from a terminal."),
            Command("toggle-keys", .session, "Show or hide on-screen keys", "The Esc / Tab / arrows / Ctrl key bar under the terminal.", chords: [c("k", ctrl: true, alt: true)]),
            Command("terminate", .session, "Terminate session", "Stop the focused session. Asks for confirmation first."),
            Command("split-right", .workspace, "Split right", "Open another session to the right of the focused one.", chords: [c("d", meta: true), c("\\", ctrl: true, shift: true)], terms: ["pane"]),
            Command("split-below", .workspace, "Split below", "Open another session below the focused one.", chords: [c("d", meta: true, shift: true), c("-", ctrl: true, shift: true)], terms: ["pane"]),
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
            Command("pane-mode", .workspace, "Pane mode", "A Hyprland-style submap: h j k l (or arrows) focus, Shift moves, v / s split, x closes, f maximizes, t flips, r resizes, o opens a session as a new pane, Esc leaves.", chords: [c(" ", ctrl: true, shift: true)]),
            Command("replace-pane", .workspace, "Replace pane…", "Choose another session, a new shell, or a new session for the focused pane, inside the pane. Esc keeps what was there.", chords: [c("p", ctrl: true, alt: true)]),
            Command("open-in-pane", .workspace, "Open a session as a new pane…", "Pick a session; it opens beside the focused pane, split along its longer side.", chords: [c("o", ctrl: true, shift: true)]),
            Command("scratchpad", .workspace, "Scratchpad shell", "Show or hide a floating shell over anything, like Hyprland's special workspace. It keeps running while hidden.", chords: [c("`", ctrl: true, shift: true)]),
            Command("maximize-pane", .workspace, "Maximize pane", "Show the focused pane alone, like Hyprland fullscreen. Again to bring the split back.", chords: [c("f", ctrl: true, shift: true)]),
            Command("exit-split", .workspace, "Exit split", "Leave split view and close every pane. Sessions keep running."),
        ]
        return list
    }()

    /// Native workspace commands beyond the web's catalog (DECISIONS: tiling and focus).
    static let native: [Command] = [
        Command("split-left", .workspace, "Split left", "Open another pane to the left of the focused one.", chords: [c("\\", ctrl: true, alt: true, shift: true)], terms: ["pane", "beside"]),
        Command("split-above", .workspace, "Split above", "Open another pane above the focused one.", chords: [c("-", ctrl: true, alt: true, shift: true)], terms: ["pane"]),
        Command("balance-panes", .workspace, "Balance panes", "Even out every divider, so each pane gets its share.", chords: [c("=", ctrl: true, shift: true)], terms: ["equalize", "even", "sizes", "resize"]),
        Command("swap-pane-left", .workspace, "Swap with pane left", "Trade places with the pane on the left; the focus moves with yours.", terms: ["exchange", "pane"]),
        Command("swap-pane-right", .workspace, "Swap with pane right", "Trade places with the pane on the right; the focus moves with yours.", terms: ["exchange", "pane"]),
        Command("swap-pane-up", .workspace, "Swap with pane above", "Trade places with the pane above; the focus moves with yours.", terms: ["exchange", "pane"]),
        Command("swap-pane-down", .workspace, "Swap with pane below", "Trade places with the pane below; the focus moves with yours.", terms: ["exchange", "pane"]),
        Command("focus-pane-next", .workspace, "Next pane", "Move to the next pane in reading order, wrapping around.", chords: [c("Tab", ctrl: true)], terms: ["cycle"]),
        Command("focus-pane-prev", .workspace, "Previous pane", "Move to the previous pane in reading order, wrapping around.", chords: [c("Tab", ctrl: true, shift: true)], terms: ["cycle"]),
        Command("go-to-session", .navigate, "Go to session…", "Search every session in the palette and jump to it, or open it as a pane.", terms: ["switch", "find", "session"]),
        Command("terminal-text-bigger", .session, "Bigger terminal text", "One point bigger, in every terminal on this device. Pinching does the same.", chords: [c("=", meta: true), c("+", meta: true, shift: true)], scopes: [.app, .terminal], terms: ["zoom", "font", "size"]),
        Command("terminal-text-smaller", .session, "Smaller terminal text", "One point smaller, in every terminal on this device.", chords: [c("-", meta: true)], scopes: [.app, .terminal], terms: ["zoom", "font", "size"]),
        Command("terminal-text-reset", .session, "Default terminal text size", "Back to the standard size.", chords: [c("0", meta: true)], scopes: [.app, .terminal], terms: ["zoom", "font", "size", "actual"]),
        Command("new-window", .workspace, "New window", "Open another Agent House window, side by side or on its own (iPad and Mac).", terms: ["window", "scene", "stage manager"]),
        Command("open-in-new-window", .workspace, "Open session in new window", "Move the focused session into a window of its own (iPad and Mac).", terms: ["window", "tear off", "detach"]),
        Command("copy-link", .navigate, "Copy link", "A link to what's on screen: the session with its view and panel, a page, a review. It opens here and in the web app.", chords: [c("c", meta: true, alt: true)], terms: ["share", "url", "deep link"]),
        Command("share-link", .navigate, "Share link…", "Send a link to what's on screen through the share sheet.", terms: ["url", "deep link", "airdrop"]),
        Command("open-link", .navigate, "Open link from clipboard", "Go to the place an ah link names: a session, a message, a page or a Settings section.", terms: ["url", "deep link", "paste"]),
        Command("continue-in", .session, "Continue in another agent…", "Carry this conversation on in another agent (or fork it): see what carries over and what doesn't before it starts. The original stays as it is.", terms: ["handoff", "hand off", "switch agent", "harness", "portable", "codex", "claude"]),
        Command("conversation-lineage", .session, "Conversation lineage", "Every conversation this one came from or went on to, across agents, and how each was carried.", terms: ["lineage", "history", "family", "parent", "origin"]),
        Command("focus-follows-pointer", .workspace, "Focus follows the pointer", "With a trackpad or mouse, hovering over a pane makes it the focused one. Again to turn it off.", terms: ["hover", "mouse", "trackpad", "focus"]),
        // Notes (scratchpads): Markdown of your own, a session with no agent behind it.
        Command("new-note", .navigate, "New note", "A Markdown scratchpad of your own, filed under the project you're in: write or dictate it, offline too, then hand it to an agent or save it as a file.", chords: [c("n", meta: true, alt: true)], terms: ["scratchpad", "notes", "markdown", "spec", "idea", "plan"]),
        Command("note-preview", .session, "Edit or preview note", "Switch the note between its Markdown and how it reads.", chords: [c("e", meta: true, shift: true)], terms: ["markdown", "render", "read"]),
        Command("note-send", .session, "Send note to an agent…", "Send the whole note to a session as a message: queued if it's working, resumed if it ended. The note stays as it is.", terms: ["hand off", "message", "agent", "prompt"]),
        Command("note-insert", .session, "Put note in a session's box…", "Put the whole note in a session's message box to edit before you send it.", terms: ["composer", "draft", "paste"]),
        Command("note-new-session", .session, "New session from note", "New session with the note as its first message, in the note's project.", terms: ["start", "agent", "prompt", "launch"]),
        Command("note-new-session-file", .session, "New session with note attached", "New session with the note attached as a Markdown file.", terms: ["start", "agent", "attachment", "file"]),
        Command("note-save-file", .session, "Save note as file…", "Write the note into a project folder (SPEC.md, PLAN.md, docs/…). The file is a copy; the note stays the original.", chords: [c("s", meta: true, shift: true)], terms: ["export", "spec", "plan", "markdown", "write"]),
        Command("note-project", .session, "File note under a project…", "Choose the project this note belongs to, or none. Nothing is written into the folder.", terms: ["associate", "folder", "move"]),
        Command("note-duplicate", .session, "Duplicate note", "A copy of the note beside it.", terms: ["copy", "clone"]),
        Command("note-delete", .session, "Delete note…", "Delete the note on every device it syncs to.", terms: ["remove", "trash"]),
    ]

    static let all: [Command] = web + native

    static let byID: [CommandID: Command] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })

    static func command(_ id: CommandID) -> Command? { byID[id] }

    /// Each command's SF Symbol, for palette rows, menus and pane menus.
    static func icon(_ id: CommandID) -> String {
        return icons[id.rawValue] ?? "command"
    }

    private static let icons: [String: String] = [
        "command-palette": "command", "switcher": "magnifyingglass", "cycle-prev": "chevron.up", "cycle-next": "chevron.down",
        "new-session": "plus.square", "new-project": "folder.badge.plus", "toggle-sidebar": "sidebar.left", "go-inbox": "tray",
        "go-history": "clock.arrow.circlepath", "go-review": "checkmark.rectangle.stack", "go-search": "text.magnifyingglass",
        "worktrees": "arrow.triangle.branch", "go-settings": "gearshape", "focus-sidebar": "sidebar.squares.left", "focus-main": "text.cursor",
        "reload-page": "arrow.clockwise", "show-shortcuts": "keyboard", "toggle-view": "terminal", "toggle-steps": "list.bullet.indent",
        "toggle-panel": "sidebar.right", "reply": "arrowshape.turn.up.left", "approve": "checkmark.circle", "deny": "xmark.circle",
        "interrupt": "stop.circle", "send-now": "paperplane", "clear-queue": "trash", "pick-model": "cpu", "pick-effort": "speedometer",
        "copy-last": "doc.on.doc", "jump-latest": "arrow.down.to.line", "browse-messages": "text.bubble", "switch-branch": "arrow.triangle.branch",
        "continue-in": "arrow.turn.down.right", "conversation-lineage": "point.3.connected.trianglepath.dotted",
        "rename": "pencil", "fork": "arrow.branch", "send-to": "arrowshape.turn.up.right", "pin": "pin", "panel-diff": "plusminus",
        "panel-files": "folder", "panel-chat": "bubble.left.and.bubble.right", "panel-queue": "list.bullet.rectangle", "panel-snapshots": "clock.arrow.circlepath",
        "panel-preview": "safari", "panel-stack": "square.stack.3d.up", "panel-terminal": "terminal", "session-menu": "ellipsis", "scrollback": "scroll",
        "copy-attach": "terminal", "toggle-keys": "keyboard.chevron.compact.down", "terminal-text-bigger": "textformat.size.larger", "terminal-text-smaller": "textformat.size.smaller", "terminal-text-reset": "textformat.size", "terminate": "xmark.octagon",
        "split-right": "rectangle.split.2x1", "split-below": "rectangle.split.1x2", "split-left": "rectangle.lefthalf.inset.filled",
        "split-above": "rectangle.tophalf.inset.filled", "close-pane": "xmark.square",
        "focus-pane-left": "arrow.left.square", "focus-pane-right": "arrow.right.square", "focus-pane-up": "arrow.up.square", "focus-pane-down": "arrow.down.square",
        "move-pane-left": "arrow.left.circle", "move-pane-right": "arrow.right.circle", "move-pane-up": "arrow.up.circle", "move-pane-down": "arrow.down.circle",
        "toggle-split": "arrow.triangle.2.circlepath", "resize-left": "arrow.left.and.right", "resize-right": "arrow.left.and.right",
        "resize-up": "arrow.up.and.down", "resize-down": "arrow.up.and.down", "resize-mode": "arrow.left.and.right.square",
        "pane-mode": "square.grid.2x2", "replace-pane": "arrow.triangle.swap", "open-in-pane": "plus.rectangle.on.rectangle",
        "scratchpad": "terminal.fill", "maximize-pane": "arrow.up.left.and.arrow.down.right", "exit-split": "rectangle",
        "balance-panes": "equal.square", "swap-pane-left": "arrow.left.arrow.right", "swap-pane-right": "arrow.left.arrow.right",
        "swap-pane-up": "arrow.up.arrow.down", "swap-pane-down": "arrow.up.arrow.down", "focus-pane-next": "arrow.forward.square",
        "focus-pane-prev": "arrow.backward.square",
        "go-to-session": "rectangle.stack", "focus-follows-pointer": "cursorarrow.motionlines",
        "copy-link": "link", "share-link": "square.and.arrow.up", "open-link": "arrow.up.forward.square",
        "new-window": "macwindow.badge.plus", "open-in-new-window": "rectangle.portrait.on.rectangle.portrait.angled",
        "new-note": "square.and.pencil", "note-preview": "eye", "note-send": "paperplane", "note-insert": "text.insert",
        "note-new-session": "plus.square", "note-new-session-file": "doc.badge.plus", "note-save-file": "square.and.arrow.down",
        "note-project": "folder", "note-duplicate": "plus.square.on.square", "note-delete": "trash",
    ]
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
                func encode(_ chord: Chord) -> JSONValue {
                    var o: [String: JSONValue] = ["key": .string(chord.key)]
                    if chord.meta { o["meta"] = .bool(true) }
                    if chord.ctrl { o["ctrl"] = .bool(true) }
                    if chord.alt { o["alt"] = .bool(true) }
                    if chord.shift { o["shift"] = .bool(true) }
                    if let next = chord.next { o["then"] = encode(next) }
                    return .object(o)
                }
                object[id.rawValue] = .array(chords.map(encode))
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

    /// Two bindings fight when they're the same keys, or one is the first key of the other's
    /// two-key chord (it would fire before the second key could come).
    static func clashes(_ a: Chord, _ b: Chord) -> Bool {
        if a == b { return true }
        if a.isSequence == b.isSequence { return false }
        return a.isSequence ? a.lead == b : b.lead == a
    }

    /// The command that already answers `chord` wherever `id` would (their scopes overlap).
    func conflict(_ id: CommandID, _ chord: Chord) -> CommandID? {
        let mine = CommandCatalog.byID[id]?.scopes ?? [.app, .terminal, .field]
        for command in CommandCatalog.all where command.id != id && !command.scopes.isDisjoint(with: mine) {
            if chords(command.id).contains(where: { Self.clashes(chord, $0) }) { return command.id }
        }
        return nil
    }

    /// Keys iPadOS or text editing keep for themselves: the app would never see them, or
    /// typing would break. Why, or nil.
    static func reservedReason(_ chord: Chord, mac: Bool = true) -> String? {
        let lead = chord.lead
        let system: [Chord: String] = [
            Chord("h", meta: true): "goes to the Home Screen", Chord(" ", meta: true): "opens Spotlight",
            Chord("Tab", meta: true): "switches apps", Chord("Tab", meta: true, shift: true): "switches apps",
            Chord("3", meta: true, shift: true): "takes a screenshot", Chord("4", meta: true, shift: true): "takes a screenshot",
            Chord("d", meta: true, alt: true): "shows the Dock",
        ]
        let editing: [Chord: String] = [
            Chord("c", meta: true): "Copy", Chord("v", meta: true): "Paste", Chord("x", meta: true): "Cut",
            Chord("z", meta: true): "Undo", Chord("z", meta: true, shift: true): "Redo", Chord("a", meta: true): "Select All",
            Chord("ArrowLeft", meta: true): "start of line", Chord("ArrowRight", meta: true): "end of line",
            Chord("ArrowUp", meta: true): "start of text", Chord("ArrowDown", meta: true): "end of text",
            Chord("ArrowLeft", alt: true): "previous word", Chord("ArrowRight", alt: true): "next word",
            Chord("Backspace", alt: true): "delete a word", Chord("Backspace", meta: true): "delete to line start",
        ]
        let name = lead.formatted(mac: mac)
        if let what = system[lead] { return "\(name) \(what), so the app never sees it." }
        if let what = editing[lead] { return "\(name) is \(what) while you type." }
        return nil
    }

    /// Why `chord` can't be bound to `id`, or nil.
    func bindingError(_ id: CommandID, _ chord: Chord, mac: Bool = true) -> String? {
        guard chord.isUsable else {
            if chord.isSequence, chord.next?.key == "Escape" { return "Escape cancels a two-key shortcut, so it can't be the second key." }
            return "Use Control, Option, or Command together with another key."
        }
        if let reason = Self.reservedReason(chord, mac: mac) { return reason }
        if let other = conflict(id, chord), let command = CommandCatalog.byID[other] {
            let theirs = chords(other).first { Self.clashes(chord, $0) } ?? chord
            if theirs == chord { return "\(chord.formatted(mac: mac)) is already \(command.label)." }
            return "\(chord.formatted(mac: mac)) clashes with \(command.label) (\(theirs.formatted(mac: mac)))."
        }
        if chords(id).contains(where: { $0 != chord && Self.clashes(chord, $0) }) { return "\(chord.formatted(mac: mac)) clashes with this command's other shortcut." }
        return nil
    }

    /// Binds `chord` (nil unbinds): in place of this command's shortcuts, or `adding` it to
    /// them. `takingOver` removes it from the command that has it instead of refusing.
    /// Ending up with the defaults clears the override. Returns an error and changes nothing
    /// when illegal or taken.
    mutating func set(_ id: CommandID, _ chord: Chord?, mac: Bool = true, adding: Bool = false, takingOver: Bool = false) -> String? {
        guard let chord else {
            overrides[id] = .some(nil)
            return nil
        }
        if takingOver, chord.isUsable, Self.reservedReason(chord, mac: mac) == nil {
            while let other = conflict(id, chord) {
                store(other, chords(other).filter { !Self.clashes(chord, $0) })
            }
        }
        if let error = bindingError(id, chord, mac: mac) { return error }
        let defaults = CommandCatalog.byID[id]?.chords ?? []
        if adding {
            store(id, chords(id).contains(chord) ? chords(id) : chords(id) + [chord])
        } else if defaults.contains(chord) {
            overrides[id] = nil
        } else {
            store(id, [chord])
        }
        return nil
    }

    /// Drop one of a command's shortcuts.
    mutating func remove(_ id: CommandID, _ chord: Chord) {
        store(id, chords(id).filter { $0 != chord })
    }

    private mutating func store(_ id: CommandID, _ list: [Chord]) {
        let defaults = CommandCatalog.byID[id]?.chords ?? []
        if list == defaults { overrides[id] = nil } else { overrides[id] = .some(list.isEmpty ? nil : list) }
    }

    mutating func reset(_ id: CommandID) { overrides[id] = nil }
    mutating func resetAll() { overrides = [:] }

    /// Commands whose shortcuts differ from the defaults.
    var modified: Set<CommandID> { Set(overrides.keys) }
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

    /// This key starts a two-key chord here: the window waits for the second key.
    static func startsSequence(_ chord: Chord, scope: KeyScope, bindings: KeyBindings = KeyBindings()) -> Bool {
        guard scope != .ask, chord.isUsable, !chord.isSequence else { return false }
        return CommandCatalog.all.contains { command in
            command.scopes.contains(scope) && bindings.chords(command.id).contains { $0.isSequence && $0.lead == chord }
        }
    }

    /// The command a two-key chord runs in `scope`, or nil.
    static func completeSequence(_ lead: Chord, _ next: Chord, scope: KeyScope, bindings: KeyBindings = KeyBindings()) -> CommandID? {
        let full = lead.lead.followed(by: next)
        for command in CommandCatalog.all where command.scopes.contains(scope) {
            if bindings.chords(command.id).contains(full) { return command.id }
        }
        return nil
    }

    /// What the second key can be after `lead`: the legend while a chord is in progress.
    static func continuations(after lead: Chord, active: (CommandID) -> Bool, bindings: KeyBindings = KeyBindings(), mac: Bool = true) -> [WhichKeyRow] {
        var rows: [WhichKeyRow] = []
        for command in CommandCatalog.all where active(command.id) {
            for chord in bindings.chords(command.id) where chord.isSequence && chord.lead == lead.lead {
                rows.append(WhichKeyRow(id: command.id, label: command.title, key: chord.next!.formatted(mac: mac)))
            }
        }
        return rows.sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
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
        var leads: [String: Int] = [:]
        for command in CommandCatalog.all where active(command.id) {
            let held = bindings.chords(command.id).filter { (mac || !$0.meta) && $0.ctrl == ctrl && $0.alt == alt && $0.shift == shift && $0.meta == meta }
            if let chord = held.first(where: { !$0.isSequence }) {
                rows.append(WhichKeyRow(id: command.id, label: command.title, key: chord.parts(mac: mac).last!))
            }
            // A two-key chord's first key shows once, as "K…".
            for chord in held where chord.isSequence {
                let key = chord.parts(mac: mac).last! + "…"
                if let i = leads[key] {
                    rows[i] = WhichKeyRow(id: rows[i].id, label: "Two-key shortcuts", key: key)
                } else {
                    leads[key] = rows.count
                    rows.append(WhichKeyRow(id: command.id, label: "Then: \(command.title)", key: key))
                }
            }
        }
        return rows.sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }
}

/// The shortcut editor's search: a command's name, group, related words or detail, or its
/// keys typed as words or glyphs ("ctrl shift p", "⌃⇧P", "cmd+k"), or keys pressed.
enum KeymapSearch {
    enum Filter: String, Sendable, CaseIterable {
        case all, modified, unbound
    }

    static func commands(_ query: String, bindings: KeyBindings, filter: Filter = .all, mac: Bool = true) -> [Command] {
        let words = tokens(query)
        return CommandCatalog.all.filter { command in
            switch filter {
            case .all: break
            case .modified: guard bindings.isOverridden(command.id) else { return false }
            case .unbound: guard bindings.chords(command.id).isEmpty else { return false }
            }
            guard !words.isEmpty else { return true }
            let text = ([command.label, command.group.rawValue, command.detail] + command.terms).joined(separator: " ").lowercased()
            if words.allSatisfy({ text.contains($0) }) { return true }
            return bindings.chords(command.id).contains { chord in Set(words).isSubset(of: keyWords(chord)) }
        }
    }

    /// Commands bound to exactly these keys (the editor's "press keys to search").
    static func commands(pressing chord: Chord, bindings: KeyBindings) -> [Command] {
        CommandCatalog.all.filter { command in bindings.chords(command.id).contains { $0 == chord || $0.lead == chord } }
    }

    private static let glyphs: [Character: String] = ["⌃": "ctrl", "⌥": "alt", "⇧": "shift", "⌘": "cmd", "↑": "up", "↓": "down", "←": "left", "→": "right", "⌫": "backspace", "↵": "enter"]
    private static let synonyms: [String: String] = ["control": "ctrl", "option": "alt", "opt": "alt", "command": "cmd", "super": "cmd", "meta": "cmd", "return": "enter", "esc": "escape"]

    /// Lowercased words, with modifier glyphs and "+" split apart and synonyms folded.
    static func tokens(_ text: String) -> [String] {
        var spaced = ""
        for ch in text.lowercased() {
            if let word = glyphs[ch] { spaced += " \(word) " } else if ch == "+" { spaced += " " } else { spaced.append(ch) }
        }
        return spaced.split(whereSeparator: { $0 == " " }).map { synonyms[String($0)] ?? String($0) }
    }

    /// Every word a chord answers to: its modifiers and its key, for both of a two-key chord's steps.
    static func keyWords(_ chord: Chord) -> Set<String> {
        var words: Set<String> = []
        for step in chord.steps {
            if step.ctrl { words.insert("ctrl") }
            if step.alt { words.insert("alt") }
            if step.shift { words.insert("shift") }
            if step.meta { words.insert("cmd") }
            let key = step.key.lowercased()
            words.insert(key == " " ? "space" : key)
            if key.hasPrefix("arrow") { words.insert(String(key.dropFirst(5))) }
        }
        return words
    }
}
