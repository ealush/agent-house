import Foundation

/// An attachment in a message's text: a chip where it was put ("@paste.png", its token), its
/// path put in that place when the message goes (ah's web/uploads.ts and attachmentText.ts).
extension Uploads {
    /// The name an attachment goes by in the text: its file's name without what would end a
    /// mention (spaces, quotes), numbered when `taken` has it.
    static func token(_ name: String, taken: inout Set<String>) -> String {
        var clean = name.replacingOccurrences(of: "[\\s@`'\"<>]+", with: "-", options: .regularExpression)
        while clean.hasPrefix("-") { clean.removeFirst() }
        while clean.hasSuffix("-") { clean.removeLast() }
        if clean.isEmpty { clean = "file" }
        let dot = clean.lastIndex(of: ".").flatMap { $0 > clean.startIndex ? $0 : nil }
        let base = dot.map { String(clean[..<$0]) } ?? clean
        let ext = dot.map { String(clean[$0...]) } ?? ""
        var token = clean
        var n = 2
        while taken.contains(token) {
            token = "\(base)-\(n)\(ext)"
            n += 1
        }
        taken.insert(token)
        return token
    }

    struct Placed: Equatable, Sendable {
        let upload: Upload
        let token: String
    }

    /// The uploads a message carries, each where it is in the text: its path there replaced by
    /// its token. `taken`: tokens already in use (the box's other attachments).
    static func place(_ text: String, taken: Set<String> = []) -> (uploads: [Placed], text: String) {
        var taken = taken
        var uploads: [Placed] = []
        var out = ""
        var scanner = text[...]
        while !scanner.isEmpty {
            let space = scanner.prefix { $0 == " " || $0 == "\t" || $0 == "\n" }
            if !space.isEmpty {
                out += space
                scanner = scanner.dropFirst(space.count)
                continue
            }
            var word: Substring
            var path: String?
            if scanner.first == "'", let close = scanner.dropFirst().firstIndex(of: "'") {
                word = scanner[...close]
                let inner = String(scanner[scanner.index(after: scanner.startIndex)..<close])
                if isUpload(inner) { path = inner }
            } else {
                word = scanner.prefix { !($0 == " " || $0 == "\t" || $0 == "\n") }
                if isUpload(String(word)) { path = String(word) }
            }
            if let path, let upload = split(path.contains(" ") ? "'\(path)'" : path).uploads.first {
                let token = token(upload.name, taken: &taken)
                uploads.append(Placed(upload: upload, token: token))
                out += "@\(token)"
            } else {
                out += word
            }
            scanner = scanner.dropFirst(word.count)
        }
        return (uploads, uploads.isEmpty ? text : out)
    }

    /// The message as sent: each file's path where its chip is (the first "@token" of each),
    /// the rest in front of the text. `files` in the order they were attached.
    static func placing(_ files: [(token: String?, path: String)], in text: String) -> String {
        var found: [(Mention, String)] = []
        var seen = Set<String>()
        for mention in Mentions.find(text) {
            guard !seen.contains(mention.path), let file = files.first(where: { $0.token == mention.path }) else { continue }
            seen.insert(mention.path)
            found.append((mention, file.path))
        }
        var out = text as NSString
        for (mention, path) in found.sorted(by: { $0.0.range.location > $1.0.range.location }) {
            out = out.replacingCharacters(in: mention.range, with: shellQuote(path)) as NSString
        }
        let front = files.filter { file in !found.contains { $0.1 == file.path && file.token != nil } }.map { shellQuote($0.path) }
        let words = (out as String).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : out as String
        return (front + [words]).filter { !$0.isEmpty }.joined(separator: " ")
    }
}

extension Attachment {
    /// A message's attachments (as `of`), and its words with each upload as its token where it
    /// was, with what each token opens; no words when there's nothing but the files.
    static func placed(_ text: String, media: [FeedPart] = []) -> (attachments: [Attachment], rest: String, uploads: [String: String]) {
        let (all, _) = of(text, media: media)
        let placed = Uploads.place(text)
        guard !placed.uploads.isEmpty else { return (all, text, [:]) }
        let tokens = Set(placed.uploads.map { "@\($0.token)" })
        let words = placed.text.split(whereSeparator: \.isWhitespace).contains { !tokens.contains(String($0)) }
        return (all, words ? placed.text.trimmingCharacters(in: .whitespacesAndNewlines) : "", Dictionary(placed.uploads.map { ($0.token, $0.upload.path) }, uniquingKeysWith: { a, _ in a }))
    }
}
