import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The switcher's search (`apps/server/web/Switcher.tsx` parseQuery, filters and ranking).

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

@MainActor
@Test func aSearchThatFailsKeepsTheLastMatchesAndSaysSo() async {
    struct Dropped: Error {}
    let hit = SearchHit(kind: "transcript", host: "desk", ref: nil, uid: "a", harness: "claude", harnessId: nil, title: "Retry flow", cwd: "", at: 0, matches: 1, excerpts: [])
    let calls = Counter()
    let content = SwitcherContent { _ in
        guard await calls.next() == 1 else { throw Dropped() }
        return SearchResponse(enabled: true, building: false, results: [hit], total: 1, tookMs: 1, notes: [])
    }
    content.update("retry", debounce: .zero)
    await content.settle()
    #expect(content.hits == [hit] && content.note == nil)
    content.update("retry f", debounce: .zero)
    await content.settle()
    #expect(content.hits == [hit], "a dropped search leaves what was found up")
    #expect(content.note == "Couldn’t search just now; these are from before.")
}

private actor Counter {
    private var n = 0
    func next() -> Int { n += 1; return n }
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

@Test func onlyADangerousModeRaisesTheShield() throws {
    let preset = try JSONDecoder().decode(PresetDTO.self, from: Data(#"""
    {"id":"codex","name":"Codex","command":"codex","available":true,
     "modes":[{"id":"default","name":"Ask"},{"id":"auto","name":"Full auto"},{"id":"yolo","name":"Full access","dangerous":true}]}
    """#.utf8))
    func launched(_ mode: String?) throws -> LaunchState {
        var object: [String: Any] = ["id": "%1", "uid": "s1", "name": "S", "statusSource": "hook", "project": "ah", "projectPath": "/p/ah", "status": "idle", "command": "node", "agent": "codex"]
        if let mode { object["launchMode"] = mode }
        return LaunchState(preset: preset, session: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    #expect(try launched("yolo").warning == "Codex runs with permission checks off")
    #expect(try launched("auto").warning == nil, "a mode that runs without asking but isn't flagged dangerous")
    #expect(try launched(nil).warning == nil, "launched with no mode: the default")
    #expect(LaunchState(preset: nil, session: nil).warning == nil)
}

@Test func eachModelComesBackWithItsOwnEffort() throws {
    let preset = try JSONDecoder().decode(PresetDTO.self, from: Data(#"""
    {"id":"claude","name":"Claude Code","command":"claude","available":true,"defaultEffort":"medium",
     "models":[{"id":"opus","name":"Opus 5.5","efforts":["low","medium","high","max"]},{"id":"haiku","name":"Haiku 5.5","efforts":["low","medium"]},{"id":"sonnet","name":"Sonnet 5.5"}],
     "effort":{"levels":["low","medium","high"]}}
    """#.utf8))
    var memory = LaunchState.remembering(nil, mode: "default", model: "opus", effort: "max", trust: nil)
    memory = LaunchState.remembering(memory, mode: "default", model: "sonnet", effort: nil, trust: nil)
    #expect(memory.efforts == ["opus": "max", "sonnet": "default"])
    #expect(LaunchState.remembered(memory, preset: preset) == ("default", "sonnet", nil), "the last start comes back, Default effort included")

    let chosen = memory.effortsByModel
    #expect(LaunchState.effort(for: "opus", preset: preset, chosen: chosen, current: nil) == "max", "a model brings back the effort it last started with")
    #expect(LaunchState.effort(for: "haiku", preset: preset, chosen: chosen, current: "low") == "low", "a model with nothing remembered keeps a level it takes")
    #expect(LaunchState.effort(for: "haiku", preset: preset, chosen: chosen, current: "high") == nil, "and drops one it doesn't")
    #expect(LaunchState.effort(for: "opus", preset: preset, chosen: ["opus": "ultra"], current: "high") == "high", "a remembered level the model no longer takes gives way")

    let legacy = DevicePreferences.LaunchMemory(mode: "default", model: "opus", effort: "high")
    #expect(legacy.effortsByModel == ["opus": "high"], "rows from before per-model memory keep their one effort")
    #expect(LaunchState.remembered(legacy, preset: preset) == ("default", "opus", "high"))
}

@Test func sidebarBlockOrderIsKeptPerGrouping() throws {
    var order = DevicePreferences.GroupOrder()
    order.set(["api", "web"], multiHost: false)
    order.set(["desk", "laptop"], multiHost: true)
    #expect(order.saved(multiHost: false) == ["api", "web"])
    #expect(order.saved(multiHost: true) == ["desk", "laptop"])
    let moved = SessionOrdering.saveGroupMove(visible: ["web", "api", "infra"], saved: [], from: "infra", to: "web", after: false)
    #expect(moved == ["infra", "web", "api"])
    let decoded = try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"groupOrder":{"project":["b","a"],"host":[]}}"#.utf8))
    #expect(decoded.groupOrder.project == ["b", "a"])
}

@Test func foldedSidebarBlocksAreKeptOnTheDevice() throws {
    let older = try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"groupOrder":{"project":[],"host":[]}}"#.utf8))
    #expect(older.collapsedGroups.isEmpty, "rows from before folding open every block")
    var preferences = DevicePreferences()
    preferences.collapsedGroups = ["orbit-api", "desk"]
    let again = try JSONDecoder().decode(DevicePreferences.self, from: JSONEncoder().encode(preferences))
    #expect(again.collapsedGroups == ["orbit-api", "desk"])
}

// Siri, Shortcuts and quick actions (`ShortcutCatalog`, `QuickAction`).

private func shortcut(_ uid: String, _ title: String, status: String = "idle", project: String = "orbit-web", activity: Double = 0, host: String = "desk", showHost: Bool = false) throws -> ShortcutSession {
    let object: [String: Any] = ["id": "%\(uid)", "uid": uid, "name": title, "title": title, "statusSource": "hook", "project": project, "projectPath": "/p/\(project)",
                                 "status": status, "command": "node", "agent": "claude", "activity": activity]
    let dto = try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
    return ShortcutSession(origin: "https://desk.example.ts.net", row: SessionRow(key: uid, host: host, isLocal: true, dto: dto), showHost: showHost)
}

@Test func siriNamesSessionsThatNeedYouFirstThenWorkingThenRecent() throws {
    let idleOld = try shortcut("a", "Release notes", activity: 10)
    let idleNew = try shortcut("b", "Users latency", project: "orbit-api", activity: 50)
    let working = try shortcut("c", "Welcome flow", status: "busy", activity: 5)
    let waiting = try shortcut("d", "Rotate API keys", status: "waiting", project: "orbit-infra", activity: 1)
    let ranked = ShortcutCatalog.ranked([idleOld, idleNew, working, waiting])
    #expect(ranked.map(\.key) == ["d", "c", "b", "a"])
    #expect(waiting.subtitle == "orbit-infra · needs you")
    #expect(try shortcut("e", "Docs", host: "mac", showHost: true).subtitle == "mac · orbit-web · idle", "with more than one host, the host reads first")

    // An id carries the host's origin and the session key, and comes back apart.
    #expect(waiting.id == "https://desk.example.ts.net#d")
    #expect(ShortcutSession.parse(waiting.id)! == ("https://desk.example.ts.net", "d"))
    #expect(ShortcutSession.parse("nohash") == nil && ShortcutSession.parse("#d") == nil)

    // Spoken names match loosely; filler words don't count against them.
    #expect(ShortcutCatalog.matching("the welcome flow session", in: ranked).first?.key == "c")
    #expect(ShortcutCatalog.matching("api", in: ranked).map(\.key).contains("b"))
    #expect(ShortcutCatalog.matching("", in: ranked).count == 4)
}

@Test func siriSaysWhatNeedsYouInASentence() throws {
    let a = try shortcut("a", "Rotate API keys", status: "waiting")
    let b = try shortcut("b", "Welcome flow", status: "waiting")
    let c = try shortcut("c", "Users latency", status: "waiting")
    let d = try shortcut("d", "Docs", status: "waiting")
    let busy = try shortcut("e", "Release notes", status: "busy")
    #expect(ShortcutCatalog.needsYouSummary([]) == "Nothing needs you.")
    #expect(ShortcutCatalog.needsYouSummary([busy]) == "Nothing needs you. One is working.")
    #expect(ShortcutCatalog.needsYouSummary([a, busy]) == "Rotate API keys needs you. One is working.")
    #expect(ShortcutCatalog.needsYouSummary([a, b]) == "2 sessions need you: Rotate API keys and Welcome flow.")
    #expect(ShortcutCatalog.needsYouSummary([a, b, c, d]) == "4 sessions need you: Rotate API keys, Welcome flow, Users latency and 1 more.")
    #expect(ShortcutCatalog.sentSummary(.delivered, title: "Docs") == "Sent to Docs.")
    #expect(ShortcutCatalog.sentSummary(.queued, title: "Docs") == "Queued for Docs; it goes in when the agent is free.")
}

@Test func quickActionsRunPaletteCommandsAndTheInboxCountsOnly() {
    #expect(QuickAction.allCases.map(\.command.rawValue) == ["new-session", "go-search", "go-inbox"])
    #expect(QuickAction.allCases.allSatisfy { action in CommandCatalog.all.contains { $0.id == action.command } }, "each runs a real command")
    #expect(QuickAction.inboxTitle(needsYou: 0) == "Inbox")
    #expect(QuickAction.inboxTitle(needsYou: 1) == "1 Needs You")
    #expect(QuickAction.inboxTitle(needsYou: 3) == "3 Need You")
}

@Test func aSnippetReadsWithoutItsMarkdownMarks() {
    let runs = SwitcherSearch.highlights("Going with **\u{1}Postgres\u{2}** for `sessions`")
    #expect(runs.map(\.text).joined() == "Going with Postgres for sessions")
    #expect(runs.first { $0.marked }?.text == "Postgres")
}

@Test func sessionsSortByProjectOrLatestActivity() throws {
    func row(_ uid: String, project: String, activity: Double, created: Double, pinned: Bool = false) throws -> SessionRow {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try session(uid, title: uid, project: project).dto)) as! [String: Any]
        object["activity"] = activity
        object["createdAt"] = created
        object["pinned"] = pinned
        return SessionRow(key: uid, host: "desk", isLocal: true, dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    let rows = [
        try row("a", project: "web", activity: 50, created: 1),
        try row("b", project: "api", activity: 90, created: 2),
        try row("c", project: "web", activity: 0, created: 70),
        try row("d", project: "api", activity: 10, created: 3, pinned: true),
    ]
    let byProject = SessionOrdering.sections(rows, multiHost: false, sort: .project)
    #expect(byProject.map(\.id) == ["web", "api"], "blocks per project, as before")
    let recent = SessionOrdering.sections(rows, multiHost: false, sort: .recent)
    #expect(recent.map(\.id) == [SessionOrdering.recentSection], "one list, no blocks")
    #expect(recent.first?.rows.map(\.key) == ["d", "b", "c", "a"], "pins on top, then the latest active; one that never printed goes by its opening")
    #expect(SessionOrdering.sections([], multiHost: false, sort: .recent).isEmpty)
    let older = try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"inboxGrouping":"project"}"#.utf8))
    #expect(older.sessionSort == .project, "a device that never chose keeps the project blocks")
    #expect(!older.queueFolded, "the queue above the box starts open")
    let byHost = try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"inboxGrouping":"host"}"#.utf8))
    #expect(byHost.inboxGrouping == .project, "the Inbox by host was its blocks, which go per host with hosts")
    #expect(try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"inboxGrouping":"status"}"#.utf8)).inboxGrouping == .status)
}

@Test func theInboxPutsPinsOnTopAndGoesByWhenEachLastSaidSomething() throws {
    func row(_ uid: String, status: String, activity: Double, said: Double? = nil, pinned: Bool = false) throws -> SessionRow {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try session(uid, title: uid, project: "ah").dto)) as! [String: Any]
        object["status"] = status
        object["activity"] = activity
        object["createdAt"] = 1
        object["pinned"] = pinned
        if let said { object["reply"] = ["role": "assistant", "text": "done", "at": said * 1000] }
        return SessionRow(key: uid, host: "desk", isLocal: true, dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    // Tmux says the agents all printed at 9000: their screens redrew together. Their
    // conversations say when each last said something.
    let rows = [
        try row("last-night", status: "idle", activity: 9000, said: 1000),
        try row("shell", status: "idle", activity: 5000),
        try row("this-morning", status: "attention", activity: 9000, said: 8000),
        try row("pinned", status: "idle", activity: 9000, said: 2000, pinned: true),
        try row("working", status: "busy", activity: 9500, said: 100),
        try row("working-pin", status: "busy", activity: 9400, pinned: true),
    ]
    let sections = InboxSections(rows: rows, reviews: [], hostsOnline: 1, hostsTotal: 1, narrow: true)
    #expect(sections.rest.map(\.key) == ["pinned", "this-morning", "shell", "last-night"])
    #expect(sections.running.map(\.key) == ["working-pin", "working"])
    #expect(rows[0].lastActive == 1000)
    #expect(rows[4].lastActive == 9500, "a working one is drawing its work: its output time is its own")
    #expect(SessionOrdering.byRecency(rows).map(\.key) == ["working-pin", "pinned", "working", "this-morning", "shell", "last-night"], "pins first, each band by its latest")
}

@Test func searchListsLiveAndPastSessionsAsTheQueryNarrowsThem() throws {
    let now = Date().timeIntervalSince1970
    func live(_ uid: String, project: String, host: String, active: Double) throws -> SessionRow {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try session(uid, title: uid, project: project).dto)) as! [String: Any]
        object["activity"] = active
        object["createdAt"] = active - 600
        return SessionRow(key: uid, host: host, isLocal: host == "desk", dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    func past(_ ref: String, project: String, host: String, at: Double) -> HistoryRow {
        HistoryRow(host: host, isLocal: host == "desk", dto: HistoryItemDTO(ref: ref, kind: .ended, harness: "claude", harnessId: nil, title: "Fix \(project)", cwd: "/code/\(project)", project: project, model: nil, at: at, pinned: false, worktree: nil, fork: nil))
    }
    let rows = [try live("a", project: "web", host: "desk", active: now - 60), try live("b", project: "api", host: "laptop", active: now - 3 * 86_400), try live("c", project: "web", host: "desk", active: now - 10)]
    let history = [past("x", project: "api", host: "desk", at: now - 3600), past("y", project: "web", host: "laptop", at: now - 9 * 86_400)]
    // Nothing typed: everything, the latest active first.
    #expect(HistoryFilter.live(rows, SearchQuery(q: "")).map(\.key) == ["c", "a", "b"])
    #expect(HistoryFilter.past(history, SearchQuery(q: "")).map(\.dto.ref) == ["x", "y"])
    #expect(HistoryFilter.live(rows, SearchQuery(q: "web")).map(\.key) == ["c", "a"])
    #expect(HistoryFilter.past(history, SearchQuery(q: "fix api")).map(\.dto.ref) == ["x"])
    // The chips narrow the lists too.
    #expect(HistoryFilter.live(rows, SearchQuery(q: "", host: "laptop")).map(\.key) == ["b"])
    #expect(HistoryFilter.past(history, SearchQuery(q: "", host: "laptop")).map(\.dto.ref) == ["y"])
    let pastDay = SearchQuery(q: "", from: (now - 86_400) * 1000)
    #expect(HistoryFilter.live(rows, pastDay).map(\.key) == ["c", "a"])
    #expect(HistoryFilter.past(history, pastDay).map(\.dto.ref) == ["x"])
}

@Test func searchsStatusChipKeepsTheSessionsInAnyOfThePickedStates() throws {
    func live(_ uid: String, _ status: String) throws -> SessionRow { try session(uid, title: uid, status: status, project: "web") }
    func past(_ ref: String, interrupted: Bool) -> HistoryRow {
        var dto = HistoryItemDTO(ref: ref, kind: .ended, harness: "claude", harnessId: nil, title: ref, cwd: "/code/web", project: "web", model: nil, at: 1, pinned: false, worktree: nil, fork: nil)
        if interrupted { dto.interrupted = InterruptedDTO(cause: "tmux_server", at: 1, incident: "tmux_server-1", lastStatus: "busy", midTurn: true) }
        return HistoryRow(host: "desk", isLocal: true, dto: dto)
    }
    let rows = [try live("asks", "waiting"), try live("runs", "busy"), try live("rests", "idle"), try live("done", "attention")]
    let history = [past("cut", interrupted: true), past("over", interrupted: false)]
    let all = SearchQuery(q: "")
    #expect(Set(HistoryFilter.live(rows, all).map(\.key)) == ["asks", "runs", "rests", "done"], "none picked: every one")
    #expect(HistoryFilter.live(rows, all, statuses: [.needsYou]).map(\.key) == ["asks"])
    #expect(Set(HistoryFilter.live(rows, all, statuses: [.working, .idle]).map(\.key)) == ["runs", "rests", "done"], "idle and done, as the Inbox has them")
    #expect(HistoryFilter.live(rows, all, statuses: [.interrupted]).isEmpty)
    #expect(HistoryFilter.past(history, all, statuses: [.interrupted]).map(\.dto.ref) == ["cut"])
    #expect(HistoryFilter.past(history, all, statuses: [.ended]).map(\.dto.ref) == ["over"])
    #expect(HistoryFilter.past(history, SearchQuery(q: "over"), statuses: [.interrupted]).isEmpty, "with the words, not instead of them")
    #expect(SessionStatusFilter.label([]) == "Any status")
    #expect(SessionStatusFilter.label([.interrupted, .working]) == "Working, Interrupted")
    #expect(SessionStatusFilter.label([.idle, .ended, .working]) == "3 statuses")
}

@Test func theInboxNarrowsToOneProjectOnAHost() throws {
    let rows = [try session("a", title: "Fix login", project: "web"), try session("b", title: "Rotate keys", project: "infra"), try session("c", title: "Other web", project: "web", host: "laptop")]
    let history = [HistoryRow(host: "desk", isLocal: true, dto: HistoryItemDTO(ref: "h", kind: .ended, harness: "claude", harnessId: nil, title: "Old", cwd: "/code/api", project: "api", model: nil, at: 0, pinned: false, worktree: nil, fork: nil))]
    let choices = InboxProject.choices(rows, history)
    #expect(choices == [InboxProject(host: "desk", name: "api"), InboxProject(host: "desk", name: "infra"), InboxProject(host: "desk", name: "web"), InboxProject(host: "laptop", name: "web")], "running and past, by name; one folder name on two hosts is two")
    let web = InboxProject(host: "desk", name: "web")
    #expect(rows.filter { web.holds($0) }.map(\.key) == ["a"])
    #expect(web.searchTerm(rows) == rows[0].dto.projectPath, "the index is asked by the project's path when a session knows it")
    #expect(InboxProject(host: "desk", name: "api").searchTerm(rows) == "api")
}

@Test func aNewSessionFromANarrowedInboxStartsInItsProject() throws {
    let rows = [try session("a", title: "Fix login", project: "web"), try session("b", title: "Peer", project: "infra", host: "laptop")]
    let remote = SessionRow(key: "laptop/b", host: "laptop", isLocal: false, dto: rows[1].dto)
    let history = [HistoryRow(host: "desk", isLocal: true, dto: HistoryItemDTO(ref: "h", kind: .ended, harness: "claude", harnessId: nil, title: "Old", cwd: "/code/api", project: "api", model: nil, at: 0, pinned: false, worktree: nil, fork: nil))]
    let live = [rows[0], remote]
    #expect(InboxProject(host: "desk", name: "web").place(live, history)! == ("/p/web", nil), "the project's folder, on the hub itself")
    #expect(InboxProject(host: "laptop", name: "infra").place(live, history)! == ("/p/infra", "laptop"), "a peer's project starts on the peer")
    #expect(InboxProject(host: "desk", name: "api").place(live, history)! == ("/code/api", nil), "only in History: where its conversation ran")
    #expect(InboxProject(host: "desk", name: "gone").place(live, history) == nil)
}

@Test func severalPicturesInAMessageSitInAPileUntilGridIsChosen() throws {
    let older = try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"inboxGrouping":"status"}"#.utf8))
    #expect(older.pictureLook == .stack, "a device that never chose sees the pile")
    var chosen = DevicePreferences()
    chosen.pictureLook = .grid
    let back = try JSONDecoder().decode(DevicePreferences.self, from: JSONEncoder().encode(chosen))
    #expect(back.pictureLook == .grid, "Grid is kept on this device")
    #expect(try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"pictureLook":"fan"}"#.utf8)).pictureLook == .stack, "one it doesn't know is the pile")
}
