import Foundation

/// The command palette as a tree (`../ah/web/palette.ts`): categories you walk into and out
/// of, and a search over everything below where you are. Static shape here, pointing at
/// catalog commands; live branches come from providers, so the tree only offers what can run.
struct PaletteNode: Equatable, Sendable, Identifiable {
    var id: String { key }
    let key: String
    let label: String
    /// An SF Symbol name.
    var icon: String? = nil
    /// A session's or agent's id for its mark (nil with `isSession` is a shell).
    var agent: String? = nil
    var detail: String? = nil
    var terms: [String] = []
    var action: PaletteAction? = nil
    var children: [PaletteNode]? = nil

    /// A branch you walk into. A row with both an action and children (a session) runs on
    /// Enter and opens its choices (switch to, open as a pane, move to a workspace) on →.
    var isCategory: Bool { children != nil && action == nil }
    var hasChoices: Bool { children != nil && action != nil }

    /// Runnable rows under a category (shown beside it).
    var leafCount: Int {
        (children ?? []).reduce(0) { $0 + ($1.isCategory ? $1.leafCount : 1) }
    }
}

/// What choosing a palette row does: data the UI dispatches, never a closure.
enum PaletteAction: Equatable, Sendable, Hashable {
    case command(CommandID)
    /// Go to a session: its pane when it's already on screen, else open it.
    case openSession(String)
    case openAsPane(String)
    /// Move a session to workspace N, beside what's there.
    case sendSession(String, workspace: Int)
    case sendQueuedNow(uid: String, item: String)
    case switchModel(String)
    case switchEffort(String)
    case switchMode(String)
    /// Start an agent (`preset`) or a shell in a project folder.
    case runInProject(path: String, preset: String)
    case continueIn(preset: String)
    case settings(String)

    /// How the palette remembers a row it ran, for Recent; nil for one-off rows.
    var recentKey: String? {
        switch self {
        case .command(let id): return id == "command-palette" ? nil : "command:\(id.rawValue)"
        case .openSession(let key): return "session:\(key)"
        case .settings(let section): return "settings:\(section)"
        case .runInProject(let path, let preset): return "run:\(preset):\(path)"
        case .openAsPane, .sendSession, .sendQueuedNow, .switchModel, .switchEffort, .switchMode, .continueIn: return nil
        }
    }
}

enum PaletteProvider: String, Sendable, CaseIterable {
    case sessions, queue, models, efforts, modes, tiles, projects, agents, settings
}

enum PaletteTree {
    indirect enum Spec: Sendable {
        case command(CommandID)
        case provider(PaletteProvider)
        case category(key: String, label: String, icon: String, detail: String? = nil, terms: [String] = [], children: [Spec])
    }

