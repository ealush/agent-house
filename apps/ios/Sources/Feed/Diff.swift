import Foundation

/// Diff shapes agents produce, normalized to numbered lines (`../ah/web/gui/diff.ts`).
struct DiffLine: Equatable, Sendable, Hashable {
    enum Kind: String, Sendable { case add, del, ctx, hunk, file }
    let kind: Kind
    let text: String
    /// New-file line number for added/context lines, old-file for removed ones, where known.
    let number: Int?
}

enum DiffParser {
    /// Unified diffs: git patches, Codex's `*** Begin Patch`, or bare +/- hunks.
    static func patchLines(_ patch: String) -> [DiffLine] {
        var out: [DiffLine] = []
        var oldN = 0
        var newN = 0
        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if let file = fileName(raw) {
                out.append(DiffLine(kind: .file, text: file, number: nil))
            } else if isPreamble(raw) {
                continue
            } else if raw.hasPrefix("@@") {
                let numbers = hunkStarts(raw)
                oldN = numbers.old
                newN = numbers.new
                let label = hunkLabel(raw)
                out.append(DiffLine(kind: .hunk, text: label.isEmpty ? "…" : "… \(label)", number: nil))
            } else if raw.hasPrefix("+") {
                out.append(DiffLine(kind: .add, text: String(raw.dropFirst()), number: newN != 0 ? newN : nil))
                if newN != 0 { newN += 1 }
            } else if raw.hasPrefix("-") {
                out.append(DiffLine(kind: .del, text: String(raw.dropFirst()), number: oldN != 0 ? oldN : nil))
                if oldN != 0 { oldN += 1 }
            } else if raw.hasPrefix(" ") {
                out.append(DiffLine(kind: .ctx, text: String(raw.dropFirst()), number: newN != 0 ? newN : nil))
                if newN != 0 { newN += 1 }
                if oldN != 0 { oldN += 1 }
            }
        }
        return out
    }

    private static func fileName(_ raw: String) -> String? {
        for prefix in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] where raw.hasPrefix(prefix) {
            return String(raw.dropFirst(prefix.count))
        }
        if raw.hasPrefix("+++ ") {
            var name = String(raw.dropFirst(4))
            if name.hasPrefix("b/") { name.removeFirst(2) }
            return name
        }
        return nil
    }

    private static func isPreamble(_ raw: String) -> Bool {
        ["diff --git ", "index ", "--- ", "*** Begin Patch", "*** End Patch", "new file", "deleted file", "*** Move to"].contains { raw.hasPrefix($0) }
    }

    /// `@@ -12,3 +14,5 @@` → (12, 14); zeros when absent.
    private static func hunkStarts(_ raw: String) -> (old: Int, new: Int) {
        let scalars = Array(raw)
        func number(after marker: Character) -> Int {
            guard let index = scalars.firstIndex(of: marker) else { return 0 }
            var digits = ""
            for c in scalars[(index + 1)...] { if c.isNumber { digits.append(c) } else { break } }
            return Int(digits) ?? 0
        }
        guard raw.contains(" -") else { return (0, 0) }
        let old = number(after: "-")
        guard let plus = raw.range(of: " +") else { return (old, 0) }
        let digits = raw[plus.upperBound...].prefix { $0.isNumber }
        return (old, Int(digits) ?? 0)
    }

    private static func hunkLabel(_ raw: String) -> String {
        let body = raw.dropFirst(2)
        if let end = body.range(of: "@@") {
            return String(body[end.upperBound...]).trimmingLeadingWhitespace()
        }
        return String(body).trimmingLeadingWhitespace()
    }

    /// Claude's `structuredPatch`: hunks with start lines and prefixed lines.
    static func structuredLines(_ hunks: JSONValue?) -> [DiffLine]? {
        guard let hunks = hunks?.array, !hunks.isEmpty else { return nil }
        var out: [DiffLine] = []
        for hunk in hunks {
            guard let lines = hunk["lines"]?.array else { return nil }
            var n = Int(hunk["newStart"]?.number ?? 0)
            var o = Int(hunk["oldStart"]?.number ?? 0)
            out.append(DiffLine(kind: .hunk, text: "…", number: nil))
            for line in lines.compactMap(\.string) {
                if line.hasPrefix("+") {
                    out.append(DiffLine(kind: .add, text: String(line.dropFirst()), number: n))
                    n += 1
                } else if line.hasPrefix("-") {
                    out.append(DiffLine(kind: .del, text: String(line.dropFirst()), number: o))
                    o += 1
                } else {
                    out.append(DiffLine(kind: .ctx, text: String(line.dropFirst()), number: n))
                    n += 1
                    o += 1
                }
            }
        }
        return out
    }

    /// An edit's old and new text as a line diff (LCS), falling back to remove-all/add-all past a size bound.
    static func replaceLines(before: String, after: String) -> [DiffLine] {
        let a = before.isEmpty ? [] : before.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let b = after.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let del = { (text: String) in DiffLine(kind: .del, text: text, number: nil) }
        let add = { (text: String) in DiffLine(kind: .add, text: text, number: nil) }
        if a.count * b.count > 250_000 { return a.map(del) + b.map(add) }
        var lcs = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        if !a.isEmpty && !b.isEmpty {
            for i in stride(from: a.count - 1, through: 0, by: -1) {
                for j in stride(from: b.count - 1, through: 0, by: -1) {
                    lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
                }
            }
        }
        var out: [DiffLine] = []
        var i = 0
        var j = 0
        while i < a.count && j < b.count {
            if a[i] == b[j] {
                out.append(DiffLine(kind: .ctx, text: a[i], number: nil))
                i += 1
                j += 1
            } else if lcs[i + 1][j] >= lcs[i][j + 1] {
                out.append(del(a[i]))
                i += 1
            } else {
                out.append(add(b[j]))
                j += 1
            }
        }
        while i < a.count { out.append(del(a[i])); i += 1 }
        while j < b.count { out.append(add(b[j])); j += 1 }
        return out
    }
}

