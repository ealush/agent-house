import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Usage (`apps/server/server/usage`, feature `usage` 1): reports, limits and one conversation's usage
// as the host sends them, and what the Usage page makes of them. Synthetic.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private let byModelJSON = #"""
{"from":"2026-10-23","to":"2026-11-21","by":"model","rows":[
 {"key":"claude-opus-5-5","provider":"anthropic","harness":"claude","model":"claude-opus-5-5","uid":null,
  "tokens":{"input":1000,"output":400,"cacheRead":9000,"cacheWrite":500,"reasoning":0,"source":"local_telemetry"},
  "messages":12,"sessions":2,"cost":{"estimateUsd":1.25,"basis":"list_price","unpricedTokens":0,"billing":"subscription"}},
 {"key":"gpt-5.5-codex","provider":"openai","harness":"codex","model":"gpt-5.5-codex","uid":null,
  "tokens":{"input":2000,"output":100,"cacheRead":0,"cacheWrite":0,"reasoning":50,"source":"local_telemetry"},
  "messages":3,"sessions":1,"cost":{"estimateUsd":null,"basis":null,"unpricedTokens":2100,"billing":"unknown"}}],
 "notes":{"tokens":"Read from each agent's own transcript.","cost":"An estimate at API list prices.","listPricesAsOf":"2026-10-06"}}
"""#

@Test func aReportDecodesAsTheHostSendsIt() throws {
    let report = try decode(UsageReportDTO.self, byModelJSON)
    #expect(report.by == "model" && report.rows.count == 2)
    let opus = report.rows[0]
    #expect(opus.tokens.total == 10_900)
    #expect(opus.tokens.sent == 1_500, "what went in: the prompt and the cache writes")
    #expect(opus.cost.estimateUsd == 1.25 && opus.cost.billing == "subscription")
    #expect(report.rows[1].cost.estimateUsd == nil && report.rows[1].cost.unpricedTokens == 2100)
    #expect(report.notes?.listPricesAsOf == "2026-10-06")
}

@Test func totalsCountWhatHasAPriceAndSayWhatDoesnt() throws {
    let totals = UsageModel.totals(try decode(UsageReportDTO.self, byModelJSON).rows)
    #expect(totals.sent == 3_500)
    #expect(totals.output == 500)
    #expect(totals.cacheRead == 9_000)
    #expect(totals.cost == 1.25, "a row with no price is left out of the estimate")
    #expect(totals.unpriced == 2_100)
    #expect(totals.subscription)
    #expect(UsageModel.totals([]).cost == nil, "nothing priced is no estimate, not $0")
}

@Test func theChartHasEveryDayOfThePeriod() throws {
    let now = try #require(UsageModel.utcMidnight("2026-11-21")).addingTimeInterval(12 * 3600)
    let rows = [UsageRowDTO(key: "2026-11-20", tokens: UsageTokensDTO(input: 10, output: 5)), UsageRowDTO(key: "2026-11-15", tokens: UsageTokensDTO(cacheRead: 100))]
    let series = UsageModel.series(rows, days: 7, now: now)
    #expect(series.map(\.day) == ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"])
    #expect(series.map(\.total) == [100, 0, 0, 0, 0, 15, 0], "a day with nothing recorded is there, as zero")
    #expect(series.first?.date == UsageModel.utcMidnight("2026-11-15"))
    #expect(UsageModel.day(29, now: now) == "2026-10-23")
}

@Test func limitsAndOneConversationDecode() throws {
    let limits = try decode(UsageLimitsDTO.self, #"""
    {"windows":[{"harness":"codex","provider":"openai","window":"primary","usedPercent":62,"windowMinutes":300,"resetsAt":1795000000,"source":"provider_telemetry","observedAt":1794990000}],
     "cooldowns":[{"harness":"claude","uid":"u-1","resetsAt":null,"source":"screen","text":"Session limit · resets 12am"}]}
    """#)
    #expect(limits.windows.first?.usedPercent == 62)
    #expect(limits.cooldowns.first?.resetsAt == nil)
    #expect(UsageModel.windowWords(try #require(limits.windows.first), agent: "Codex") == "Codex · primary window (5 h)")
    #expect(UsageModel.windowWords(UsageLimitsDTO.Window(harness: "codex", provider: "openai", window: "secondary", usedPercent: nil, windowMinutes: 10080, resetsAt: nil, source: "x", observedAt: 0), agent: "Codex") == "Codex · secondary window (7 days)")
    #expect(try decode(UsageLimitsDTO.self, #"{"windows":"none"}"#).windows.isEmpty, "a list it can't read is none, not a failure")

    let session = try decode(SessionUsageDTO.self, #"""
    {"metered":true,"models":[{"model":"claude-sonnet-5-5","input":10,"output":20,"cacheRead":30,"cacheWrite":40,"messages":2,"cost":{"estimateUsd":0.5,"basis":"list_price","billing":"api"}}],"notes":{"tokens":"t","cost":"c"}}
    """#)
    #expect(session.metered && session.models.first?.total == 100)
    #expect(session.models.first?.cost.unpricedTokens == 0)
}

@Test func numbersReadAtAGlance() {
    #expect(UsageModel.short(999) == "999")
    #expect(UsageModel.short(1_234) == "1.2k")
    #expect(UsageModel.short(1_234_567) == "1.2M")
    #expect(UsageModel.short(3_400_000_000) == "3.4B")
    #expect(UsageModel.usd(nil) == "—")
    #expect(UsageModel.usd(0.004) == "< $0.01")
    #expect(UsageModel.usd(0) == "$0.00")
    #expect(UsageModel.usd(12.345) == "$12.35" || UsageModel.usd(12.345) == "$12.34")
}
