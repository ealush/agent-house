import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// What the agents on a host used (`apps/server/server/usage`, feature `usage` 1): tokens read from the
// agents' own transcripts (Claude Code and Codex record them; other agents don't, and their
// usage is unknown), the limits providers reported, and an estimate at list price that is not
// a bill. Days are UTC dates (YYYY-MM-DD); times are epoch seconds.

struct UsageTokensDTO: Codable, Equatable, Sendable {
    var input: Double
    var output: Double
    var cacheRead: Double
    var cacheWrite: Double
    var reasoning: Double

    init(input: Double = 0, output: Double = 0, cacheRead: Double = 0, cacheWrite: Double = 0, reasoning: Double = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.reasoning = reasoning
    }

    private enum CodingKeys: String, CodingKey { case input, output, cacheRead, cacheWrite, reasoning }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        input = try c.decodeIfPresent(Double.self, forKey: .input) ?? 0
        output = try c.decodeIfPresent(Double.self, forKey: .output) ?? 0
        cacheRead = try c.decodeIfPresent(Double.self, forKey: .cacheRead) ?? 0
        cacheWrite = try c.decodeIfPresent(Double.self, forKey: .cacheWrite) ?? 0
        reasoning = try c.decodeIfPresent(Double.self, forKey: .reasoning) ?? 0
    }

    /// Every token the agent sent or got: prompt, reply, and cache reads and writes.
    var total: Double { input + output + cacheRead + cacheWrite }
    /// What went in, as the web counts it: the prompt and what was written to the cache.
    var sent: Double { input + cacheWrite }
}

struct UsageCostDTO: Codable, Equatable, Sendable {
    /// At list (or your configured) prices; nil when nothing in it has a price.
    var estimateUsd: Double?
    /// `list`, `configured`, or both joined by `+`.
    var basis: String?
    /// Tokens with no price to apply: left out of the estimate, not counted as free.
    var unpricedTokens: Double
    /// How the provider bills you: `api`, `subscription`, `unknown`.
    var billing: String?

    init(estimateUsd: Double? = nil, basis: String? = nil, unpricedTokens: Double = 0, billing: String? = nil) {
        self.estimateUsd = estimateUsd
        self.basis = basis
        self.unpricedTokens = unpricedTokens
        self.billing = billing
    }

    private enum CodingKeys: String, CodingKey { case estimateUsd, basis, unpricedTokens, billing }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        estimateUsd = try c.decodeIfPresent(Double.self, forKey: .estimateUsd)
        basis = try c.decodeIfPresent(String.self, forKey: .basis)
        unpricedTokens = try c.decodeIfPresent(Double.self, forKey: .unpricedTokens) ?? 0
        billing = try c.decodeIfPresent(String.self, forKey: .billing)
    }
}

/// One grouped row of a report: a day, a model, a provider, an agent or a conversation.
struct UsageRowDTO: Codable, Equatable, Sendable, Identifiable {
    var key: String
    var provider: String?
    var harness: String?
    var model: String?
    /// The session, in a report by conversation (when the host still knows it).
    var uid: String?
    var tokens: UsageTokensDTO
    var messages: Int
    var sessions: Int
    var cost: UsageCostDTO

    var id: String { key }

    init(key: String, provider: String? = nil, harness: String? = nil, model: String? = nil, uid: String? = nil, tokens: UsageTokensDTO = UsageTokensDTO(), messages: Int = 0, sessions: Int = 0, cost: UsageCostDTO = UsageCostDTO()) {
        self.key = key
        self.provider = provider
        self.harness = harness
        self.model = model
        self.uid = uid
        self.tokens = tokens
        self.messages = messages
        self.sessions = sessions
        self.cost = cost
    }

    private enum CodingKeys: String, CodingKey { case key, provider, harness, model, uid, tokens, messages, sessions, cost }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        harness = try c.decodeIfPresent(String.self, forKey: .harness)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        uid = try c.decodeIfPresent(String.self, forKey: .uid)
        tokens = (try? c.decodeIfPresent(UsageTokensDTO.self, forKey: .tokens)) ?? UsageTokensDTO()
        messages = try c.decodeIfPresent(Int.self, forKey: .messages) ?? 0
        sessions = try c.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
        cost = (try? c.decodeIfPresent(UsageCostDTO.self, forKey: .cost)) ?? UsageCostDTO()
    }
}