/// A git working-tree patch split into files, for the Diff panel and anchored comments.
struct FileDiff: Equatable, Sendable, Identifiable {
    var id: String { path }
    let path: String
    let lines: [DiffLine]
    /// Counted once, when the file is made: a header that shows them is drawn far more often.
    let additions: Int
    let deletions: Int

    init(path: String, lines: [DiffLine]) {
        self.path = path
        self.lines = lines
        additions = lines.count { $0.kind == .add }
        deletions = lines.count { $0.kind == .del }
    }

    /// Splits `git diff` output at each `diff --git` header.
    static func files(in patch: String) -> [FileDiff] {
        var out: [FileDiff] = []
        var current: [String] = []
        var path: String?
        func flush() {
            guard let path else { return }
            out.append(FileDiff(path: path, lines: DiffParser.patchLines(current.joined(separator: "\n")).filter { $0.kind != .file }))
        }
        for line in patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.hasPrefix("diff --git ") {
                flush()
                current = []
                path = line.components(separatedBy: " b/").last ?? line
            }
            current.append(line)
        }
        flush()
        if out.isEmpty && !patch.isEmpty {
            let lines = DiffParser.patchLines(patch)
            let name = lines.first { $0.kind == .file }?.text ?? "changes"
            out.append(FileDiff(path: name, lines: lines.filter { $0.kind != .file }))
        }
        return out
    }
}

/// Walking a diff's commentable lines by keyboard (`web/Git.tsx`'s roving lines): every
/// added, removed and context line across the files, in order; hunk and file headers are
/// skipped. ↑↓ (or k/j) move and stop at the ends, Home/End jump, nothing is chosen until
/// the first move.
struct DiffCursor: Equatable, Sendable {
    struct Position: Hashable, Sendable {
        let file: Int
        let line: Int
    }

    private(set) var positions: [Position]
    private(set) var index: Int?

    init(files: [[DiffLine]], maxLines: Int? = nil) {
        positions = files.enumerated().flatMap { file, lines in
            lines.prefix(maxLines ?? lines.count).enumerated().compactMap { line, diff in
                diff.kind == .hunk || diff.kind == .file ? nil : Position(file: file, line: line)
            }
        }
    }

    var current: Position? { index.map { positions[$0] } }

    mutating func move(_ step: Int) {
        guard !positions.isEmpty else { return }
        guard let index else {
            self.index = step >= 0 ? 0 : positions.count - 1
            return
        }
        self.index = min(positions.count - 1, max(0, index + step))
    }

    mutating func home() { if !positions.isEmpty { index = 0 } }
    mutating func end() { if !positions.isEmpty { index = positions.count - 1 } }
    mutating func clear() { index = nil }

    /// The diff changed (a poll): keep the cursor on the same place when it still exists.
    mutating func update(files: [[DiffLine]], maxLines: Int? = nil) {
        let kept = current
        self = DiffCursor(files: files, maxLines: maxLines)
        if let kept, let i = positions.firstIndex(of: kept) { index = i }
    }
}
