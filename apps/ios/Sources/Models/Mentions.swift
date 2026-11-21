import Foundation
import Observation

/// "@path" in a message: a file you point the agent at (the @ completion, the Files panel's
/// Mention). Where it names a file that's there, the app draws it as a chip you can open, in
/// the composer and in the transcript (ah's web/mentions.ts, the same rules).
struct Mention: Equatable, Sendable {
    /// Where it is in the text, its @ included, in UTF-16 (what a text view's ranges count).
    let range: NSRange
    /// The path it names, as written.
    let path: String
}

/// Where a session's mentions are looked up: its host's files, and its folder now.
struct MentionLookup: Sendable {
    let files: MentionFiles
    let cwd: @MainActor @Sendable () -> String?

    /// A mention's path on the host, when the session has a folder to read it in.
    @MainActor func resolve(_ path: String) -> String? { cwd().map { Mentions.resolve(path, in: $0) } }
}

enum Mentions {
    /// Where a mention's link points in parsed markdown (`Markdown.linkingMentions`).
    static let scheme = "ah-mention:"

    // After a space or at the start, up to the next space; quotes and backticks end it.
    private static let pattern = try! NSRegularExpression(pattern: "(?<=^|\\s)@([^\\s@`'\"<>]+)")
    // What follows a mention in a sentence, not part of its name: "see @a.md, then".
    private static let trailing = Set(".,;:!?)]}")

    /// Every "@path" in the text.
    static func find(_ text: String) -> [Mention] {
        guard text.contains("@") else { return [] }
        let ns = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            var name = ns.substring(with: match.range(at: 1))
            while let last = name.last, trailing.contains(last) { name.removeLast() }
            guard !name.isEmpty else { return nil }
            return Mention(range: NSRange(location: match.range.location, length: 1 + (name as NSString).length), path: name)
        }
    }

    /// A mention's path on the host: as written when absolute or ~, else in the session's folder.
    static func resolve(_ path: String, in cwd: String) -> String {
        if path.hasPrefix("/") || path == "~" || path.hasPrefix("~/") { return path }
        var rest = Substring(path)
        while rest.hasPrefix("./") { rest = rest.dropFirst(2) }
        var folder = Substring(cwd)
        while folder.count > 1, folder.hasSuffix("/") { folder = folder.dropLast() }
        return folder == "/" ? "/\(rest)" : "\(folder)/\(rest)"
    }

    /// The text without one mention, and one space with it (the one after, or else the one
    /// before: "see @a.md, then" → "see, then"), and where the caret goes (UTF-16).
    static func removing(_ mention: Mention, from text: String) -> (text: String, caret: Int) {
        let ns = text as NSString
        let end = mention.range.location + mention.range.length
        if end < ns.length, ns.character(at: end) == 0x20 {
            return (ns.replacingCharacters(in: NSRange(location: mention.range.location, length: mention.range.length + 1), with: ""), mention.range.location)
        }
        let start = mention.range.location > 0 && ns.character(at: mention.range.location - 1) == 0x20 ? mention.range.location - 1 : mention.range.location
        return (ns.replacingCharacters(in: NSRange(location: start, length: end - start), with: ""), start)
    }

    /// The text with a mention moved to `to` (a UTF-16 offset in the text as it is): taken out
    /// with a space as by its ×, put in with a space each side where it lands; the caret after
    /// it. A drop inside another mention lands at that one's nearer end; on itself, nothing moves.
    static func moving(_ mention: Mention, in text: String, to: Int, others: [Mention] = []) -> (text: String, caret: Int) {
        var to = to
        if let inside = others.first(where: { $0.range.location < to && to < NSMaxRange($0.range) }) {
            to = to - inside.range.location < NSMaxRange(inside.range) - to ? inside.range.location : NSMaxRange(inside.range)
        }
        let end = NSMaxRange(mention.range)
        if to >= mention.range.location && to <= end { return (text, end) }
        let token = (text as NSString).substring(with: mention.range)
        let out = removing(mention, from: text)
        let removed = (text as NSString).length - (out.text as NSString).length
        let at = to > mention.range.location ? max(out.caret, to - removed) : to
        let t = out.text as NSString
        let pad = at > 0 && !(Character(UnicodeScalar(t.character(at: at - 1)) ?? " ").isWhitespace) ? " " : ""
        let after = at < t.length && t.character(at: at) == 0x20 ? "" : " "
        let next = t.substring(to: at) + pad + token + after + t.substring(from: at)
        return (next, at + (pad as NSString).length + (token as NSString).length + 1)
    }

    /// The mention's link target in parsed markdown, and back.
    static func link(_ path: String) -> String { scheme + (path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path) }
    static func path(fromLink url: String) -> String? {
        guard url.hasPrefix(scheme) else { return nil }
        let rest = String(url.dropFirst(scheme.count))
        return rest.removingPercentEncoding ?? rest
    }
}

/// Which mentions name a file that's there, on one host: each folder is listed once (for a
/// little while), and that one listing answers every mention in it. Asked from a view, it
/// answers what it knows now and looks up the rest; views reading it draw again when it knows.
@MainActor
@Observable
final class MentionFiles {
    typealias List = @Sendable (String) async throws -> [FsEntry]

    private struct Folder {
        var at: Date
        var names: Set<String>
    }

    @ObservationIgnored private let list: List
    @ObservationIgnored private let keep: TimeInterval
    @ObservationIgnored private let now: @Sendable () -> Date
    private var folders: [String: Folder] = [:]
    /// Being listed now. Not observed: asking happens while a view draws, which must not change
    /// what it reads; only the answer, when it comes, does.
    @ObservationIgnored private var asking: Set<String> = []

    init(keep: TimeInterval = 20, now: @escaping @Sendable () -> Date = Date.init, list: @escaping List) {
        self.list = list
        self.keep = keep
        self.now = now
    }

    /// Whether `path` (absolute or ~) is a file there: nil until its folder has been listed. An
    /// answer past its time still stands while the folder is listed again.
    func exists(_ path: String) -> Bool? {
        let (dir, name) = Self.split(path)
        guard !name.isEmpty else { return false }
        let folder = folders[dir]
        if folder.map({ now().timeIntervalSince($0.at) >= keep }) ?? true { look(in: dir) }
        return folder?.names.contains(name)
    }

    /// The mentions in `text` that name a file in `cwd`'s reach, leaving out the one starting
    /// at `skip` (the one the @ completion is still on).
    func found(in text: String, cwd: String, skipping skip: Int? = nil) -> [Mention] {
        Mentions.find(text).filter { $0.range.location != skip && exists(Mentions.resolve($0.path, in: cwd)) == true }
    }

    /// Lists a folder once until it answers. One that can't be listed (missing, outside the
    /// browsable roots) has nothing to open; a failed refresh keeps what was known.
    private func look(in dir: String) {
        guard asking.insert(dir).inserted else { return }
        Task { [list, weak self] in
            let names = (try? await list(dir)).map { Set($0.filter { $0.type == .file }.map(\.name)) }
            guard let self else { return }
            self.asking.remove(dir)
            self.folders[dir] = Folder(at: self.now(), names: names ?? self.folders[dir]?.names ?? [])
        }
    }

    private static func split(_ path: String) -> (String, String) {
        guard let slash = path.lastIndex(of: "/") else { return (".", path) }
        let dir = String(path[..<slash])
        return (dir.isEmpty ? "/" : dir, String(path[path.index(after: slash)...]))
    }
}