    static let root: Spec = .category(key: "root", label: "Commands", icon: "command", children: [
        .command("new-session"),
        .command("new-project"),
        .command("switcher"),
        .command("scratchpad"),
        .category(key: "run", label: "Run in project", icon: "folder", detail: "Start an agent or a shell in one of your projects", children: [.provider(.projects)]),
        .category(key: "go", label: "Go to", icon: "magnifyingglass", detail: "Sessions, pages and focus", children: [
            .category(key: "sessions", label: "Sessions", icon: "rectangle.stack", detail: "Every session, by name, project, branch or host", terms: ["switch", "jump"], children: [.provider(.sessions)]),
            .command("go-to-session"), .command("go-inbox"), .command("go-review"), .command("go-history"), .command("go-search"), .command("go-settings"),
            .command("worktrees"), .command("cycle-prev"), .command("cycle-next"), .command("focus-sidebar"), .command("focus-main"),
        ]),
        .category(key: "session", label: "Session", icon: "terminal", detail: "The focused session", children: [
            .category(key: "answer", label: "Answer", icon: "arrowshape.turn.up.left", detail: "Reply, approve, deny", children: [.command("reply"), .command("approve"), .command("deny")]),
            .category(key: "turn", label: "Turn and queue", icon: "list.bullet.rectangle", detail: "Stop, send queued messages now, cancel them", children: [.command("interrupt"), .command("send-now"), .provider(.queue), .command("clear-queue")]),
            .category(key: "model", label: "Model and effort", icon: "cpu", detail: "Switch what runs this session, and its permissions", terms: ["permissions", "mode"], children: [.provider(.models), .provider(.efforts), .provider(.modes), .command("pick-model"), .command("pick-effort")]),
            .category(key: "panels", label: "Panels", icon: "sidebar.right", detail: "Diff, files, chat, queue, snapshots", children: [
                .command("panel-diff"), .command("panel-files"), .command("panel-chat"), .command("panel-queue"), .command("panel-snapshots"), .command("panel-preview"), .command("panel-stack"), .command("toggle-panel"),
            ]),
            .category(key: "view", label: "View", icon: "eye", detail: "GUI or terminal, steps, copy, scroll", children: [
                .command("toggle-view"), .command("toggle-steps"), .command("browse-messages"), .command("copy-last"), .command("jump-latest"), .command("scrollback"), .command("toggle-keys"),
            ]),
            .category(key: "manage", label: "Manage", icon: "pencil", detail: "Rename, fork, hand off, pin, stop", children: [
                .command("rename"), .command("switch-branch"), .command("fork"), .command("send-to"), .command("pin"), .command("copy-attach"), .command("session-menu"), .command("terminate"),
            ]),
            .category(key: "continue", label: "Continue in…", icon: "paperplane", detail: "This conversation, in another agent", terms: ["handoff", "switch agent", "harness"], children: [.provider(.agents)]),
        ]),
        .category(key: "workspace", label: "Workspace", icon: "rectangle.split.2x2", detail: "Splits, panes and the sidebar", children: [
            .command("pane-mode"),
            .command("focus-follows-pointer"),
            .category(key: "tiles", label: "Open as a new pane", icon: "rectangle.split.2x1", detail: "Beside the focused pane, along its longer side", children: [.command("open-in-pane"), .provider(.tiles)]),
            .category(key: "split", label: "Split", icon: "rectangle.split.2x1", detail: "Open, replace, flip, close panes", terms: ["pane"], children: [
                .command("split-right"), .command("split-below"), .command("split-left"), .command("split-above"), .command("replace-pane"), .command("toggle-split"),
                .command("balance-panes"), .command("close-pane"), .command("exit-split"),
            ]),
            .category(key: "focus", label: "Focus pane", icon: "rectangle.lefthalf.inset.filled", children: [
                .command("focus-pane-left"), .command("focus-pane-right"), .command("focus-pane-up"), .command("focus-pane-down"), .command("focus-pane-next"), .command("focus-pane-prev"),
            ]),
            .category(key: "move", label: "Move pane", icon: "rectangle.righthalf.inset.filled", children: [.command("move-pane-left"), .command("move-pane-right"), .command("move-pane-up"), .command("move-pane-down")]),
            .category(key: "swap", label: "Swap panes", icon: "arrow.left.arrow.right", detail: "Trade places with a neighbor", terms: ["exchange"], children: [
                .command("swap-pane-left"), .command("swap-pane-right"), .command("swap-pane-up"), .command("swap-pane-down"),
            ]),
            .category(key: "workspaces", label: "Workspaces", icon: "square.grid.3x3", detail: "Hyprland-style 1–9: go to one, or send the focused session there", children:
                [Spec.command("workspace-next"), .command("workspace-prev")] + (1...9).flatMap { [Spec.command(.workspace($0)), .command(.toWorkspace($0))] }),
            .category(key: "resize", label: "Resize", icon: "arrow.left.and.right", detail: "Dividers and the side panel, by key", children: [
                .command("resize-mode"), .command("resize-left"), .command("resize-right"), .command("resize-up"), .command("resize-down"), .command("maximize-pane"),
            ]),
            .command("toggle-sidebar"),
        ]),
        .category(key: "settings", label: "Settings", icon: "gearshape", detail: "Theme, reconnect, restart, and every settings page", terms: ["preferences", "server"], children: [.provider(.settings)]),
        .category(key: "help", label: "Help", icon: "keyboard", children: [.command("show-shortcuts"), .command("reload-page")]),
    ])

