import Foundation

/// This device's developer log (Settings → System → Developer): what the app did, kept on
/// the device until you send a stretch of it to the host as a bundle for an agent to read
/// (`POST /api/system/logging/client`, saved beside the host's own log), or share it as a
/// file. Off until turned on. Kept: the last three days, at most `maxEntries`.
///
/// In it: messages sent (their words, capped, and their attachments' sizes, never their
/// bytes), every request (method, path, status, time, or why it failed), uploads' sizes, the
/// live state stream and terminals connecting and dropping, the app going to the background
/// and back. Never the bearer, cookies or setup codes: a query's secrets are redacted as the
/// host redacts them.
final class ClientLog: @unchecked Sendable {
    /// One thing that happened: when, what kind, and its details, as one flat JSON object.
    struct Entry: Equatable, Sendable {
        var at: Date
        var kind: String
        var fields: [String: JSONValue]

        var json: [String: JSONValue] {
            var object = fields
            object["at"] = .string(ClientLog.iso(at))
            object["kind"] = .string(kind)
            return object
        }

        init(at: Date, kind: String, fields: [String: JSONValue] = [:]) {
            self.at = at
            self.kind = kind
            self.fields = fields
        }

        init?(json: [String: JSONValue]) {
            guard let at = json["at"]?.string.flatMap(ClientLog.date), let kind = json["kind"]?.string else { return nil }
            var fields = json
            fields["at"] = nil
            fields["kind"] = nil
            self.init(at: at, kind: kind, fields: fields)
        }
    }

    /// The bundle's sender, as the host files it.
    struct Sender: Encodable, Sendable {
        var app = "ios"
        var device: String
        var version: String
        var build: String
        var os: String
    }

    static let shared = ClientLog()
    static let keep: TimeInterval = 3 * 24 * 3600
    static let maxEntries = 5000
    /// A sent message's words are kept up to this many characters, as the host keeps them.
    static let textKeep = 2000
    /// The bundle route itself: sending the log isn't something to log.
    static let bundlePath = "/api/system/logging/client"
    private static let onKey = "ah.clientLog"

    private let lock = NSLock()
    private var on: Bool
    private var entries: [Entry]
    /// Uploaded path → its size in bytes, so a message naming it says how big it was.
    private var sizes: [String: Int] = [:]
    private var saveQueued = false
    private let file: URL?
    private let defaults: UserDefaults?
    private let now: @Sendable () -> Date

    /// `file`/`defaults` nil: kept in memory only, and off unless turned on (tests).
    init(file: URL? = ClientLog.defaultFile, defaults: UserDefaults? = .standard, now: @escaping @Sendable () -> Date = Date.init) {
        self.file = file
        self.defaults = defaults
        self.now = now
        on = defaults?.bool(forKey: Self.onKey) ?? false
        entries = file.map { Self.read($0) } ?? []
    }

    static var defaultFile: URL? {
        try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("ClientLog", isDirectory: true)
            .appendingPathComponent("log.jsonl")
    }

    // MARK: Writing

    var isOn: Bool { lock.withLock { on } }

    /// Turn this device's log on or off. Off keeps what's there until cleared.
    func set(_ next: Bool) {
        if !next { event("logging", ["on": .bool(false)]) }
        lock.withLock { on = next }
        defaults?.set(next, forKey: Self.onKey)
        if next { event("logging", ["on": .bool(true)]) }
        save()
    }

