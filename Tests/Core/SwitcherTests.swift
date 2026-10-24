import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The switcher's search (`../ah/web/Switcher.tsx` parseQuery, filters and ranking).

private func session(_ uid: String, title: String, agent: String? = "claude", status: String = "idle", project: String = "ah", branch: String? = nil, model: String? = nil, host: String = "desk") throws -> SessionRow {
    var object: [String: Any] = ["id": "%\(uid)", "uid": uid, "name": title, "title": title, "statusSource": "hook", "project": project, "projectPath": "/p/\(project)", "status": status, "command": agent == nil ? "zsh" : "node"]
    if let agent { object["agent"] = agent }
    if let branch { object["branch"] = branch }
    if let model { object["model"] = model }
    let dto = try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
    return SessionRow(key: uid, host: host, isLocal: true, dto: dto)
}

private func past(_ ref: String, title: String, harness: String = "claude", project: String = "ah", at: Double) throws -> HistoryRow {
    let object: [String: Any] = ["ref": ref, "kind": "ended", "harness": harness, "title": title, "cwd": "/p", "project": project, "at": at]
    return HistoryRow(host: "desk", isLocal: true, dto: try JSONDecoder().decode(HistoryItemDTO.self, from: JSONSerialization.data(withJSONObject: object)))
}

@Test func scopedTokensBecomeFiltersAndTheRestIsText() {
    let q = SwitcherSearch.parse("h:Claude  fix   p:vest s:waiting m:opus in:chats role:user tests")
    #expect(q.text == "fix tests")
    #expect(q.host == "claude" && q.project == "vest" && q.status == "waiting" && q.model == "opus" && q.scope == "chats" && q.role == "user")
    #expect(SwitcherSearch.parse("x: http://a").text == "x: http://a", "an empty or unknown scope is just text")
    #expect(!SwitcherSearch.parse("").reachesHistory)
    #expect(!SwitcherSearch.parse("s:waiting").reachesHistory, "a status alone stays on live sessions")
    #expect(SwitcherSearch.parse("p:ah").reachesHistory)
}

@Test func liveSessionsFilterAndRankThenFollowTheSidebar() throws {
    let rows = [
        try session("a", title: "fix login", status: "waiting", branch: "auth"),
        try session("b", title: "flaky tests", agent: "codex", project: "vest"),
        try session("c", title: "shell", agent: nil),
    ]
    func keys(_ q: String, order: [String] = ["c", "b", "a"]) -> [String] { SwitcherSearch.live(rows, order: order, SwitcherSearch.parse(q)).map(\.key) }
    #expect(keys("") == ["c", "b", "a"], "empty: sidebar order")
    #expect(keys("h:codex") == ["b"])
    #expect(keys("h:zsh") == ["c"], "a shell matches its command")
    #expect(keys("s:wait") == ["a"])
    #expect(keys("p:vest tests") == ["b"])
    #expect(keys("auth") == ["a"], "the branch counts")
    #expect(keys("m:opus").isEmpty)
}

@Test func historyJoinsOnlyOnceYouTypeAndRanksNewestAmongEquals() throws {
    let history = [try past("claude:1", title: "old login fix", at: 10), try past("claude:2", title: "new login fix", at: 20), try past("codex:3", title: "other", harness: "codex", at: 30)]
    #expect(SwitcherSearch.past(history, SwitcherSearch.parse("")).isEmpty)
    #expect(SwitcherSearch.past(history, SwitcherSearch.parse("login")).map(\.dto.ref) == ["claude:2", "claude:1"])
    #expect(SwitcherSearch.past(history, SwitcherSearch.parse("h:codex")).map(\.dto.ref) == ["codex:3"])
    #expect(SwitcherSearch.past(history, SwitcherSearch.parse("login s:waiting")).isEmpty, "ended rows aren't waiting")
    let live = try (0..<12).map { try session("s\($0)", title: "login \($0)") }
    let both = SwitcherSearch.results(live: live, order: [], history: history, SwitcherSearch.parse("login"))
    #expect(both.live.count == 12 && both.past.count == 2, "fourteen at most, together")
}

@Test func contentSearchWaitsForTwoLettersAndCarriesTheScopes() {
    #expect(SwitcherSearch.contentQuery(SwitcherSearch.parse("a p:ah")) == nil)
    let q = SwitcherSearch.contentQuery(SwitcherSearch.parse("retry logic in:chats role:user p:ah h:desk"))
    #expect(q == SearchQuery(q: "retry logic", scope: "chats", role: "user", project: "ah", host: "desk", model: nil, limit: 8))
    #expect(SwitcherSearch.contentQuery(SwitcherSearch.parse("retry in:everything"))?.scope == nil)
    let runs = SwitcherSearch.highlights("the \u{1}retry\u{2} loop")
    #expect(runs.map(\.text) == ["the ", "retry", " loop"])
    #expect(runs.map(\.marked) == [false, true, false])
}

@MainActor
@Test func contentMatchesSayWhenSearchIsOffOrIndexing() async {
    let off = SearchResponse(enabled: false, building: false, results: [], total: 0, tookMs: 1, notes: [])
    let content = SwitcherContent { _ in off }
    content.update("retry", debounce: .zero)
    await content.settle()
    #expect(content.note == "Content search is off (Settings → Search).")
    content.update("r", debounce: .zero)
    #expect(content.hits.isEmpty && content.note == nil, "under two letters, nothing")
    let building = SwitcherContent { _ in SearchResponse(enabled: true, building: true, results: [], total: 0, tookMs: 1, notes: []) }
    building.update("retry", debounce: .zero)
    await building.settle()
    #expect(building.note == "Indexing conversations…")
}

@Test func newSessionsStartInTheNewestProjectAndRememberSafeChoices() throws {
    var a = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try session("a", title: "A", project: "web").dto)) as! [String: Any]
    a["activity"] = 10
    var b = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try session("b", title: "B", project: "api").dto)) as! [String: Any]
    b["activity"] = 20
    let rows = try [a, b].map { SessionRow(key: $0["uid"] as! String, host: "desk", isLocal: true, dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: $0))) }
    #expect(LaunchState.newestProject(rows) == "/p/api")
    #expect(LaunchState.newestProject([]) == nil)

    let preset = try JSONDecoder().decode(PresetDTO.self, from: Data(#"""
    {"id":"claude","name":"Claude Code","command":"claude","available":true,"defaultEffort":"medium",
     "modes":[{"id":"default","name":"Ask"},{"id":"plan","name":"Plan"},{"id":"dangerous","name":"Skip permissions","dangerous":true}],
     "models":[{"id":"opus","name":"Opus 5.5"},{"id":"sonnet","name":"Sonnet 5.5"}],
     "effort":{"levels":["low","medium","high"]},"modelArgs":["--model","{model}"]}
    """#.utf8))
    #expect(LaunchState.remembered(nil, preset: preset) == ("default", nil, "medium"))
    let plan = LaunchState.remembered(.init(mode: "plan", model: "sonnet", effort: "high"), preset: preset)
    #expect(plan == ("plan", "sonnet", "high"))
    let risky = LaunchState.remembered(.init(mode: "dangerous", model: "claude-opus-5-5", effort: "ultra"), preset: preset)
    #expect(risky == ("default", "claude-opus-5-5", "medium"), "a dangerous mode and an unknown effort aren't restored; a typed model id is")
}