    /// The tree as it stands now: commands that can't run dropped, live branches filled in,
    /// empty categories pruned (`resolveTree`).
    static func resolve(_ spec: Spec = root, active: (CommandID) -> Bool, provide: (PaletteProvider) -> [PaletteNode]) -> PaletteNode {
        func walk(_ spec: Spec) -> [PaletteNode] {
            switch spec {
            case .command(let id):
                guard id != "command-palette", active(id), let command = CommandCatalog.command(id) else { return [] }
                return [PaletteNode(key: id.rawValue, label: command.label, icon: CommandCatalog.icon(id), detail: command.detail, terms: command.terms, action: .command(id))]
            case .provider(let provider):
                return provide(provider)
            case .category(let key, let label, let icon, let detail, let terms, let children):
                let resolved = children.flatMap(walk)
                if resolved.isEmpty && key != "root" { return [] }
                return [PaletteNode(key: key, label: label, icon: icon, detail: detail, terms: terms, children: resolved)]
            }
        }
        return walk(spec).first!
    }

    struct Hit: Equatable, Sendable {
        let node: PaletteNode
        /// Ancestors below the search scope, outermost first.
        let trail: [PaletteNode]
        let score: Double
        /// Matched only a related word: listed under name matches.
        let related: Bool
    }

    /// Rows the palette ran recently that can still run here, newest first.
    static func recent(_ tree: PaletteNode, keys: [String], limit: Int = 5) -> [PaletteNode] {
        var byKey: [String: PaletteNode] = [:]
        func walk(_ node: PaletteNode) {
            for child in node.children ?? [] {
                if let key = child.action?.recentKey, byKey[key] == nil { byKey[key] = child }
                if child.isCategory { walk(child) }
            }
        }
        walk(tree)
        return Array(keys.compactMap { byKey[$0] }.prefix(limit))
    }

    /// Everything under `scope` matching `query` (`searchTree`): name/detail/breadcrumb
    /// matches first, related words after; categories and commands compete equally. Among
    /// equal matches, what you ran recently comes first (it never jumps a better match).
    static func search(_ scope: PaletteNode, _ query: String, recent: [String] = []) -> [Hit] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        let words = q.split(separator: " ").map(String.init)
        var hits: [(Hit, Int)] = []
        func visit(_ node: PaletteNode, _ trail: [PaletteNode]) {
            for child in node.children ?? [] {
                let label = CommandMatcher.fuzzy(q, child.label)
                let path = (trail + [child]).map { $0.label.lowercased() }.joined(separator: " ")
                let crumbs = words.count > 1 && words.allSatisfy { path.contains($0) } ? Double(q.count * 2) : 0
                let detail = child.detail?.lowercased().contains(q) == true ? Double(q.count) : 0
                let own = max(label * 3, crumbs, detail)
                let term = own > 0 ? 0 : (child.terms.map { CommandMatcher.fuzzy(q, $0) }.max() ?? 0)
                let score = own > 0 ? own : term
                if score > 0 { hits.append((Hit(node: child, trail: trail, score: score - Double(trail.count) * 0.5, related: own == 0), hits.count)) }
                if child.isCategory { visit(child, trail + [child]) }
            }
        }
        visit(scope, [])
        let rank = Dictionary(recent.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        func recency(_ hit: Hit) -> Int { hit.node.action?.recentKey.flatMap { rank[$0] } ?? Int.max }
        return hits.sorted { a, b in
            if a.0.related != b.0.related { return !a.0.related }
            if a.0.score != b.0.score { return a.0.score > b.0.score }
            if recency(a.0) != recency(b.0) { return recency(a.0) < recency(b.0) }
            return a.1 < b.1
        }.map(\.0)
    }
}
