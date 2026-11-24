import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Scheduled and conditional agent work on the host (`apps/server/server/jobs`, feature `jobs` 1):
// a job starts an agent, messages a session, or asks you, at a time, on a schedule, after
// another job, or when a session settles. Times are epoch seconds. A run that may or may not
// have reached its agent is `uncertain`, never sent again on its own: you choose.

/// What a job does.
enum JobActionDTO: Codable, Equatable, Sendable {
    /// Start an agent in a folder with a first message.
    case launch(JobLaunchDTO)
    /// Type a message into a session (`target`: its uid, or `harness:harnessId`).
    case send(target: String, text: String)
    /// Ask you; going ahead runs `then`, if there is one.
    case decide(title: String, body: String?, then: JobFollowUpDTO?)
    /// A kind this build doesn't know (a newer host's).
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case kind, target, text, title, body, then }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        switch kind {
        case "launch": self = .launch(try JobLaunchDTO(from: decoder))
        case "send": self = .send(target: try c.decodeIfPresent(String.self, forKey: .target) ?? "", text: try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        case "decide":
            self = .decide(title: try c.decodeIfPresent(String.self, forKey: .title) ?? "", body: try c.decodeIfPresent(String.self, forKey: .body), then: try? c.decodeIfPresent(JobFollowUpDTO.self, forKey: .then))
        default: self = .unknown(kind)
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .launch(let launch):
            try launch.encode(to: encoder)
        case .send(let target, let text):
            try c.encode("send", forKey: .kind)
            try c.encode(target, forKey: .target)
            try c.encode(text, forKey: .text)
        case .decide(let title, let body, let then):
            try c.encode("decide", forKey: .kind)
            try c.encode(title, forKey: .title)
            try c.encodeIfPresent(body, forKey: .body)
            try c.encodeIfPresent(then, forKey: .then)
        case .unknown(let kind):
            try c.encode(kind, forKey: .kind)
        }
    }
}

/// What a decision runs once you say go ahead: a launch or a message, never another decision.
enum JobFollowUpDTO: Codable, Equatable, Sendable {
    case launch(JobLaunchDTO)
    case send(target: String, text: String)

    init(from decoder: any Decoder) throws {
        switch try JobActionDTO(from: decoder) {
        case .launch(let launch): self = .launch(launch)
        case .send(let target, let text): self = .send(target: target, text: text)
        default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a decision's follow-up is a launch or a send"))
        }
    }

    func encode(to encoder: any Encoder) throws {
        switch self {
        case .launch(let launch): try JobActionDTO.launch(launch).encode(to: encoder)
        case .send(let target, let text): try JobActionDTO.send(target: target, text: text).encode(to: encoder)
        }
    }
}

struct JobLaunchDTO: Codable, Equatable, Sendable {
    var preset: String
    var cwd: String
    var prompt: String
    var name: String?
    var model: String?
    var effort: String?
    var mode: String?
    var worktree: Bool?

    private enum CodingKeys: String, CodingKey { case kind, preset, cwd, prompt, name, model, effort, mode, worktree }

    init(preset: String, cwd: String, prompt: String, name: String? = nil, model: String? = nil, effort: String? = nil, mode: String? = nil, worktree: Bool? = nil) {
        self.preset = preset
        self.cwd = cwd
        self.prompt = prompt
        self.name = name
        self.model = model
        self.effort = effort
        self.mode = mode
        self.worktree = worktree
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        preset = try c.decodeIfPresent(String.self, forKey: .preset) ?? ""
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        effort = try c.decodeIfPresent(String.self, forKey: .effort)
        mode = try c.decodeIfPresent(String.self, forKey: .mode)
        worktree = try c.decodeIfPresent(Bool.self, forKey: .worktree)
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("launch", forKey: .kind)
        try c.encode(preset, forKey: .preset)
        try c.encode(cwd, forKey: .cwd)
        try c.encode(prompt, forKey: .prompt)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(effort, forKey: .effort)
        try c.encodeIfPresent(mode, forKey: .mode)
        try c.encodeIfPresent(worktree, forKey: .worktree)
    }
}

