import Foundation

/// What the agents on a host used (`apps/server/web/UsageView.tsx`, `server/usage`): totals for a
/// period, tokens per day, by model and provider, the busiest conversations, and the limits
/// providers reported. Each number says where it came from; costs are estimates.
@MainActor
@Observable
final class UsageModel {
    enum Period: Int, CaseIterable, Sendable, Identifiable {
        case week = 7, month = 30, quarter = 90
        var id: Int { rawValue }
        var title: String { "\(rawValue) Days" }
    }

    let api: APIClient
    var period = Period.month
    private(set) var byDay: UsageReportDTO?
    private(set) var byModel: UsageReportDTO?
    private(set) var byProvider: UsageReportDTO?
    private(set) var bySession: UsageReportDTO?
    private(set) var limits: UsageLimitsDTO?
    private(set) var error: String?
    private(set) var loaded = false
    private(set) var refreshing = false
    private(set) var exporting = false

    init(api: APIClient) { self.api = api }

    /// The period's reports and the limits, together.
    func load() async {
        let from = Self.day(period.rawValue - 1)
        do {
            let reports = try await settled { [api] in
                async let d = api.usage(by: .day, from: from)
                async let m = api.usage(by: .model, from: from)
                async let p = api.usage(by: .provider, from: from)
                async let s = api.usage(by: .session, from: from)
                async let l = api.usageLimits()
                return try await (d, m, p, s, l)
            }
            byDay = reports.0
            byModel = reports.1
            byProvider = reports.2
            bySession = reports.3
            limits = reports.4
            error = nil
            loaded = true
        } catch {
            if let shown = APIError.shown(error) { self.error = shown }
        }
    }

    /// Asks the host to read the agents' transcripts now, then shows what it found.
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            _ = try await api.refreshUsage()
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// The host's daily rows as a file in the temporary folder, to share; nil when it failed.
    func export(_ format: UsageExportFormat, host: String) async -> URL? {
        exporting = true
        defer { exporting = false }
        do {
            let data = try await api.usageExport(format)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ah-usage-\(Self.safeName(host)).\(format.rawValue)")
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            self.error = APIError.wrap(error).message
            return nil
        }
    }

    func clearError() { error = nil }

    // MARK: What the page shows

    struct Totals: Equatable, Sendable {
        var sent: Double = 0
        var output: Double = 0
        var cacheRead: Double = 0
        /// Nil when nothing in the period has a price.
        var cost: Double?
        var unpriced: Double = 0
        /// Some of it is on a plan that doesn't bill per token.
        var subscription = false
    }

    var totals: Totals { Self.totals(byModel?.rows ?? []) }

    nonisolated static func totals(_ rows: [UsageRowDTO]) -> Totals {
        let priced = rows.filter { $0.cost.estimateUsd != nil }
        return Totals(
            sent: rows.reduce(0) { $0 + $1.tokens.sent },
            output: rows.reduce(0) { $0 + $1.tokens.output },
            cacheRead: rows.reduce(0) { $0 + $1.tokens.cacheRead },
            cost: priced.isEmpty ? nil : priced.reduce(0) { $0 + ($1.cost.estimateUsd ?? 0) },
            unpriced: rows.reduce(0) { $0 + $1.cost.unpricedTokens },
            subscription: priced.contains { $0.cost.billing == "subscription" }
        )
    }

    struct DayPoint: Equatable, Sendable, Identifiable {
        let day: String
        let date: Date
        let row: UsageRowDTO?
        var total: Double { row?.tokens.total ?? 0 }
        var id: String { day }
    }

    /// Every day of the period, nothing recorded included (as zero), oldest first.
    var series: [DayPoint] { Self.series(byDay?.rows ?? [], days: period.rawValue) }

    nonisolated static func series(_ rows: [UsageRowDTO], days: Int, now: Date = Date()) -> [DayPoint] {
        let byKey = Dictionary(rows.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        return (0..<days).reversed().map { back in
            let date = now.addingTimeInterval(-Double(back) * 86_400)
            let key = dayKey(date)
            return DayPoint(day: key, date: utcMidnight(key) ?? date, row: byKey[key])
        }
    }

    // MARK: Words

    /// 1234567 → "1.2M": counts at a glance (the tables have the exact numbers).
    nonisolated static func short(_ n: Double) -> String {
        if n >= 1e9 { return String(format: "%.1fB", n / 1e9) }
        if n >= 1e6 { return String(format: "%.1fM", n / 1e6) }
        if n >= 1e3 { return String(format: "%.1fk", n / 1e3) }
        return String(Int(n.rounded()))
    }

    nonisolated static func usd(_ n: Double?) -> String {
        guard let n else { return "—" }
        if n > 0 && n < 0.01 { return "< $0.01" }
        return String(format: "$%.2f", n)
    }

    /// A provider window as you'd say it: "Codex · primary window (5 h)".
    nonisolated static func windowWords(_ w: UsageLimitsDTO.Window, agent: String) -> String {
        var out = "\(agent) · \(w.window) window"
        if let minutes = w.windowMinutes, minutes > 0 {
            out += minutes >= 1440 ? " (\(Int((minutes / 1440).rounded())) days)" : " (\(Int((minutes / 60).rounded())) h)"
        }
        return out
    }

    nonisolated static func day(_ back: Int, now: Date = Date()) -> String { dayKey(now.addingTimeInterval(-Double(back) * 86_400)) }

    nonisolated static func dayKey(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    nonisolated static func utcMidnight(_ key: String) -> Date? {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: key)
    }

    private nonisolated static func safeName(_ host: String) -> String {
        let kept = host.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" ? Character($0) : "-" }
        return String(kept).isEmpty ? "host" : String(kept)
    }
}

/// One conversation's usage, per model, for its session's info.
@MainActor
@Observable
final class SessionUsageModel {
    let api: APIClient
    let uid: String
    private(set) var usage: SessionUsageDTO?
    private(set) var error: String?

    init(api: APIClient, uid: String) {
        self.api = api
        self.uid = uid
    }

    func load() async {
        do {
            usage = try await settled { [api, uid] in try await api.sessionUsage(uid) }
            error = nil
        } catch {
            if let shown = APIError.shown(error) { self.error = shown }
        }
    }

    var total: Double { usage?.models.reduce(0) { $0 + $1.total } ?? 0 }
    var cost: Double? {
        let priced = usage?.models.compactMap(\.cost.estimateUsd) ?? []
        return priced.isEmpty ? nil : priced.reduce(0, +)
    }
}
