import Foundation

// The GUI's event vocabulary (`../ah/server/feed/schema.ts`). One adapter per harness
// normalizes its transcript into these types on the host; the native GUI renders only
// these. Nothing here is derived from terminal text.

struct FeedEntry: Codable, Equatable, Sendable, Identifiable {
    enum Role: String, Codable, Sendable { case user, assistant, system, tool }
    /// Monotonic per transcript and the only ordering authority.
    let seq: Int
    let id: String
    let role: Role
    let step: String
    /// Milliseconds since the epoch as the adapter reported it.
    let at: Double
    let parts: [FeedPart]
}

struct ToolCall: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    /// Parsed arguments, or `{input: <raw>}` when they weren't JSON.
    let args: [String: JSONValue]

    subscript(key: String) -> JSONValue? { args[key] }
}

struct ToolResult: Codable, Equatable, Sendable {
    let callId: String
    let text: String
    let isError: Bool
    let data: [String: JSONValue]?
    let images: [String]?
    let truncated: Bool?
}

/// An `ah-widget` object: `type` plus whatever fields it carries, kept as data.
struct Widget: Codable, Equatable, Sendable {
    let type: String
    let fields: [String: JSONValue]

    init(type: String, fields: [String: JSONValue]) {
        self.type = type
        self.fields = fields
    }

    init(from decoder: any Decoder) throws {
        let object = try [String: JSONValue](from: decoder)
        guard let type = object["type"]?.string else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "widget without a type"))
        }
        self.type = type
        fields = object
    }

    func encode(to encoder: any Encoder) throws {
        try fields.encode(to: encoder)
    }

    subscript(key: String) -> JSONValue? { fields[key] }
}

enum FeedPart: Codable, Equatable, Sendable {
    case text(String)
    case reasoning(String)
    case media(kind: String, src: String, alt: String?)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    case widget(Widget)
    case notice(kind: NoticeKind, text: String)
    /// A part type this build doesn't know: kept, never rendered as something else.
    case unknown(type: String)

    enum NoticeKind: String, Codable, Sendable { case compacted, interrupted, info }

    private enum CodingKeys: String, CodingKey { case type, text, kind, src, alt, call, result, widget }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "text": self = .text(try c.decode(String.self, forKey: .text))
        case "reasoning": self = .reasoning(try c.decode(String.self, forKey: .text))
        case "media": self = .media(kind: try c.decode(String.self, forKey: .kind), src: try c.decode(String.self, forKey: .src), alt: try c.decodeIfPresent(String.self, forKey: .alt))
        case "tool_call": self = .toolCall(try c.decode(ToolCall.self, forKey: .call))
        case "tool_result": self = .toolResult(try c.decode(ToolResult.self, forKey: .result))
        case "widget": self = .widget(try c.decode(Widget.self, forKey: .widget))
        case "notice":
            let kind = NoticeKind(rawValue: try c.decode(String.self, forKey: .kind)) ?? .info
            self = .notice(kind: kind, text: try c.decode(String.self, forKey: .text))
        default: self = .unknown(type: type)
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try c.encode("text", forKey: .type)
            try c.encode(text, forKey: .text)
        case .reasoning(let text):
            try c.encode("reasoning", forKey: .type)
            try c.encode(text, forKey: .text)
        case .media(let kind, let src, let alt):
            try c.encode("media", forKey: .type)
            try c.encode(kind, forKey: .kind)
            try c.encode(src, forKey: .src)
            try c.encodeIfPresent(alt, forKey: .alt)
        case .toolCall(let call):
            try c.encode("tool_call", forKey: .type)
            try c.encode(call, forKey: .call)
        case .toolResult(let result):
            try c.encode("tool_result", forKey: .type)
            try c.encode(result, forKey: .result)
        case .widget(let widget):
            try c.encode("widget", forKey: .type)
            try c.encode(widget, forKey: .widget)
        case .notice(let kind, let text):
            try c.encode("notice", forKey: .type)
            try c.encode(kind, forKey: .kind)
            try c.encode(text, forKey: .text)
        case .unknown(let type):
            try c.encode(type, forKey: .type)
        }
    }

    var isNotice: Bool {
        if case .notice = self { return true }
        return false
    }

    var isToolResult: Bool {
        if case .toolResult = self { return true }
        return false
    }
}

/// Server → client stream messages (SSE event name = `type`).
enum FeedMessage: Equatable, Sendable {
    case snapshot(reason: SnapshotReason, harness: String, entries: [FeedEntry], floor: Int, head: Int, hasOlder: Bool)
    case append(entries: [FeedEntry], head: Int)
    case unavailable(reason: String)

    enum SnapshotReason: String, Codable, Sendable { case initial, rotated, truncated }

    private struct Wire: Decodable {
        let type: String
        let reason: String?
        let harness: String?
        let entries: [FeedEntry]?
        let floor: Int?
        let head: Int?
        let hasOlder: Bool?
    }

    /// Decodes one SSE event; nil for an event name this build doesn't know.
    static func decode(_ event: ServerSentEvent) throws -> FeedMessage? {
        guard ["snapshot", "append", "unavailable"].contains(event.name) else { return nil }
        let wire = try JSONDecoder().decode(Wire.self, from: Data(event.data.utf8))
        switch wire.type {
        case "snapshot":
            return .snapshot(
                reason: SnapshotReason(rawValue: wire.reason ?? "") ?? .initial, harness: wire.harness ?? "",
                entries: wire.entries ?? [], floor: wire.floor ?? 0, head: wire.head ?? 0, hasOlder: wire.hasOlder ?? false
            )
        case "append": return .append(entries: wire.entries ?? [], head: wire.head ?? 0)
        case "unavailable": return .unavailable(reason: wire.reason ?? "not-found")
        default: return nil
        }
    }
}

/// GET /feed?before=seq: one page of older entries.
struct FeedPage: Codable, Equatable, Sendable {
    let entries: [FeedEntry]
    let hasOlder: Bool
}

/// GET /feed/prompts: every message you sent, oldest first (the message rail).
struct FeedPrompt: Codable, Equatable, Sendable, Hashable {
    let seq: Int
    let at: Double
    let text: String
}