/// When a job runs.
enum JobTriggerDTO: Codable, Equatable, Sendable {
    case at(Double)
    /// Five-field cron in a time zone (`0 9 * * 1-5`, `Europe/London`).
    case cron(expr: String, tz: String)
    /// After another job's run ends: `on` is success, failure or any.
    case after(job: String, on: String)
    /// When a session finishes a turn (`idle`) or ends (`ended`).
    case session(uid: String, on: String)
    /// Only when run by hand.
    case manual
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case kind, at, expr, tz, job, on, uid }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        switch kind {
        case "at": self = .at(try c.decodeIfPresent(Double.self, forKey: .at) ?? 0)
        case "cron": self = .cron(expr: try c.decodeIfPresent(String.self, forKey: .expr) ?? "", tz: try c.decodeIfPresent(String.self, forKey: .tz) ?? "UTC")
        case "after": self = .after(job: try c.decodeIfPresent(String.self, forKey: .job) ?? "", on: try c.decodeIfPresent(String.self, forKey: .on) ?? "success")
        case "session": self = .session(uid: try c.decodeIfPresent(String.self, forKey: .uid) ?? "", on: try c.decodeIfPresent(String.self, forKey: .on) ?? "idle")
        case "manual": self = .manual
        default: self = .unknown(kind)
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .at(let at):
            try c.encode("at", forKey: .kind)
            try c.encode(Int(at), forKey: .at)
        case .cron(let expr, let tz):
            try c.encode("cron", forKey: .kind)
            try c.encode(expr, forKey: .expr)
            try c.encode(tz, forKey: .tz)
        case .after(let job, let on):
            try c.encode("after", forKey: .kind)
            try c.encode(job, forKey: .job)
            try c.encode(on, forKey: .on)
        case .session(let uid, let on):
            try c.encode("session", forKey: .kind)
            try c.encode(uid, forKey: .uid)
            try c.encode(on, forKey: .on)
        case .manual:
            try c.encode("manual", forKey: .kind)
        case .unknown(let kind):
            try c.encode(kind, forKey: .kind)
        }
    }
}

/// How a job runs: retries, limits, notices. Every field optional; the host's defaults fill in.
struct JobPolicyDTO: Codable, Equatable, Sendable {
    var maxRuns: Int?
    var retries: Int?
    var backoffSeconds: Int?
    var timeoutSeconds: Int?
    /// `finished` (the default): the turn ended. `delivered`: the agent took the message.
    var until: String?
    var concurrencyKey: String?
    var notify: Bool?
    var allowDangerous: Bool?
    var autoRecover: Bool?

    init(maxRuns: Int? = nil, retries: Int? = nil, backoffSeconds: Int? = nil, timeoutSeconds: Int? = nil, until: String? = nil, concurrencyKey: String? = nil, notify: Bool? = nil, allowDangerous: Bool? = nil, autoRecover: Bool? = nil) {
        self.maxRuns = maxRuns
        self.retries = retries
        self.backoffSeconds = backoffSeconds
        self.timeoutSeconds = timeoutSeconds
        self.until = until
        self.concurrencyKey = concurrencyKey
        self.notify = notify
        self.allowDangerous = allowDangerous
        self.autoRecover = autoRecover
    }

    // A value of a shape this build doesn't expect is left out, never a job that won't decode.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        maxRuns = try? c.decodeIfPresent(Int.self, forKey: .maxRuns)
        retries = try? c.decodeIfPresent(Int.self, forKey: .retries)
        backoffSeconds = try? c.decodeIfPresent(Int.self, forKey: .backoffSeconds)
        timeoutSeconds = try? c.decodeIfPresent(Int.self, forKey: .timeoutSeconds)
        until = try? c.decodeIfPresent(String.self, forKey: .until)
        concurrencyKey = try? c.decodeIfPresent(String.self, forKey: .concurrencyKey)
        notify = try? c.decodeIfPresent(Bool.self, forKey: .notify)
        allowDangerous = try? c.decodeIfPresent(Bool.self, forKey: .allowDangerous)
        autoRecover = try? c.decodeIfPresent(Bool.self, forKey: .autoRecover)
    }
}

/// One run of a job.
struct JobRunDTO: Codable, Equatable, Sendable, Identifiable {
    struct Outcome: Codable, Equatable, Sendable {
        var reply: String?
        var body: String?
        var decision: String?
        var note: String?
        var skippedBecause: String?
    }

