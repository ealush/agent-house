import Foundation

/// One project the Inbox can be narrowed to, from the chevron beside its title: a project's
/// name on a host (one folder name on two machines is two projects). Narrowed, the Inbox shows
/// that project's sessions only: what needs you, what's working, the rest, its notes, and its
/// search (`apps/server/web` does the same).
struct InboxProject: Codable, Equatable, Hashable, Sendable {
    let host: String
    let name: String

    func holds(_ row: SessionRow) -> Bool { row.host == host && (row.dto.space ?? row.dto.project) == name }
    func holds(_ row: HistoryRow) -> Bool { row.host == host && row.dto.project == name }
    func holds(_ note: NotesModel.Summary) -> Bool { note.project.map { $0.host == host && $0.name == name } ?? false }

    /// What the menu offers: every Space worked in, running now or in History, and every
    /// plain one (`plain`, docs/spec/17-spaces.md: an empty one too), by name.
    static func choices(_ rows: [SessionRow], _ history: [HistoryRow], plain: [InboxProject] = []) -> [InboxProject] {
        var seen = Set<InboxProject>()
        let all = rows.map { InboxProject(host: $0.host, name: $0.dto.space ?? $0.dto.project) } + history.map { InboxProject(host: $0.host, name: $0.dto.project) } + plain
        return all.filter { !$0.name.isEmpty && seen.insert($0).inserted }.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.host < $1.host : order == .orderedAscending
        }
    }

    /// Where a new session in this project starts: the project's folder from a session in it
    /// (else the newest conversation's in History) and its host (nil for the hub's own).
    func place(_ rows: [SessionRow], _ history: [HistoryRow]) -> (cwd: String?, host: String?)? {
        if let row = rows.first(where: { holds($0) }) { return (row.dto.projectPath, row.isLocal ? nil : row.host) }
        if let item = history.first(where: { holds($0) }) { return (item.dto.cwd, item.isLocal ? nil : item.host) }
        return nil
    }

    /// What content search is asked to narrow to: the host matches a folder by its path (any
    /// part of a session's folder), so the project's whole path when a session knows it.
    func searchTerm(_ rows: [SessionRow]) -> String {
        rows.first { holds($0) }?.dto.projectPath ?? name
    }
}
