import Foundation

/// Scheduled and conditional agent work on the host (`apps/server/web/JobsView.tsx`, `server/jobs`):
/// the jobs and their runs, what they wait on, and the actions on them. The host's state
/// carries the summary (`state.jobs`); the list follows it.
@MainActor
@Observable
final class JobsModel {
    let api: APIClient
    private(set) var jobs: [JobDTO] = []
    /// Runs of the jobs looked at, newest first, by job id.
    private(set) var runs: [String: [JobRunDTO]] = [:]
    private(set) var error: String?
    /// The host has listed them once: before that, "No Jobs" would be a guess.
    private(set) var loaded = false
    /// Jobs and runs with a request out: their buttons wait for it.
    private(set) var busy: Set<String> = []

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            jobs = try await settled { [api] in try await api.jobs() }.jobs
            error = nil
            loaded = true
        } catch {
            if let shown = APIError.shown(error) { self.error = shown }
        }
    }

    func loadRuns(_ id: String) async {
        do {
            let detail = try await settled { [api] in try await api.job(id) }
            runs[id] = detail.runs
            if let i = jobs.firstIndex(where: { $0.id == id }) { jobs[i] = detail.job }
        } catch {
            if let shown = APIError.shown(error) { self.error = shown }
        }
    }

    func job(_ id: String) -> JobDTO? { jobs.first { $0.id == id } }

    /// Run Now, Pause, Resume, Cancel; then the list and that job's runs as the host has them.
    func act(_ id: String, _ verb: JobVerb) async -> Bool {
        await guarded(id) { [api] in try await api.jobVerb(id, verb) } then: { [self] in
            await load()
            if runs[id] != nil { await loadRuns(id) }
        }
    }

    /// A decision's answer: going ahead runs its follow-up.
    func decide(run: String, approve: Bool, note: String? = nil) async -> Bool {
        await guarded(run) { [api] in _ = try await api.decideRun(run, approve: approve, note: note) } then: { [self] in await load() }
    }

    /// A run not sure to have arrived: send it again, or leave it.
    func resolve(run: String, resend: Bool) async -> Bool {
        await guarded(run) { [api] in _ = try await api.resolveRun(run, resend: resend) } then: { [self] in await load() }
    }

    /// Creates the job (and runs it once, for "Now"); nil when the host refused, with its reason in `error`.
    func create(_ draft: JobDraft) async -> JobDTO? {
        do {
            let job = try await api.createJob(draft.request())
            if draft.when == .now { try await api.jobVerb(job.id, .run) }
            error = nil
            await load()
            return job
        } catch {
            self.error = APIError.wrap(error).message
            return nil
        }
    }

    func update(_ id: String, _ draft: JobDraft) async -> JobDTO? {
        do {
            let job = try await api.updateJob(id, draft.request())
            error = nil
            await load()
            if runs[id] != nil { await loadRuns(id) }
            return job
        } catch {
            self.error = APIError.wrap(error).message
            return nil
        }
    }

    func clearError() { error = nil }

    private func guarded(_ key: String, _ request: @escaping @Sendable () async throws -> Void, then: () async -> Void) async -> Bool {
        guard !busy.contains(key) else { return false }
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            try await request()
            error = nil
            await then()
            return true
        } catch {
            self.error = APIError.wrap(error).message
            return false
        }
    }

    // MARK: Words

    /// A job's state as the web says it.
    nonisolated static func stateWord(_ state: String) -> String {
        switch state {
        case "scheduled": return "Scheduled"
        case "waiting": return "Needs you"
        case "paused": return "Paused"
        case "done": return "Done"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        default: return state.capitalized
        }
    }

    nonisolated static func runWord(_ state: String) -> String {
        switch state {
        case "eligible": return "Waiting its turn"
        case "running": return "Running"
        case "succeeded": return "Done"
        case "failed": return "Failed"
        case "uncertain": return "Not sure it arrived"
        case "cancelled": return "Cancelled"
        case "skipped": return "Skipped"
        case "waiting": return "Needs you"
        default: return state.capitalized
        }
    }

    /// What can be done to a job in this state.
    nonisolated static func verbs(for state: String) -> [JobVerb] {
        var out: [JobVerb] = []
        if state != "cancelled" { out.append(.run) }
        if state == "paused" { out.append(.resume) } else if state == "scheduled" || state == "waiting" { out.append(.pause) }
        if state != "cancelled" && state != "done" { out.append(.cancel) }
        return out
    }

    /// A job that can still be changed (the host refuses an edit to a finished one).
    nonisolated static func editable(_ job: JobDTO) -> Bool {
        job.state != "done" && job.state != "cancelled" && JobDraft(job) != nil
    }

    /// A trigger as you'd say it: "Every day at 09:00", "After Nightly tests succeeds".
    nonisolated static func triggerWords(_ trigger: JobTriggerDTO, jobs: [JobDTO], timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        switch trigger {
        case .at(let at): return "At \(when(at, timeZone: timeZone, locale: locale))"
        case .cron(let expr, let tz):
            let zone = TimeZone(identifier: tz) == timeZone || tz == timeZone.identifier ? "" : " (\(tz))"
            if let daily = Cron.daily(expr) {
                return "\(daily.weekdays ? "Weekdays" : "Every day") at \(String(format: "%02d:%02d", daily.hour, daily.minute))\(zone)"
            }
            return "On schedule \(expr)\(zone)"
        case .after(let job, let on):
            let name = jobs.first { $0.id == job }?.name ?? job
            switch on {
            case "any": return "After \(name)"
            case "failure": return "After \(name) fails"
            default: return "After \(name) succeeds"
            }
        case .session(_, let on): return on == "ended" ? "When its session ends" : "When its session finishes a turn"
        case .manual: return "When you run it"
        case .unknown: return "On a trigger this app doesn't know"
        }
    }

    /// What a job does, in a few words: the agent's name by its preset.
    nonisolated static func actionWords(_ action: JobActionDTO, presets: [PresetDTO]) -> String {
        func agent(_ id: String) -> String { presets.first { $0.id == id }?.name ?? id }
        switch action {
        case .launch(let launch): return "Starts \(agent(launch.preset))"
        case .send: return "Messages a session"
        case .decide(_, _, let then):
            switch then {
            case .launch(let launch): return "Asks you, then starts \(agent(launch.preset))"
            case .send: return "Asks you, then messages a session"
            case nil: return "Asks you"
            }
        case .unknown: return "Does something this app doesn't know"
        }
    }

    /// A run's line: when, which try, and what came of it.
    nonisolated static func runDetail(_ run: JobRunDTO, now: Date = Date(), timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        var parts: [String] = []
        if let started = run.startedAt { parts.append(ago(started, now: now, locale: locale)) } else if run.scheduledFor > 0 { parts.append("Due \(when(run.scheduledFor, timeZone: timeZone, locale: locale))") }
        if run.attempt > 1 { parts.append("try \(run.attempt)") }
        if let error = run.error, !error.isEmpty { parts.append(error) } else if let why = run.outcome.skippedBecause { parts.append(why) } else if let reply = run.outcome.reply {
            // Its first line as words: the agent's Markdown marks (**, `) left out.
            let line = String(reply.split(separator: "\n", omittingEmptySubsequences: true).first ?? "").replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            parts.append(String(line.prefix(140)))
        }
        return parts.joined(separator: " · ")
    }

    nonisolated static func when(_ at: Double, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.setLocalizedDateFormatFromTemplate("EEE d MMM HH:mm")
        return f.string(from: Date(timeIntervalSince1970: at))
    }

    nonisolated static func ago(_ at: Double, now: Date = Date(), locale: Locale = .current) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = locale
        f.unitsStyle = .full
        return f.localizedString(for: Date(timeIntervalSince1970: at), relativeTo: now)
    }
}

