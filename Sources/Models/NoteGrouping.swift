import Foundation

/// Where notes go in the session list: under the block of the project they're filed under,
/// beside its sessions, as if they were in its folder; a project with no session running gets
/// a block of its own; notes filed nowhere are together at the end. A project is a host and a
/// folder, so one folder name on two machines is two places.
enum NoteGrouping {
    struct Group: Equatable, Sendable {
        let id: String
        let title: String
        let notes: [NotesModel.Summary]
    }

    struct Placement: Equatable, Sendable {
        /// Notes for blocks the list already has, by block id.
        var inSections: [String: [NotesModel.Summary]] = [:]
        /// Blocks of notes only, after the sessions'.
        var groups: [Group] = []
    }

    static let unfiled = "notes:"

    static func place(_ notes: [NotesModel.Summary], sections: [SessionOrdering.Section], multiHost: Bool) -> Placement {
        var out = Placement()
        var extra: [String: (title: String, notes: [NotesModel.Summary])] = [:]
        var order: [String] = []
        func add(_ id: String, _ title: String, _ note: NotesModel.Summary) {
            if extra[id] == nil { extra[id] = (title, []); order.append(id) }
            extra[id]!.notes.append(note)
        }
        let recent = sections.count == 1 && sections[0].id == SessionOrdering.recentSection
        for note in notes {
            guard let project = note.project, !recent else {
                add(unfiled, "Notes", note)
                continue
            }
            let home = sections.first { section in
                multiHost ? section.id == project.host : section.rows.contains { $0.host == project.host && $0.dto.projectPath == project.path }
            }
            if let home {
                out.inSections[home.id, default: []].append(note)
            } else if multiHost {
                add("notes:host:\(project.host)", project.host, note)
            } else {
                add("notes:\(project.host):\(project.path)", project.name, note)
            }
        }
        // Projects first (in the order their notes are newest), the unfiled block last.
        out.groups = order.filter { $0 != unfiled }.map { Group(id: $0, title: extra[$0]!.title, notes: extra[$0]!.notes) }
        if let loose = extra[unfiled] { out.groups.append(Group(id: unfiled, title: loose.title, notes: loose.notes)) }
        return out
    }
}
