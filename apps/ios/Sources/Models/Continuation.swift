import Foundation
import Observation

/// Continue a conversation in another agent (`features.portable`, `ah` `server/portable`): pick
/// where it goes and how, see what the host says carries over (and what doesn't) before
/// anything starts, then follow the operation until the new session has its conversation.
/// The host owns the representation, the conversion and the launch; nothing here rebuilds
/// or stores a transcript.
@MainActor
@Observable
final class ContinueModel {
    enum Intent: String, CaseIterable, Sendable {
        /// Carry on from here (same folder unless asked otherwise).
        case `continue`
        /// A branch of it: a copy, in its own worktree unless asked otherwise.
        case fork
    }

    struct Source: Equatable, Sendable {
        /// What the host calls it: a session uid, or `harness:harnessId` for one on disk.
        let ref: String
        let title: String
        /// Its agent (a preset id), nil for a shell.
        let agent: String?
        /// The host it's on, nil for the account's own.
        let host: String?
    }

    let source: Source
    @ObservationIgnored private let api: APIClient
    /// The host takes model, effort and mode with a continuation.
    private(set) var launchOptions = false
    /// Agents on the source's host this conversation can go to.
    let destinations: [PresetDTO]

    var destination: String? {
        didSet {
            if destination != oldValue {
                resetLaunchChoices()
                choicesChanged()
            }
        }
    }
    var intent: Intent = .continue { didSet { if intent != oldValue { choicesChanged() } } }
    /// Nil follows the host's default for the intent (continue here, fork into a worktree).
    var worktree: Bool? { didSet { if worktree != oldValue { choicesChanged() } } }
    var model: String? { didSet { if model != oldValue { choicesChanged() } } }
    var effort: String? { didSet { if effort != oldValue { choicesChanged() } } }
    var mode = "default" { didSet { if mode != oldValue { choicesChanged() } } }

    private(set) var plan: ContinuePlan?
    private(set) var planError: String?
    private(set) var planning = false
    private(set) var operation: ContinueOperation?
    private(set) var startError: String?
    private(set) var starting = false
    /// One key for this attempt: a second tap, or a retry after a lost answer, is the same
    /// operation on the host, never a second session. Changing choices after a failure starts
    /// a fresh attempt with a new key.
    @ObservationIgnored private(set) var idempotencyKey = "native-\(UUID().uuidString.lowercased())"
    @ObservationIgnored private var asked: ContinueRequest?

    init(source: Source, api: APIClient, presets: [PresetDTO], preset: String? = nil) {
        self.source = source
        self.api = api
        destinations = presets.filter { $0.offered && !$0.isShell }
        destination = preset ?? destinations.first { $0.id != source.agent && $0.available }?.id
    }

    var chosen: PresetDTO? { destinations.first { $0.id == destination } }

    /// What would be asked of the host now.
    var request: ContinueRequest? {
        guard let destination else { return nil }
        var request = ContinueRequest(to: destination, intent: intent.rawValue, worktree: worktree, idempotencyKey: idempotencyKey)
        if launchOptions {
            request.model = model
            request.effort = effort
            request.mode = mode == "default" ? nil : mode
        }
        return request
    }

    /// Asks the host what it supports (once), then for the plan of what's chosen now. A
    /// newer answer replaces an older one; one for choices since changed is dropped.
    func refresh() async {
        if !launchOptionsKnown {
            launchOptionsKnown = true
            launchOptions = (try? await api.portableCapabilities())?.launchOptions ?? false
        }
        guard let request, operation == nil else { return }
        var previewed = request
        previewed.idempotencyKey = nil
        asked = previewed
        planning = true
        defer { if asked == previewed { planning = false } }
        do {
            let plan = try await api.continuePreview(source.ref, previewed)
            guard asked == previewed else { return }
            self.plan = plan
            planError = nil
        } catch {
            guard asked == previewed else { return }
            plan = nil
            planError = APIError.wrap(error).message
        }
    }

    @ObservationIgnored private var launchOptionsKnown = false

    /// Whether Continue can go: a plan for exactly what's chosen, not blocked, nothing under way.
    var canStart: Bool {
        guard let plan, let destination, plan.destination.harness == destination, plan.blocked == nil, !planning, !starting else { return false }
        return operation == nil || operation?.state == "failed"
    }

