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

extension Uploads {
    /// "[Image #3]": where the agent's terminal (Claude Code, Codex) put a picture it took out
    /// of the words, its path gone. Each is a token for one of the message's `count` pictures,
    /// in the order they're named (the number counts the conversation's pictures, not this
    /// message's): "@Picture" for one, "@Picture-1", "@Picture-2" … for several. `tokens[k]`
    /// is the k-th picture's.
    static func namingPictures(_ text: String, count: Int) -> (text: String, tokens: [String]) {
        guard count > 0, text.contains("[Image #") else { return (text, []) }
        let ns = text as NSString
        let found = picturePattern.matches(in: text, range: NSRange(location: 0, length: ns.length))
        var tokens: [String] = []
        var out = ""
        var at = 0
        for match in found where tokens.count < count {
            let r = match.range
            out += ns.substring(with: NSRange(location: at, length: r.location - at))
            // A token stands apart from what's around it ("[Image #3]/home/…" came glued).
            let token = count == 1 ? "Picture" : "Picture-\(tokens.count + 1)"
            tokens.append(token)
            let before = r.location > 0 && !(ns.substring(with: NSRange(location: r.location - 1, length: 1)).first?.isWhitespace ?? true) ? " " : ""
            let next = r.location + r.length
            let after = next < ns.length && !(ns.substring(with: NSRange(location: next, length: 1)).first?.isWhitespace ?? true) ? " " : ""
            out += before + "@" + token + after
            at = next
        }
        out += ns.substring(from: at)
        return (out, tokens)
    }

    private static let picturePattern = try! NSRegularExpression(pattern: "\\[Image #\\d+\\]")
}

extension Attachment {
    /// What a picture's chip opens: its place among the message's pictures and films, as a
    /// link of its own (a `data:` picture is too long for one).
    static func mark(_ place: Int) -> String { "ah-picture:\(place)" }
    static func place(fromMark mark: String) -> Int? {
        mark.hasPrefix("ah-picture:") ? Int(mark.dropFirst("ah-picture:".count)) : nil
    }

    /// A message's attachments (as `of`), and its words with each upload as its token where it
    /// was, and each picture the agent took out ("[Image #1]") as its own, with what each token
    /// opens (a path, or a picture's `mark`); no words when there's nothing but the files.
    static func placed(_ text: String, media: [FeedPart] = []) -> (attachments: [Attachment], rest: String, uploads: [String: String]) {
        let pictures = media.count { if case .media = $0 { true } else { false } }
        let named = Uploads.namingPictures(text, count: pictures)
        let (all, _) = of(named.text, media: media)
        let placed = Uploads.place(named.text, taken: Set(named.tokens))
        guard !placed.uploads.isEmpty || !named.tokens.isEmpty else { return (all, text, [:]) }
        // The message's own pictures come after its uploads, among the ones that open together.
        let first = placed.uploads.map { Attachment.upload($0.upload) }.count { $0.look != .file }
        var opens = Dictionary(placed.uploads.map { ($0.token, $0.upload.path) }, uniquingKeysWith: { a, _ in a })
        for (k, token) in named.tokens.enumerated() { opens[token] = mark(first + k) }
        let tokens = Set(opens.keys.map { "@\($0)" })
        let words = placed.text.split(whereSeparator: \.isWhitespace).contains { !tokens.contains(String($0)) }
        return (all, words ? placed.text.trimmingCharacters(in: .whitespacesAndNewlines) : "", opens)
    }
}
