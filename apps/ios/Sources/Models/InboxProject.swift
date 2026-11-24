import Foundation

/// One Space the Inbox can be narrowed to, from the chevron beside its title: a Space's name on
/// a host (one name on two machines is two Spaces), or "Not in a Space" (`outside`). Narrowed,
/// the Inbox shows that Space's sessions only: what needs you, what's working, the rest, its
/// notes, and its search (`apps/server/web` does the same). From a host older than `spaces` 3
/// the entries are the Spaces and projects its sessions worked in, as they were.
struct InboxProject: Codable, Equatable, Hashable, Sendable {
    let host: String
    let name: String

    /// "Not in a Space" (`spaces` 3): every session and conversation in none, on each host that
    /// works out the Space each one is in. Kept as a choice like any other (no host, no name).
    static let outside = InboxProject(host: "", name: "")
    static let outsideTitle = "Not in a Space"
    var isOutside: Bool { self == .outside }
    /// What the title and the menu call it.
    var title: String { isOutside ? Self.outsideTitle : name }

    func holds(_ row: SessionRow) -> Bool {
        if isOutside { return row.hostPlacesSpaces && row.spaceName == nil }
        return row.host == host && row.spaceName == name
    }

    func holds(_ row: HistoryRow) -> Bool {
        if isOutside { return row.hostPlacesSpaces && row.spaceName == nil }
        return row.host == host && row.spaceName == name
    }

    /// A note filed in this Space's folder or (`projects`: a `spaces` 3 Space's attached ones,
    /// read with the host's `home`) in one of its projects. "Not in a Space" holds the notes
    /// filed nowhere.
    func holds(_ note: NotesModel.Summary, projects: [String] = [], home: String? = nil) -> Bool {
        if isOutside { return note.project == nil }
        guard let filed = note.project, filed.host == host else { return false }
        if filed.name == name { return true }
        return projects.contains { SpacePortalLogic.sameSpacePath($0, filed.path, home: home) }
    }

    private static let worktreeSlugPattern = try! NSRegularExpression(
        pattern: "^(?:claude|codex|gemini|agy|grok|opencode|muse|hermes)-[0-9a-f]{4}$",
        options: [.caseInsensitive]
    )
    private static let mangledCachePattern = try! NSRegularExpression(
        pattern: "^home-[^/]+-\\.cache-",
        options: [.caseInsensitive]
    )

    /// True for orphaned worktree slugs or ephemeral cache folders that shouldn't clutter the Space menu when idle.
    static func isNoiseName(_ name: String, path: String? = nil) -> Bool {
        let range = NSRange(location: 0, length: (name as NSString).length)
        if worktreeSlugPattern.firstMatch(in: name, range: range) != nil { return true }
        if mangledCachePattern.firstMatch(in: name, range: range) != nil { return true }
        if let path, path.contains("/.worktrees/") || path.contains("/.cache/") { return true }
        return false
    }

    /// What an older host's menu offers: every Space worked in, running now or in History, and
    /// every plain one (`plain`, docs/spec/17-spaces.md: an empty one too), by name.
    static func choices(_ rows: [SessionRow], _ history: [HistoryRow], plain: [InboxProject] = []) -> [InboxProject] {
        var seen = Set<InboxProject>()
        let live = rows.compactMap { row in row.spaceName.map { InboxProject(host: row.host, name: $0) } }
        let past = history
            .filter { !isNoiseName($0.dto.project, path: $0.dto.cwd) }
            .map { InboxProject(host: $0.host, name: $0.dto.project) }
        let all = live + plain + past
        return sorted(all.filter { !$0.name.isEmpty && seen.insert($0).inserted })
    }

    /// The Inbox's menu (SPC-6). A host in `placing` (`spaces` 3) offers the Spaces made there,
    /// from its list (an empty one too), and never a project, a worktree or a cache folder; "Not
    /// in a Space" comes when one of its sessions or conversations is in none. An older host
    /// offers what it did: its plain Spaces, then the projects its sessions worked in.
    static func menu(_ rows: [SessionRow], _ history: [HistoryRow], lists: [String: SpacesListDTO], placing: Set<String>) -> InboxMenu {
        var made: [InboxProject] = []
        for (host, list) in lists where placing.contains(host) {
            made += list.spaces.filter { $0.kind == .space }.map { InboxProject(host: host, name: $0.name) }
        }
        let olderPlain = lists.filter { !placing.contains($0.key) }.flatMap { host, list in
            list.spaces.filter { $0.kind == .space }.map { InboxProject(host: host, name: $0.name) }
        }
        let older = choices(rows.filter { !placing.contains($0.host) }, history.filter { !placing.contains($0.host) }, plain: olderPlain)
        let olderSpaces = Set(olderPlain)
        let isMade = { (p: InboxProject) in olderSpaces.contains(p) || lists[p.host]?.spaces.first(where: { $0.name == p.name })?.kind == .space }
        var seen = Set<InboxProject>()
        let spaces = sorted((made + older.filter(isMade)).filter { seen.insert($0).inserted })
        let outside = rows.contains { InboxProject.outside.holds($0) } || history.contains { InboxProject.outside.holds($0) }
        return InboxMenu(spaces: spaces, projects: older.filter { !isMade($0) }, outside: outside)
    }

    private static func sorted(_ list: [InboxProject]) -> [InboxProject] {
        list.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.host < $1.host : order == .orderedAscending
        }
    }

    /// Where a new session in this project starts: the project's folder from a session in it
    /// (else the newest conversation's in History) and its host (nil for the hub's own).
    func place(_ rows: [SessionRow], _ history: [HistoryRow]) -> (cwd: String?, host: String?)? {
        if let row = rows.first(where: { holds($0) }) { return (LaunchState.canonicalProjectPath(row.dto.projectPath), row.isLocal ? nil : row.host) }
        if let item = history.first(where: { holds($0) }) { return (LaunchState.canonicalProjectPath(item.dto.cwd), item.isLocal ? nil : item.host) }
        return nil
    }

    /// What content search is asked to narrow to: the host matches a folder by its path (any
    /// part of a session's folder), so the project's whole path when a session knows it.
    func searchTerm(_ rows: [SessionRow]) -> String {
        rows.first { holds($0) }?.dto.projectPath ?? name
    }
}

/// What the Inbox's menu lists, in its sections (SPC-6).
struct InboxMenu: Equatable, Sendable {
    /// The Spaces made on each host, by name (with a host older than `spaces` 3, its plain ones).
    var spaces: [InboxProject]
    /// A host older than `spaces` 3 only: the projects and folders its sessions worked in.
    var projects: [InboxProject]
    /// "Not in a Space" is offered: a session or conversation on a `spaces` 3 host is in none.
    var outside: Bool

    /// Every entry the Inbox can be narrowed to.
    var choices: [InboxProject] { spaces + projects + (outside ? [.outside] : []) }
}
