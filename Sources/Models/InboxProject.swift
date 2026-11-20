import Foundation

/// One project the Inbox can be narrowed to, from the chevron beside its title: a project's
/// name on a host (one folder name on two machines is two projects). Narrowed, the Inbox shows
/// that project's sessions only: what needs you, what's working, the rest, its notes, and its
/// search (`../ah/web` does the same).
struct InboxProject: Codable, Equatable, Hashable, Sendable {
    let host: String
    let name: String

    func holds(_ row: SessionRow) -> Bool { row.host == host && row.dto.project == name }
    func holds(_ row: HistoryRow) -> Bool { row.host == host && row.dto.project == name }
    func holds(_ note: NotesModel.Summary) -> Bool { note.project.map { $0.host == host && $0.name == name } ?? false }

    /// What the menu offers: every project worked in, running now or in History, by name.
    static func choices(_ rows: [SessionRow], _ history: [HistoryRow]) -> [InboxProject] {
        var seen = Set<InboxProject>()
        let all = rows.map { InboxProject(host: $0.host, name: $0.dto.project) } + history.map { InboxProject(host: $0.host, name: $0.dto.project) }
        return all.filter { !$0.name.isEmpty && seen.insert($0).inserted }.sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.host < $1.host : order == .orderedAscending
        }
    }

    /// What content search is asked to narrow to: the host matches a folder by its path (any
    /// part of a session's folder), so the project's whole path when a session knows it.
    func searchTerm(_ rows: [SessionRow]) -> String {
        rows.first { holds($0) }?.dto.projectPath ?? name
    }
}