/// The five-field cron shapes the form writes (daily and weekdays at a time), read back.
enum Cron {
    static func daily(_ expr: String) -> (hour: Int, minute: Int, weekdays: Bool)? {
        let f = expr.split(separator: " ").map(String.init)
        guard f.count == 5, let minute = Int(f[0]), let hour = Int(f[1]), (0..<60).contains(minute), (0..<24).contains(hour), f[2] == "*", f[3] == "*", f[4] == "*" || f[4] == "1-5" else { return nil }
        return (hour, minute, f[4] == "1-5")
    }

    static func expr(hour: Int, minute: Int, weekdays: Bool) -> String { "\(minute) \(hour) * * \(weekdays ? "1-5" : "*")" }
}

/// A job as the New and Edit Job form holds it: every choice the host takes, in the form's
/// words, and the body it sends.
struct JobDraft: Equatable, Sendable {
    enum Kind: String, CaseIterable, Sendable { case launch, send, decide }
    enum When: String, CaseIterable, Sendable { case now, at, daily, weekdays, cron, after, session, manual }
    enum FollowUp: String, CaseIterable, Sendable { case none, launch, send }

    var name = ""
    var kind = Kind.launch
    // Start an agent (also a decision's follow-up)
    var preset = ""
    var cwd = ""
    var prompt = ""
    var model: String?
    var effort: String?
    var mode: String?
    var worktree = false
    // Message a session (also a decision's follow-up)
    var target = ""
    var text = ""
    // Ask me
    var title = ""
    var body = ""
    var followUp = FollowUp.launch
    // When
    var when = When.now
    var at = Date().addingTimeInterval(3600)
    var hour = 9
    var minute = 0
    var cronExpr = "0 9 * * *"
    var timeZone = TimeZone.current.identifier
    var afterJob = ""
    var afterOn = "success"
    var sessionUid = ""
    var sessionOn = "idle"
    // Policy
    var retries = 0
    var timeoutMinutes = 0
    var maxRuns = 0
    var notify = false
    var autoRecover = false
    var allowDangerous = false
    var untilDelivered = false
    /// What the job had that the form doesn't change (kept as it was).
    var keptPolicy = JobPolicyDTO()

    init(preset: String = "", cwd: String = "") {
        self.preset = preset
        self.cwd = cwd
    }