    var id: String
    var jobId: String
    var seq: Int
    /// eligible, running, succeeded, failed, uncertain, cancelled, skipped, waiting.
    var state: String
    var triggeredBy: String
    var scheduledFor: Double
    var attempt: Int
    var sessionUid: String?
    var outcome: Outcome
    var error: String?
    var startedAt: Double?
    var endedAt: Double?
    var createdAt: Double

    private enum CodingKeys: String, CodingKey { case id, jobId, seq, state, triggeredBy, scheduledFor, attempt, sessionUid, outcome, error, startedAt, endedAt, createdAt }

    init(id: String, jobId: String, seq: Int = 1, state: String, triggeredBy: String = "manual", scheduledFor: Double = 0, attempt: Int = 1, sessionUid: String? = nil, outcome: Outcome = Outcome(), error: String? = nil, startedAt: Double? = nil, endedAt: Double? = nil, createdAt: Double = 0) {
        self.id = id
        self.jobId = jobId
        self.seq = seq
        self.state = state
        self.triggeredBy = triggeredBy
        self.scheduledFor = scheduledFor
        self.attempt = attempt
        self.sessionUid = sessionUid
        self.outcome = outcome
        self.error = error
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.createdAt = createdAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId) ?? ""
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
        triggeredBy = try c.decodeIfPresent(String.self, forKey: .triggeredBy) ?? ""
        scheduledFor = try c.decodeIfPresent(Double.self, forKey: .scheduledFor) ?? 0
        attempt = try c.decodeIfPresent(Int.self, forKey: .attempt) ?? 1
        sessionUid = try c.decodeIfPresent(String.self, forKey: .sessionUid)
        outcome = (try? c.decodeIfPresent(Outcome.self, forKey: .outcome)) ?? Outcome()
        error = try c.decodeIfPresent(String.self, forKey: .error)
        startedAt = try c.decodeIfPresent(Double.self, forKey: .startedAt)
        endedAt = try c.decodeIfPresent(Double.self, forKey: .endedAt)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
    }
}

struct JobDTO: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    /// scheduled, waiting, paused, done, failed, cancelled.
    var state: String
    var action: JobActionDTO
    var trigger: JobTriggerDTO
    var policy: JobPolicyDTO
    var nextRunAt: Double?
    var runCount: Int
    var createdBy: String?
    var createdAt: Double
    var updatedAt: Double
    var lastRun: JobRunDTO?

    private enum CodingKeys: String, CodingKey { case id, name, state, action, trigger, policy, nextRunAt, runCount, createdBy, createdAt, updatedAt, lastRun }

    init(id: String, name: String, state: String = "scheduled", action: JobActionDTO, trigger: JobTriggerDTO, policy: JobPolicyDTO = JobPolicyDTO(), nextRunAt: Double? = nil, runCount: Int = 0, createdBy: String? = nil, createdAt: Double = 0, updatedAt: Double = 0, lastRun: JobRunDTO? = nil) {
        self.id = id
        self.name = name
        self.state = state
        self.action = action
        self.trigger = trigger
        self.policy = policy
        self.nextRunAt = nextRunAt
        self.runCount = runCount
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastRun = lastRun
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Job"
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
        action = (try? c.decode(JobActionDTO.self, forKey: .action)) ?? .unknown("")
        trigger = (try? c.decode(JobTriggerDTO.self, forKey: .trigger)) ?? .unknown("")
        policy = (try? c.decodeIfPresent(JobPolicyDTO.self, forKey: .policy)) ?? JobPolicyDTO()
        nextRunAt = try c.decodeIfPresent(Double.self, forKey: .nextRunAt)
        runCount = try c.decodeIfPresent(Int.self, forKey: .runCount) ?? 0
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        lastRun = try? c.decodeIfPresent(JobRunDTO.self, forKey: .lastRun)
    }
}

/// A job with its runs, newest first (`GET /api/jobs/:id`).
struct JobDetailDTO: Decodable, Equatable, Sendable {
    var job: JobDTO
    var runs: [JobRunDTO]

    private enum CodingKeys: String, CodingKey { case runs }

