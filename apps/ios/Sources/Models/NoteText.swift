import Foundation

/// A note's files (docs/spec/15-scratchpads.md, SCR-7; ah's web/noteText.ts, the same rules). A
/// note keeps each file it carries as its path in ah's upload folder, as a sent message carries
/// it, so handing the note to an agent or saving it as a file needs nothing more. Its box shows
/// each as its token instead ("@paste.png"), a tile and a chip, and puts the path back on every
/// change.
enum NoteText {
    // An upload's path standing alone, as words do: what ends a sentence after it isn't part of it.
    private static let upload = try! NSRegularExpression(pattern: "(?<=^|\\s)(?:'([^'\\n]*/ah/uploads/[^'/\\n]+)'|(/[^\\s'\"`<>]*/ah/uploads/[\\w.-]+?))(?=[.,;:!?)\\]}]*(?:\\s|$))")

    /// The note's text as its box shows it: each upload's path as "@<token>", and the uploads in
    /// the order they're written. `known` (path → token) keeps a chip's name while the note is
    /// open, so taking out one "paste.png" doesn't rename the next; new ones are added to it.
    /// `taken`: tokens already used (files still on their way).
    static func shown(_ markdown: String, known: inout [String: String], taken: some Sequence<String> = [String]()) -> (text: String, uploads: [Uploads.Placed]) {
        let ns = markdown as NSString
        let found: [(range: NSRange, upload: Uploads.Upload)] = upload.matches(in: markdown, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            let group = match.range(at: 1).location != NSNotFound ? match.range(at: 1) : match.range(at: 2)
            let path = ns.substring(with: group)
            guard let file = Uploads.split(path.contains(" ") ? "'\(path)'" : path).uploads.first else { return nil }
            return (match.range, file)
        }
        guard !found.isEmpty else { return (markdown, []) }
        var used = Set(taken)
        // Tokens kept from before first, so a chip keeps its name when another is taken out.
        var tokens: [String?] = found.map { f in
            guard let kept = known[f.upload.path], used.insert(kept).inserted else { return nil }
            return kept
        }
        for (i, f) in found.enumerated() where tokens[i] == nil {
            let token = Uploads.token(f.upload.name, taken: &used)
            tokens[i] = token
            if known[f.upload.path] == nil { known[f.upload.path] = token }
        }
        var text = ""
        var at = 0
        var uploads: [Uploads.Placed] = []
        for (i, f) in found.enumerated() {
            text += ns.substring(with: NSRange(location: at, length: f.range.location - at)) + "@" + tokens[i]!
            at = NSMaxRange(f.range)
            uploads.append(Uploads.Placed(upload: f.upload, token: tokens[i]!))
        }
        return (text + ns.substring(from: at), uploads)
    }

    /// The note's Markdown from its box's text: each upload's token (the first "@<token>" of
    /// each, as a message's) put back as its path. `paths`: token → path (`tokenPaths`).
    static func markdown(_ text: String, paths: [String: String]) -> String {
        guard !paths.isEmpty else { return text }
        var seen = Set<String>()
        let found = Mentions.find(text).filter { paths[$0.path] != nil && seen.insert($0.path).inserted }
        var out = text as NSString
        for m in found.reversed() { out = out.replacingCharacters(in: m.range, with: Uploads.shellQuote(paths[m.path]!)) as NSString }
        return out as String
    }

    /// Token → path for `markdown`: what `known` named before, then the box's files (each up
    /// one's path; one still on its way stays its token, as written).
    static func tokenPaths(_ known: [String: String], files: [(token: String?, path: String?)]) -> [String: String] {
        var paths: [String: String] = [:]
        for (path, token) in known.sorted(by: { $0.key < $1.key }) { paths[token] = path }
        for file in files {
            guard let token = file.token else { continue }
            paths[token] = file.path
        }
        return paths
    }
}
