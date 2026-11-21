import Foundation

struct ServerSentEvent: Equatable, Sendable {
    let name: String
    let data: String
    let lastEventID: String

    init(name: String = "message", data: String, lastEventID: String = "") {
        self.name = name
        self.data = data
        self.lastEventID = lastEventID
    }
}

/// Incremental byte parser, independent of URLSession and authentication.
/// Handles chunk boundaries inside UTF-8, BOM, CRLF and field names. Discard the
/// parser on reconnect. No incomplete event is dispatched at EOF.
struct ServerSentEventParser: Sendable {
    private let maximumLineBytes: Int
    private let maximumEventBytes: Int
    private var line: [UInt8] = []
    private var dataLines: [String] = []
    private var eventName = ""
    private var eventBytes = 0
    private var skipLineFeed = false
    private var isFirstLine = true
    private var isFinished = false

    private(set) var lastEventID = ""
    private(set) var retryMilliseconds: UInt64?

    init(maximumLineBytes: Int = 1_048_576, maximumEventBytes: Int = 8_388_608) {
        precondition(maximumLineBytes > 0 && maximumEventBytes > 0)
        self.maximumLineBytes = maximumLineBytes
        self.maximumEventBytes = maximumEventBytes
    }

    mutating func append(_ chunk: Data) throws -> [ServerSentEvent] {
        guard !isFinished else { throw ParseError.closed }
        do {
            var events: [ServerSentEvent] = []
            for byte in chunk {
                if skipLineFeed {
                    skipLineFeed = false
                    if byte == 10 { continue }
                }
                if byte == 10 || byte == 13 {
                    if let event = try consumeLine() { events.append(event) }
                    skipLineFeed = byte == 13
                } else {
                    guard line.count < maximumLineBytes else { throw ParseError.lineTooLarge }
                    line.append(byte)
                }
            }
            return events
        } catch {
            finish()
            throw error
        }
    }

    mutating func finish() {
        isFinished = true
        line.removeAll()
        dataLines.removeAll()
        eventName = ""
    }

    private mutating func consumeLine() throws -> ServerSentEvent? {
        defer { line.removeAll(keepingCapacity: true) }
        if isFirstLine {
            isFirstLine = false
            if line.starts(with: [0xEF, 0xBB, 0xBF]) { line.removeFirst(3) }
        }
        guard let text = String(bytes: line, encoding: .utf8) else { throw ParseError.invalidUTF8 }
        if text.isEmpty {
            defer {
                dataLines.removeAll(keepingCapacity: true)
                eventName = ""
                eventBytes = 0
            }
            guard !dataLines.isEmpty else { return nil }
            return ServerSentEvent(
                name: eventName.isEmpty ? "message" : eventName,
                data: dataLines.joined(separator: "\n"),
                lastEventID: lastEventID
            )
        }
        guard line.count < maximumEventBytes - eventBytes else { throw ParseError.eventTooLarge }
        eventBytes += line.count + 1
        if text.hasPrefix(":") { return nil }
        let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = parts[0]
        var value = parts.count == 2 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch field {
        case "event": eventName = value
        case "data": dataLines.append(value)
        case "id": if !value.contains("\0") { lastEventID = value }
        case "retry":
            if !value.isEmpty && value.utf8.allSatisfy({ (48...57).contains($0) }),
               let milliseconds = UInt64(value) {
                retryMilliseconds = milliseconds
            }
        default: break
        }
        return nil
    }

    enum ParseError: Error, Equatable {
        case lineTooLarge, eventTooLarge, invalidUTF8, closed
    }
}
