import Foundation

/// The one set of words for what a session is doing, wherever it shows (`../ah/web/status.ts`):
/// Inbox rows and sections, headers, notifications. The server decides the status; this
/// only names it.
enum StatusWord: String, CaseIterable, Sendable {
    case needsYou = "needs you"
    case working
    case limited
    case done
    case newOutput = "new output"
    case idle

    /// Worth words where room is short (the sidebar): it can't go on without you. The rest
    /// read from the dot's color.
    var asksForAttention: Bool { self == .needsYou || self == .limited }

    init(status: SessionDTO.Status, agent: String?, limit: String?) {
        // Stopped on the plan's usage limit is neither done nor idle: it can't go on yet.
        if let limit, !limit.isEmpty, status != .busy && status != .waiting {
            self = .limited
            return
        }
        switch status {
        case .waiting: self = .needsYou
        case .busy: self = .working
        case .attention: self = agent == nil ? .newOutput : .done
        case .idle: self = .idle
        }
    }

    init(_ session: SessionDTO) {
        self.init(status: session.status, agent: session.agent, limit: session.limit)
    }

    /// Inbox order: what needs you first.
    var rank: Int {
        switch self {
        case .needsYou: return 0
        case .working: return 1
        case .limited: return 2
        case .done: return 3
        case .newOutput: return 4
        case .idle: return 5
        }
    }

    /// "1 session needs you. 3 working. 1 done." or "All quiet."
    static func summary<S: Sequence>(_ words: S) -> String where S.Element == StatusWord {
        var counts: [StatusWord: Int] = [:]
        for word in words { counts[word, default: 0] += 1 }
        var parts: [String] = []
        if let waiting = counts[.needsYou], waiting > 0 {
            parts.append("\(waiting) session\(waiting == 1 ? " needs" : "s need") you")
        }
        for word in [StatusWord.working, .limited, .done, .newOutput, .idle] {
            if let n = counts[word], n > 0 { parts.append("\(n) \(word.rawValue)") }
        }
        return parts.isEmpty ? "All quiet." : parts.joined(separator: ". ") + "."
    }
}

/// A session's place across hosts: its uid on the hub, "<host>/<uid>" on a peer.
/// The same key the web uses for selection, focus/handoff and workspace layouts.
struct SessionKey: Hashable, Codable, Sendable, CustomStringConvertible {
    let host: String?
    let uid: String

    init(host: String?, uid: String) {
        self.host = host
        self.uid = uid
    }

    /// Parses "uid" or "host/uid"; nil for a malformed or legacy window-id key.
    init?(_ raw: String) {
        if let slash = raw.lastIndex(of: "/") {
            let host = String(raw[..<slash])
            let uid = String(raw[raw.index(after: slash)...])
            guard Self.validHost(host), Self.validUID(uid) else { return nil }
            self.init(host: host, uid: uid)
        } else {
            guard Self.validUID(raw) else { return nil }
            self.init(host: nil, uid: raw)
        }
    }

    var description: String { host.map { "\($0)/\(uid)" } ?? uid }

    /// A legacy tmux-window key ("@12", "mac/@12"): upgraded once windows are known.
    static func isLegacy(_ raw: String) -> Bool {
        let tail = raw.split(separator: "/").last.map(String.init) ?? raw
        return tail.hasPrefix("@") && tail.dropFirst().allSatisfy(\.isNumber) && tail.count > 1
    }

    private static func validUID(_ s: String) -> Bool {
        (1...40).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    private static func validHost(_ s: String) -> Bool {
        (1...64).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" || $0 == ".") }
    }
}

/// Files attached from the composer reach the agent as paths in ah's upload folder;
/// wherever ah shows that message back, they read as attachments (`../ah/web/uploads.ts`).
enum Uploads {
    struct Upload: Equatable, Sendable, Hashable {
        let path: String
        let name: String
        let image: Bool
    }

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif"]

    static func split(_ text: String) -> (uploads: [Upload], rest: String) {
        var uploads: [Upload] = []
        var kept: [String] = []
        // Tokens separated by whitespace; a quoted upload path may hold spaces.
        var scanner = text[...]
        var leading = true
        while !scanner.isEmpty {
            let space = scanner.prefix { $0 == " " || $0 == "\t" || $0 == "\n" }
            if !space.isEmpty {
                kept.append(String(space))
                scanner = scanner.dropFirst(space.count)
                continue
            }
            var token: Substring
            var path: String?
            if scanner.first == "'", let close = scanner.dropFirst().firstIndex(of: "'") {
                token = scanner[...close]
                let inner = String(scanner[scanner.index(after: scanner.startIndex)..<close])
                if isUploadPath(inner) { path = inner }
            } else {
                token = scanner.prefix { !($0 == " " || $0 == "\t" || $0 == "\n") }
                if isUploadPath(String(token)) { path = String(token) }
            }
            if let path {
                let file = path.split(separator: "/").last.map(String.init) ?? path
                uploads.append(Upload(path: path, name: stripTimestamp(file), image: imageExtensions.contains(file.split(separator: ".").last.map { $0.lowercased() } ?? "")))
            } else {
                kept.append(String(token))
            }
            scanner = scanner.dropFirst(token.count)
            leading = false
        }
        _ = leading
        guard !uploads.isEmpty else { return ([], text) }
        let rest = kept.joined()
            .replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (uploads, rest)
    }

    /// "2 images · what is in these?".
    static func summary(_ text: String) -> String {
        let (uploads, rest) = split(text)
        guard !uploads.isEmpty else { return text }
        let images = uploads.count { $0.image }
        let files = uploads.count - images
        func count(_ n: Int, _ one: String) -> String? { n > 0 ? "\(n) \(one)\(n == 1 ? "" : "s")" : nil }
        let label = [count(images, "image"), count(files, "file")].compactMap { $0 }.joined(separator: ", ")
        return rest.isEmpty ? label : "\(label) · \(rest)"
    }

    private static func isUploadPath(_ s: String) -> Bool {
        guard s.hasPrefix("/"), let range = s.range(of: "/ah/uploads/") else { return false }
        let name = s[range.upperBound...]
        return !name.isEmpty && !name.contains("/")
    }

    /// Saved as "<ISO timestamp>-<name>": show the name you gave it.
    private static func stripTimestamp(_ file: String) -> String {
        let pattern = "^\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z-"
        guard let range = file.range(of: pattern, options: .regularExpression) else { return file }
        return String(file[range.upperBound...])
    }

    /// How a path goes into a prompt: shell-quoted when it needs it (`web/api.ts shellQuote`).
    static func shellQuote(_ path: String) -> String {
        let safe = path.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "_@%+=:,./-".contains($0)) }
        return safe && !path.isEmpty ? path : "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