    /// A job as the form shows it; nil for an action or trigger this build can't edit.
    init?(_ job: JobDTO) {
        name = job.name
        switch job.action {
        case .launch(let l):
            kind = .launch
            fill(l)
        case .send(let target, let text):
            kind = .send
            self.target = target
            self.text = text
        case .decide(let title, let body, let then):
            kind = .decide
            self.title = title
            self.body = body ?? ""
            switch then {
            case .launch(let l): followUp = .launch; fill(l)
            case .send(let target, let text): followUp = .send; self.target = target; self.text = text
            case nil: followUp = .none
            }
        case .unknown: return nil
        }
        switch job.trigger {
        case .at(let at): when = .at; self.at = Date(timeIntervalSince1970: at)
        case .cron(let expr, let tz):
            timeZone = tz
            cronExpr = expr
            if let d = Cron.daily(expr) { when = d.weekdays ? .weekdays : .daily; hour = d.hour; minute = d.minute } else { when = .cron }
        case .after(let job, let on): when = .after; afterJob = job; afterOn = on
        case .session(let uid, let on): when = .session; sessionUid = uid; sessionOn = on
        case .manual: when = .manual
        case .unknown: return nil
        }
        let p = job.policy
        retries = p.retries ?? 0
        timeoutMinutes = (p.timeoutSeconds ?? 0) / 60
        maxRuns = p.maxRuns ?? 0
        notify = p.notify ?? false
        autoRecover = p.autoRecover ?? false
        allowDangerous = p.allowDangerous ?? false
        untilDelivered = p.until == "delivered"
        keptPolicy = p
    }

    private mutating func fill(_ l: JobLaunchDTO) {
        preset = l.preset
        cwd = l.cwd
        prompt = l.prompt
        model = l.model
        effort = l.effort
        mode = l.mode
        worktree = l.worktree ?? false
    }

    private var launch: JobLaunchDTO {
        JobLaunchDTO(preset: preset, cwd: cwd.trimmingCharacters(in: .whitespaces), prompt: prompt, model: model, effort: effort, mode: mode, worktree: worktree ? true : nil)
    }

    var action: JobActionDTO {
        switch kind {
        case .launch: return .launch(launch)
        case .send: return .send(target: target, text: text)
        case .decide:
            let then: JobFollowUpDTO? = switch followUp {
            case .none: nil
            case .launch: .launch(launch)
            case .send: .send(target: target, text: text)
            }
            return .decide(title: title.trimmingCharacters(in: .whitespacesAndNewlines), body: body.isEmpty ? nil : body, then: then)
        }
    }

    var trigger: JobTriggerDTO {
        switch when {
        case .now, .manual: return .manual
        case .at: return .at(at.timeIntervalSince1970.rounded(.down))
        case .daily: return .cron(expr: Cron.expr(hour: hour, minute: minute, weekdays: false), tz: timeZone)
        case .weekdays: return .cron(expr: Cron.expr(hour: hour, minute: minute, weekdays: true), tz: timeZone)
        case .cron: return .cron(expr: cronExpr.trimmingCharacters(in: .whitespaces), tz: timeZone)
        case .after: return .after(job: afterJob, on: afterOn)
        case .session: return .session(uid: sessionUid, on: sessionOn)
        }
    }

    var policy: JobPolicyDTO {
        var p = keptPolicy
        p.retries = retries > 0 ? retries : nil
        p.timeoutSeconds = timeoutMinutes > 0 ? timeoutMinutes * 60 : nil
        p.maxRuns = maxRuns > 0 ? maxRuns : nil
        p.notify = notify ? true : nil
        p.autoRecover = autoRecover ? true : nil
        p.allowDangerous = allowDangerous ? true : nil
        p.until = untilDelivered ? "delivered" : (keptPolicy.until == "delivered" ? nil : keptPolicy.until)
        return p
    }

    /// The name it's given: what was typed, else the first line of what it says or asks.
    var shownName: String {
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return typed }
        let words = kind == .decide ? title : kind == .send ? text : prompt
        let first = words.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return first.isEmpty ? "Job" : String(first.prefix(60))
    }

    func request() -> JobDraftBody { JobDraftBody(name: shownName, action: action, trigger: trigger, policy: policy) }

    /// What's missing before the host would take it, in the form's words; nil when it's complete.
    var missing: String? {
        let needsLaunch = kind == .launch || (kind == .decide && followUp == .launch)
        let needsSend = kind == .send || (kind == .decide && followUp == .send)
        if kind == .decide && title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Say what to ask you." }
        if needsLaunch {
            if preset.isEmpty { return "Choose an agent." }
            let folder = cwd.trimmingCharacters(in: .whitespaces)
            if !(folder.hasPrefix("/") || folder.hasPrefix("~")) { return "Choose a folder (a full path)." }
            if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Say what to ask the agent." }
        }
        if needsSend {
            if target.isEmpty { return "Choose a session to message." }
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Say what to send." }
        }
        switch when {
        case .after where afterJob.isEmpty: return "Choose the job it follows."
        case .session where sessionUid.isEmpty: return "Choose the session it waits on."
        case .cron where cronExpr.split(separator: " ").count != 5: return "A schedule has five fields: minute, hour, day, month, weekday."
        default: return nil
        }
    }
}