    /// One thing that happened. Nothing happens while the log is off.
    func event(_ kind: String, _ fields: [String: JSONValue] = [:]) {
        let queue: Bool = lock.withLock {
            guard on else { return false }
            entries.append(Entry(at: now(), kind: kind, fields: fields))
            if entries.count > Self.maxEntries + 500 { entries.removeFirst(entries.count - Self.maxEntries) }
            defer { saveQueued = true }
            return !saveQueued
        }
        if queue, file != nil {
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) { [weak self] in self?.save() }
        }
    }

    /// A file this device uploaded, so a message naming its path says how big it was.
    func uploaded(path: String, bytes: Int, name: String) {
        guard isOn else { return }
        lock.withLock { sizes[path] = bytes }
        event("upload", ["bytes": .number(Double(bytes)), "ext": .string(Self.ext(name))])
    }

    /// A request answered or failed. `status` nil: no answer came.
    func request(_ request: URLRequest, status: Int?, started: ContinuousClock.Instant, error: APIError?) {
        guard isOn, let url = request.url else { return }
        let path = Self.redacted(url)
        if path.hasSuffix(Self.bundlePath) { return }
        var fields: [String: JSONValue] = [
            "method": .string(request.httpMethod ?? "GET"),
            "path": .string(path),
            "ms": .number(Self.ms(since: started)),
        ]
        if let status { fields["status"] = .number(Double(status)) }
        if let bytes = request.httpBody?.count, bytes > 0 { fields["bytesOut"] = .number(Double(bytes)) }
        switch error {
        case nil: break
        case .cancelled?: fields["aborted"] = .bool(true)
        case let error?: fields["error"] = .string(error.message)
        }
        event(status == nil && error != .cancelled ? "network-error" : "request", fields)
    }

    /// A message sent, and how it went.
    func sent(ref: String, text: String, enter: Bool, outcome: String, extra: [String: JSONValue] = [:]) {
        guard isOn else { return }
        let known = lock.withLock { sizes }
        var fields = Self.messageDetail(text, sizes: known).merging(extra) { _, new in new }
        fields["ref"] = .string(ref)
        fields["enter"] = .bool(enter)
        fields["outcome"] = .string(outcome)
        event("send", fields)
    }

    // MARK: Reading

    /// What's kept, or just what falls between `from` and `to`, oldest first.
    func entries(from: Date? = nil, to: Date? = nil) -> [Entry] {
        let all = lock.withLock { Self.kept(entries, now: now()) }
        return Self.within(all, from: from, to: to)
    }

    func clear() {
        lock.withLock {
            entries = []
            sizes = [:]
        }
        save()
    }

    /// Written to disk now: the last three days, the newest `maxEntries`.
    func save() {
        let snapshot: [Entry] = lock.withLock {
            saveQueued = false
            entries = Self.kept(entries, now: now())
            return entries
        }
        guard let file else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Self.jsonl(snapshot.map(\.json)).write(to: file, options: .atomic)
    }

    // MARK: Pure parts

    /// Entries still kept at `now`: the last three days, the newest `max`.
    static func kept(_ list: [Entry], now: Date, max: Int = maxEntries) -> [Entry] {
        let from = now.addingTimeInterval(-keep)
        return Array(list.filter { $0.at >= from }.suffix(max))
    }

    /// The entries between `from` and `to` (either open).
    static func within(_ list: [Entry], from: Date?, to: Date?) -> [Entry] {
        list.filter { entry in (from.map { entry.at >= $0 } ?? true) && (to.map { entry.at <= $0 } ?? true) }
    }

    /// One JSON object a line.
    static func jsonl(_ objects: [[String: JSONValue]]) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var out = Data()
        for object in objects {
            guard let line = try? encoder.encode(object) else { continue }
            out.append(line)
            out.append(0x0A)
        }
        return out
    }

    /// A bundle as the host keeps one, for sharing as a file: a header line, then an entry a line.
    static func bundleFile(_ list: [Entry], sender: Sender, note: String, from: Date?, to: Date?) -> Data {
        var header: [String: JSONValue] = [
            "kind": .string("bundle"), "app": .string(sender.app), "device": .string(sender.device), "version": .string(sender.version),
            "build": .string(sender.build), "os": .string(sender.os), "entries": .number(Double(list.count)),
        ]
        if !note.isEmpty { header["note"] = .string(note) }
        if let from { header["from"] = .string(iso(from)) }
        if let to { header["to"] = .string(iso(to)) }
        return jsonl([header] + list.map(\.json))
    }

    private static let secretParam = try! NSRegularExpression(pattern: "token|code|secret|key|password|auth|sig|cookie", options: [.caseInsensitive])

    /// A URL as the log keeps it: path and query, secret-looking values replaced.
    static func redacted(_ url: URL) -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.path }
        let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        guard let items = parts.queryItems, !items.isEmpty else { return path }
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?/"))
        let query = items.map { item -> String in
            let name = item.name.addingPercentEncoding(withAllowedCharacters: allowed) ?? item.name
            let secret = secretParam.firstMatch(in: item.name, range: NSRange(item.name.startIndex..., in: item.name)) != nil
            let value = secret ? "…" : String((item.value ?? "").prefix(200)).addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
            return "\(name)=\(value)"
        }
        return "\(path)?\(query.joined(separator: "&"))"
    }

    private static let filePath = try! NSRegularExpression(pattern: #"(?:^|\s)((?:~|/)[^\s'"`]+\.\w{1,8})(?=[\s'"`]|$)"#)

    /// A message as the log keeps it: length, words up to `textKeep`, the files it names with
    /// the sizes this device sent them at (never their bytes).
    static func messageDetail(_ text: String, sizes: [String: Int]) -> [String: JSONValue] {
        var fields: [String: JSONValue] = [
            "chars": .number(Double(text.utf16.count)),
            "text": .string(text.count > textKeep ? String(text.prefix(textKeep)) + "…" : text),
        ]
        let matches = filePath.matches(in: text, range: NSRange(text.startIndex..., in: text)).prefix(20)
        let files: [JSONValue] = matches.compactMap { match in
            guard let range = Range(match.range(at: 1), in: text) else { return nil }
            let path = String(text[range])
            return .object(["ext": .string(ext(path)), "bytes": sizes[path].map { .number(Double($0)) } ?? .null])
        }
        if !files.isEmpty {
            fields["attachments"] = .array(files)
            fields["attachmentBytes"] = .number(Double(matches.compactMap { m in Range(m.range(at: 1), in: text).flatMap { sizes[String(text[$0])] } }.reduce(0, +)))
        }
        return fields
    }

    static func ext(_ name: String) -> String {
        let e = (name as NSString).pathExtension.lowercased()
        return e.count <= 8 ? e : ""
    }

    static func iso(_ date: Date) -> String { date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }
    static func date(_ text: String) -> Date? { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) }

    static func ms(since start: ContinuousClock.Instant) -> Double {
        let d = ContinuousClock.now - start
        return (Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15).rounded()
    }

    private static func read(_ file: URL) -> [Entry] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        let decoder = JSONDecoder()
        return data.split(separator: 0x0A).compactMap { line in
            (try? decoder.decode([String: JSONValue].self, from: Data(line))).flatMap(Entry.init(json:))
        }
    }
}
