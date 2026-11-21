import Foundation

/// One session's fork family (`ForksDialog` in `../ah/web/ForkDialog.tsx`): the conversation
/// they all grew from, and every line forked from it, so two can be compared or opened side
/// by side.
enum ForkFamily {
    struct Line: Equatable, Sendable, Identifiable {
        /// Nil for a root that has ended (it's in History, not on screen).
        let key: String?
        let uid: String
        let title: String
        let word: StatusWord?
        let branch: String?
        let isRoot: Bool
        let isCurrent: Bool
        var id: String { key ?? "root:\(uid)" }
    }

    /// The root first (live, or ended from History), then its forks in opening order; the
    /// session asked about is marked. Empty for a session with no family.
    static func lines(of row: SessionRow, rows: [SessionRow], history: [HistoryRow]) -> [Line] {
        let rootUid = row.dto.fork?.rootUid ?? row.uid
        let family = rows.filter { $0.host == row.host && ($0.uid == rootUid || $0.dto.fork?.rootUid == rootUid || $0.uid == row.uid) }
        guard family.count > 1 || row.dto.fork != nil else { return [] }
        let line = { (r: SessionRow) in
            Line(key: r.key, uid: r.uid, title: r.title, word: r.word, branch: r.dto.branch, isRoot: r.uid == rootUid, isCurrent: r.key == row.key)
        }
        var out = family.sorted { a, b in
            if (a.uid == rootUid) != (b.uid == rootUid) { return a.uid == rootUid }
            return a.dto.createdAt < b.dto.createdAt
        }.map(line)
        if !family.contains(where: { $0.uid == rootUid }), let ended = history.first(where: { $0.dto.ref == rootUid && $0.host == row.host }) {
            out.insert(Line(key: nil, uid: rootUid, title: ended.dto.title, word: nil, branch: nil, isRoot: true, isCurrent: false), at: 0)
        }
        return out
    }
}
