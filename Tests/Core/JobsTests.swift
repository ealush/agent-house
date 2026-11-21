import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Jobs (`../ah/server/jobs`, feature `jobs` 1): the shapes the host sends (`JobView`, `RunView`,
// `JobsState`), the state stream's `jobs`, and the New/Edit Job form's round trip. Synthetic.

private let nightlyJSON = #"""
{"id":"jb-0a1b2c3d","name":"Nightly tests","state":"scheduled",
 "action":{"kind":"launch","preset":"claude","cwd":"/home/dev/orbit-api","prompt":"Run the tests and fix what fails.","model":"opus","effort":"high","worktree":true},
 "trigger":{"kind":"cron","expr":"30 2 * * *","tz":"Europe/London"},
 "policy":{"retries":2,"timeoutSeconds":3600,"notify":true,"concurrencyKey":"orbit"},
 "nextRunAt":1795000000,"runCount":4,"createdAt":1794000000,"updatedAt":1794500000,
 "lastRun":{"id":"jr-11112222","jobId":"jb-0a1b2c3d","seq":4,"state":"succeeded","triggeredBy":"schedule","scheduledFor":1794900000,"attempt":1,"sessionUid":"u-1","delivery":{"mark":10},"outcome":{"reply":"All 212 tests pass.\nNothing to fix."},"error":null,"startedAt":1794900001,"endedAt":1794900300,"createdAt":1794900000}}
"""#

private let deployJSON = #"""
{"id":"jb-99990000","name":"Deploy staging","state":"waiting",
 "action":{"kind":"decide","title":"Deploy orbit-web to staging?","body":"The nightly run passed.","then":{"kind":"send","target":"u-2","text":"Deploy to staging."}},
 "trigger":{"kind":"after","job":"jb-0a1b2c3d","on":"success"},
 "policy":{},"nextRunAt":null,"runCount":1,"createdAt":1794000000,"updatedAt":1794000000,"lastRun":null}
"""#

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Test func jobsDecodeAsTheHostSendsThem() throws {
    let nightly = try decode(JobDTO.self, nightlyJSON)
    #expect(nightly.name == "Nightly tests")
    guard case .launch(let launch) = nightly.action else { Issue.record("not a launch"); return }
    #expect(launch.preset == "claude" && launch.model == "opus" && launch.worktree == true)
    #expect(nightly.trigger == .cron(expr: "30 2 * * *", tz: "Europe/London"))
    #expect(nightly.policy.retries == 2 && nightly.policy.timeoutSeconds == 3600 && nightly.policy.concurrencyKey == "orbit")
    #expect(nightly.lastRun?.outcome.reply?.hasPrefix("All 212") == true)
    #expect(nightly.nextRunAt == 1795000000)

    let deploy = try decode(JobDTO.self, deployJSON)
    #expect(deploy.action == .decide(title: "Deploy orbit-web to staging?", body: "The nightly run passed.", then: .send(target: "u-2", text: "Deploy to staging.")))
    #expect(deploy.trigger == .after(job: "jb-0a1b2c3d", on: "success"))
    #expect(deploy.nextRunAt == nil && deploy.lastRun == nil)
}

@Test func aNewerHostsKindsDecodeAsUnknownNotAFailure() throws {
    let job = try decode(JobDTO.self, #"{"id":"jb-1","name":"x","state":"scheduled","action":{"kind":"webhook","url":"x"},"trigger":{"kind":"file","path":"/x"},"policy":{"retries":"many"},"nextRunAt":null,"runCount":0,"createdAt":0,"updatedAt":0,"lastRun":null}"#)
    #expect(job.action == .unknown("webhook"))
    #expect(job.trigger == .unknown("file"))
    #expect(job.policy.retries == nil, "a value of a shape it doesn't expect is left out")
    #expect(JobDraft(job) == nil, "nothing this build can't say is offered to edit")
    #expect(!JobsModel.editable(job))
}

@Test func aJobsDetailCarriesItsRuns() throws {
    let detail = try decode(JobDetailDTO.self, String(nightlyJSON.dropLast()) + #","runs":[{"id":"jr-a","jobId":"jb-0a1b2c3d","seq":2,"state":"uncertain","triggeredBy":"manual","scheduledFor":5,"attempt":2,"sessionUid":null,"delivery":{},"outcome":{},"error":null,"startedAt":6,"endedAt":null,"createdAt":5}]}"#)
    #expect(detail.job.id == "jb-0a1b2c3d")
    #expect(detail.runs.map(\.state) == ["uncertain"])
    #expect(detail.runs.first?.attempt == 2)
}

@Test func theStateStreamCarriesJobsAndPatchesThem() throws {
    var reducer = HubStateReducer()
    try reducer.apply(ServerSentEvent(name: "state", data: #"""
    {"api":28,"hostname":"hub","hosts":[{"name":"hub","self":true,"online":true}],"windows":[],"features":{"jobs":1},
     "jobs":{"next":[{"id":"jb-1","name":"Nightly","at":10}],"running":[],"waiting":[{"id":"jb-2","name":"Deploy","runId":"jr-2","title":"Deploy?","body":""}],"uncertain":[]}}
    """#))
    #expect(reducer.state?.jobs?.waiting.first?.runId == "jr-2")
    #expect(reducer.state?.jobs?.next.first?.at == 10)
    try reducer.apply(ServerSentEvent(name: "patch", data: #"{"windows":[]}"#))
    #expect(reducer.state?.jobs?.waiting.count == 1, "a patch that leaves jobs out keeps them")
    try reducer.apply(ServerSentEvent(name: "patch", data: #"{"jobs":{"next":[],"running":[{"id":"jb-2","name":"Deploy","runId":"jr-3","sessionUid":null}],"waiting":[],"uncertain":[{"id":"jb-1","name":"Nightly","runId":"jr-9"}]}}"#))
    #expect(reducer.state?.jobs?.waiting.isEmpty == true)
    #expect(reducer.state?.jobs?.uncertain.first?.runId == "jr-9")
    // A list this build can't read is no change to the others, and never a broken stream.
    try reducer.apply(ServerSentEvent(name: "patch", data: #"{"jobs":{"next":"soon","uncertain":[{"id":"jb-1","name":"Nightly","runId":"jr-9"}]}}"#))
    #expect(reducer.state?.jobs?.uncertain.count == 1)
    #expect(reducer.state?.jobs?.next.isEmpty == true)
    try reducer.apply(ServerSentEvent(name: "patch", data: #"{"jobs":null}"#))
    #expect(reducer.state?.jobs == nil)
}

@Test func anOlderHostHasNoJobs() throws {
    var reducer = HubStateReducer()
    try reducer.apply(ServerSentEvent(name: "state", data: #"{"api":28,"hostname":"hub","hosts":[{"name":"hub","self":true,"online":true}],"windows":[]}"#))
    let state = try #require(reducer.state)
    #expect(state.jobs == nil)
    #expect(!state.supports("jobs"))
}

@Test func actionsAndTriggersEncodeAsTheHostReadsThem() throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    func json(_ value: some Encodable) throws -> String { String(decoding: try encoder.encode(value), as: UTF8.self) }
    #expect(try json(JobActionDTO.launch(JobLaunchDTO(preset: "codex", cwd: "~/x", prompt: "Go"))) == #"{"cwd":"~\/x","kind":"launch","preset":"codex","prompt":"Go"}"#)
    #expect(try json(JobActionDTO.decide(title: "Ship?", body: nil, then: .launch(JobLaunchDTO(preset: "claude", cwd: "/a", prompt: "Ship it")))) == #"{"kind":"decide","then":{"cwd":"\/a","kind":"launch","preset":"claude","prompt":"Ship it"},"title":"Ship?"}"#)
    #expect(try json(JobTriggerDTO.at(1795000000.7)) == #"{"at":1795000000,"kind":"at"}"#)
    #expect(try json(JobTriggerDTO.session(uid: "u-1", on: "ended")) == #"{"kind":"session","on":"ended","uid":"u-1"}"#)
    #expect(try json(JobTriggerDTO.manual) == #"{"kind":"manual"}"#)
    #expect(try json(JobPolicyDTO(retries: 3)) == #"{"retries":3}"#, "what isn't set is left to the host")
}

@Test func aJobComesBackFromTheFormAsItWent() throws {
    for text in [nightlyJSON, deployJSON] {
        let job = try decode(JobDTO.self, text)
        let draft = try #require(JobDraft(job))
        let body = draft.request()
        #expect(body.name == job.name)
        #expect(body.action == job.action)
        #expect(body.trigger == job.trigger)
        #expect(body.policy == job.policy, "what the form doesn't show (a concurrency key) is kept")
    }
    let nightly = try #require(JobDraft(try decode(JobDTO.self, nightlyJSON)))
    #expect(nightly.when == .daily && nightly.hour == 2 && nightly.minute == 30 && nightly.timeZone == "Europe/London")
    #expect(nightly.timeoutMinutes == 60 && nightly.notify)
}

@Test func theFormSaysWhatsMissing() {
    var draft = JobDraft(preset: "claude", cwd: "~/code/orbit")
    #expect(draft.missing == "Say what to ask the agent.")
    draft.prompt = "Run the tests."
    #expect(draft.missing == nil)
    #expect(draft.shownName == "Run the tests.", "an unnamed job takes its first line")
    draft.cwd = "orbit"
    #expect(draft.missing == "Choose a folder (a full path).")
    draft.cwd = "/srv/orbit"
    draft.when = .after
    #expect(draft.missing == "Choose the job it follows.")
    draft.afterJob = "jb-1"
    #expect(draft.missing == nil)
    draft.kind = .decide
    #expect(draft.missing == "Say what to ask you.")
    draft.title = "Deploy?"
    draft.followUp = .send
    #expect(draft.missing == "Choose a session to message.")
    draft.followUp = .none
    #expect(draft.missing == nil)
    #expect(draft.action == .decide(title: "Deploy?", body: nil, then: nil))
    draft.when = .cron
    draft.cronExpr = "every morning"
    #expect(draft.missing?.hasPrefix("A schedule has five fields") == true)
}

@Test func theFormsWhenBecomesTheHostsTrigger() {
    var draft = JobDraft(preset: "claude", cwd: "/a")
    draft.timeZone = "UTC"
    draft.hour = 7
    draft.minute = 5
    draft.when = .weekdays
    #expect(draft.trigger == .cron(expr: "5 7 * * 1-5", tz: "UTC"))
    draft.when = .daily
    #expect(draft.trigger == .cron(expr: "5 7 * * *", tz: "UTC"))
    draft.when = .now
    #expect(draft.trigger == .manual, "now is a manual job run once on creation")
    draft.when = .session
    draft.sessionUid = "u-7"
    #expect(draft.trigger == .session(uid: "u-7", on: "idle"))
}

@Test func jobsReadAsTheWebSaysThem() throws {
    let utc = TimeZone(identifier: "UTC")!
    let jobs = [try decode(JobDTO.self, nightlyJSON)]
    #expect(JobsModel.triggerWords(.cron(expr: "0 9 * * 1-5", tz: "UTC"), jobs: jobs, timeZone: utc) == "Weekdays at 09:00")
    #expect(JobsModel.triggerWords(.cron(expr: "30 2 * * *", tz: "Europe/London"), jobs: jobs, timeZone: utc) == "Every day at 02:30 (Europe/London)")
    #expect(JobsModel.triggerWords(.cron(expr: "*/15 * * * *", tz: "UTC"), jobs: jobs, timeZone: utc) == "On schedule */15 * * * *")
    #expect(JobsModel.triggerWords(.after(job: "jb-0a1b2c3d", on: "failure"), jobs: jobs) == "After Nightly tests fails")
    #expect(JobsModel.triggerWords(.after(job: "jb-gone", on: "any"), jobs: jobs) == "After jb-gone")
    #expect(JobsModel.triggerWords(.manual, jobs: jobs) == "When you run it")
    let claude = try decode(PresetDTO.self, #"{"id":"claude","name":"Claude Code","command":"claude","available":true}"#)
    #expect(JobsModel.actionWords(jobs[0].action, presets: [claude]) == "Starts Claude Code")
    #expect(JobsModel.actionWords(.decide(title: "x", body: nil, then: nil), presets: []) == "Asks you")
    #expect(JobsModel.runWord("uncertain") == "Not sure it arrived")
    #expect(JobsModel.stateWord("waiting") == "Needs you")
    let run = try #require(jobs[0].lastRun)
    #expect(JobsModel.runDetail(run, now: Date(timeIntervalSince1970: 1794900001 + 7200), locale: Locale(identifier: "en_US")) == "2 hours ago · All 212 tests pass.")
}

@Test func aJobsActionsFollowItsState() {
    #expect(JobsModel.verbs(for: "scheduled") == [.run, .pause, .cancel])
    #expect(JobsModel.verbs(for: "paused") == [.run, .resume, .cancel])
    #expect(JobsModel.verbs(for: "done") == [.run])
    #expect(JobsModel.verbs(for: "cancelled") == [])
    let weekdays = Cron.daily("0 9 * * 1-5")
    #expect(weekdays?.hour == 9 && weekdays?.minute == 0 && weekdays?.weekdays == true)
    #expect(Cron.daily("0 9 1 * *") == nil)
    #expect(Cron.daily("61 9 * * *") == nil)
}