    /// Starts it, then follows it until the new session has its conversation (or it fails).
    /// Returns the new session's uid once there is one.
    @discardableResult
    func start(poll: Duration = .milliseconds(700), timeout: Duration = .seconds(120)) async -> String? {
        guard let request, canStart else { return nil }
        starting = true
        startError = nil
        defer { starting = false }
        do {
            let started: ContinueOperation
            if let failed = operation, failed.state == "failed" {
                started = try await api.retryContinue(failed.id)
            } else {
                let response = try await api.continueConversation(source.ref, request)
                if response.existed, response.operation.state == "failed" {
                    started = try await api.retryContinue(response.operation.id)
                } else {
                    started = response.operation
                }
            }
            operation = started
            return await follow(started.id, poll: poll, timeout: timeout)
        } catch {
            startError = APIError.wrap(error).message
            return nil
        }
    }

    /// Polls the operation: its steps show as they happen.
    private func follow(_ id: String, poll: Duration, timeout: Duration) async -> String? {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while !Task.isCancelled {
            if let operation, operation.isDone {
                if operation.state == "linked" { return operation.childUid }
                return nil
            }
            if clock.now >= deadline {
                // Still going on the host: the new session will show up when it's there.
                startError = "It’s taking longer than usual. The new session appears in your list once it has the conversation."
                return operation?.childUid
            }
            try? await Task.sleep(for: poll)
            if let next = try? await api.continueOperation(id) { operation = next }
        }
        return nil
    }

    func cancel() async {
        guard let operation, !operation.isDone else { return }
        if let next = try? await api.cancelContinue(operation.id) { self.operation = next }
    }

    private func resetLaunchChoices() {
        model = nil
        effort = nil
        mode = "default"
        plan = nil
    }

    private func choicesChanged() {
        guard operation == nil || operation?.state == "failed" || operation?.state == "cancelled" else { return }
        if operation != nil || startError != nil {
            operation = nil
            startError = nil
            idempotencyKey = "native-\(UUID().uuidString.lowercased())"
        }
    }
}

/// The words for what a continuation is: the guarantee of each strategy, plainly, without
/// claiming more than the host carries (never the other agent's memory or reasoning).
enum ContinueWords {
    static func headline(_ strategy: String, to: String) -> String {
        switch strategy {
        case "native-resume": return "Resume it in \(to)"
        case "native-fork": return "An exact copy in \(to)"
        case "ancestor-fork": return "Back to \(to)’s own conversation"
        case "context-handoff": return "A new \(to) conversation, started from a record"
        default: return "Continue in \(to)"
        }
    }

    static func guarantee(_ strategy: String, from: String, to: String) -> String {
        switch strategy {
        case "native-resume":
            return "The same conversation, picked up by \(to) itself. Nothing is converted."
        case "native-fork":
            return "\(to) gets a copy of the whole conversation under a new id and reads all of it again. The original stays as it is."
        case "ancestor-fork":
            return "\(to)’s own conversation as it was when it handed over, exactly, plus a record of what happened since in the other agents."
        case "context-handoff":
            return "\(to) starts fresh with a record of this conversation, rebuilt from its transcript. It doesn’t get \(from)’s memory or reasoning: only what the record says."
        default:
            return "The host carries what it can and says what it can’t."
        }
    }

    /// Native resume, native fork and coming back to an agent's own conversation keep the
    /// agent's own record; a hand-off is a reconstruction.
    static func isNative(_ strategy: String) -> Bool { strategy == "native-resume" || strategy == "native-fork" }

    /// The operation's steps, in order, and how far it got.
    static let steps: [(state: String, label: String)] = [
        ("preparing", "Reading the conversation"),
        ("launching", "Starting the new session"),
        ("delivering", "Handing it over"),
        ("linked", "It has the conversation"),
    ]

    static func stepIndex(_ state: String) -> Int? { steps.firstIndex { $0.state == state } }

    /// "Continued from Claude Code", "Forked from Codex", for a session's header and rows.
    static func origin(_ c: ContinuedLineage, agentName: (String) -> String) -> String {
        let from = agentName(c.fromHarness)
        switch c.kind {
        case "fork": return "Forked from \(from)"
        case "resume": return "Resumed from \(from)"
        case "migration": return "Moved from \(c.fromHost ?? from)"
        default: return "Continued from \(from)"
        }
    }
}