/// Where the numbers come from, in the host's words.
struct UsageNotesDTO: Codable, Equatable, Sendable {
    var tokens: String
    var cost: String
    var listPricesAsOf: String?
}

struct UsageReportDTO: Codable, Equatable, Sendable {
    var from: String
    var to: String
    var by: String
    var rows: [UsageRowDTO]
    var notes: UsageNotesDTO?
}

struct UsageLimitsDTO: Codable, Equatable, Sendable {
    /// A rate-limit window a provider reported (Codex's primary/secondary, …).
    struct Window: Codable, Equatable, Sendable, Identifiable {
        var harness: String
        var provider: String
        var window: String
        var usedPercent: Double?
        var windowMinutes: Double?
        var resetsAt: Double?
        var source: String
        var observedAt: Double
        var id: String { "\(harness):\(window)" }
    }

    /// A session at a limit now: what it said, and until when.
    struct Cooldown: Codable, Equatable, Sendable, Identifiable {
        var harness: String
        var uid: String
        var resetsAt: Double?
        /// `screen` or `transcript`.
        var source: String
        var text: String
        var id: String { uid }
    }

    var windows: [Window]
    var cooldowns: [Cooldown]

    init(windows: [Window] = [], cooldowns: [Cooldown] = []) {
        self.windows = windows
        self.cooldowns = cooldowns
    }

    private enum CodingKeys: String, CodingKey { case windows, cooldowns }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        windows = (try? c.decodeIfPresent([Window].self, forKey: .windows)) ?? []
        cooldowns = (try? c.decodeIfPresent([Cooldown].self, forKey: .cooldowns)) ?? []
    }
}

/// One conversation's usage, per model (`GET /api/sessions/:uid/usage`).
struct SessionUsageDTO: Codable, Equatable, Sendable {
    struct Model: Codable, Equatable, Sendable, Identifiable {
        var model: String
        var input: Double
        var output: Double
        var cacheRead: Double
        var cacheWrite: Double
        var messages: Int
        var cost: UsageCostDTO
        var id: String { model }
        var total: Double { input + output + cacheRead + cacheWrite }
    }

    /// Its agent records usage in its transcript (Claude Code, Codex): without it, unknown.
    var metered: Bool
    var models: [Model]
    var notes: UsageNotesDTO?
}

/// What a refresh read: transcripts, bytes and events.
struct UsageIngestDTO: Codable, Equatable, Sendable {
    var files: Int
    var bytes: Int
    var events: Int
}

enum UsageGroup: String, Sendable, CaseIterable { case day, model, provider, harness, session }

enum UsageExportFormat: String, Sendable, CaseIterable { case csv, json }

extension APIClient {
    /// Totals grouped `by`, for UTC days `from` through `to` (the host's default: the last 30).
    func usage(by group: UsageGroup, from: String? = nil, to: String? = nil) async throws -> UsageReportDTO {
        var query = [URLQueryItem(name: "by", value: group.rawValue)]
        if let from { query.append(URLQueryItem(name: "from", value: from)) }
        if let to { query.append(URLQueryItem(name: "to", value: to)) }
        return try await call("GET", "/api/usage", query: query)
    }
    func usageLimits() async throws -> UsageLimitsDTO { try await call("GET", "/api/usage/limits") }
    /// Reads what the agents wrote since the last pass, now rather than within the minute.
    func refreshUsage() async throws -> UsageIngestDTO { try await call("POST", "/api/usage/refresh") }
    /// Every daily row the host keeps, as a file to keep or chart elsewhere.
    func usageExport(_ format: UsageExportFormat) async throws -> Data {
        try await send(await request("GET", "/api/usage/export", query: [URLQueryItem(name: "format", value: format.rawValue)]))
    }
    func sessionUsage(_ uid: String) async throws -> SessionUsageDTO { try await call("GET", "/api/sessions/\(Self.enc(uid))/usage") }
}