    init(job: JobDTO, runs: [JobRunDTO]) {
        self.job = job
        self.runs = runs
    }

    init(from decoder: any Decoder) throws {
        job = try JobDTO(from: decoder)
        runs = (try? decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([JobRunDTO].self, forKey: .runs)) ?? []
    }
}

/// State's `jobs`: what's next, running, waiting for your decision, and not sure it arrived.
struct JobsStateDTO: Codable, Equatable, Sendable {
    struct Next: Codable, Equatable, Sendable { var id: String; var name: String; var at: Double }
    struct Running: Codable, Equatable, Sendable { var id: String; var name: String; var runId: String; var sessionUid: String? }
    struct Waiting: Codable, Equatable, Sendable, Identifiable {
        var id: String
        var name: String
        var runId: String
        var title: String
        var body: String
    }
    struct Uncertain: Codable, Equatable, Sendable { var id: String; var name: String; var runId: String }

    var next: [Next]
    var running: [Running]
    var waiting: [Waiting]
    var uncertain: [Uncertain]

    init(next: [Next] = [], running: [Running] = [], waiting: [Waiting] = [], uncertain: [Uncertain] = []) {
        self.next = next
        self.running = running
        self.waiting = waiting
        self.uncertain = uncertain
    }

    private enum CodingKeys: String, CodingKey { case next, running, waiting, uncertain }

    // One list this build can't read leaves the others.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        next = (try? c.decodeIfPresent([Next].self, forKey: .next)) ?? []
        running = (try? c.decodeIfPresent([Running].self, forKey: .running)) ?? []
        waiting = (try? c.decodeIfPresent([Waiting].self, forKey: .waiting)) ?? []
        uncertain = (try? c.decodeIfPresent([Uncertain].self, forKey: .uncertain)) ?? []
    }
}

struct JobsList: Decodable, Sendable {
    var jobs: [JobDTO]
    var state: JobsStateDTO?
}

/// A new job, or the parts of one to change (`nil` leaves a part as it is).
struct JobDraftBody: Encodable, Sendable {
    var name: String?
    var action: JobActionDTO?
    var trigger: JobTriggerDTO?
    var policy: JobPolicyDTO?
}

enum JobVerb: String, Sendable { case pause, resume, cancel, run }

extension APIClient {
    func jobs() async throws -> JobsList { try await call("GET", "/api/jobs") }
    func job(_ id: String) async throws -> JobDetailDTO { try await call("GET", "/api/jobs/\(Self.enc(id))") }
    func createJob(_ body: JobDraftBody) async throws -> JobDTO { try await call("POST", "/api/jobs", json: body) }
    func updateJob(_ id: String, _ body: JobDraftBody) async throws -> JobDTO { try await call("PATCH", "/api/jobs/\(Self.enc(id))", json: body) }
    /// Pause, resume and cancel answer with the job; run with the run it made.
    func jobVerb(_ id: String, _ verb: JobVerb) async throws {
        // Each path written out, so scripts/backend-coverage.mjs reads every one.
        switch verb {
        case .pause: try await perform("POST", "/api/jobs/\(Self.enc(id))/pause")
        case .resume: try await perform("POST", "/api/jobs/\(Self.enc(id))/resume")
        case .cancel: try await perform("POST", "/api/jobs/\(Self.enc(id))/cancel")
        case .run: try await perform("POST", "/api/jobs/\(Self.enc(id))/run")
        }
    }
    func jobRun(_ id: String) async throws -> JobRunDTO { try await call("GET", "/api/jobs/runs/\(Self.enc(id))") }
    func decideRun(_ id: String, approve: Bool, note: String? = nil) async throws -> JobRunDTO {
        try await call("POST", "/api/jobs/runs/\(Self.enc(id))/decide", json: DecideBody(approve: approve, note: note))
    }
    /// A run not sure to have arrived: send it again, or leave it.
    func resolveRun(_ id: String, resend: Bool) async throws -> JobRunDTO {
        try await call("POST", "/api/jobs/runs/\(Self.enc(id))/resolve", json: ["resend": resend])
    }
}

private struct DecideBody: Encodable, Sendable {
    var approve: Bool
    var note: String?
}
