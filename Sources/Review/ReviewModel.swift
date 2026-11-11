import Foundation
import Observation

/// What the evidence says about one layer, for a decision: what you reviewed against what's
/// there now, what checks actually ran, what's still open. Never green on absence: "no
/// checks reported" is not "checks passed", and an unreviewed head is not reviewed.
struct LayerConfidence: Equatable, Sendable {
    enum Review: Equatable, Sendable {
        case notReviewed
        /// Reviewed at exactly this head.
        case current
        /// Rebased since your review, same patch: your review still covers it.
        case rebasedSamePatch
        /// The code changed after your review.
        case changedSinceReview
    }

    let review: Review
    let checks: Checks.Outcome
    let failingChecks: [String]
    let openFindings: Int
    let blockingFindings: Int
    let followups: Int
    /// The server's gates that still say no (bar merge order, which merging handles).
    let blockers: [MergeGate]
    /// A model re-review's verdict on requested fixes, when one ran.
    let verdict: Verdict?
    let agentWorking: Bool

    init(layer: Layer) {
        if !layer.approved || layer.reviewed == nil {
            review = .notReviewed
        } else if !layer.samePatch {
            review = .changedSinceReview
        } else if layer.rebased {
            review = .rebasedSamePatch
        } else {
            review = .current
        }
        checks = layer.checks.outcome
        failingChecks = layer.checks.failing
        openFindings = layer.open
        blockingFindings = layer.blocking
        followups = layer.followups
        blockers = layer.gates.filter { !$0.ok && $0.key != "order" }
        verdict = layer.current?.verdict
        agentWorking = layer.status == .fixing
    }

    var reviewText: String {
        switch review {
        case .notReviewed: return "Not reviewed by you yet"
        case .current: return "You reviewed this exact revision"
        case .rebasedSamePatch: return "Rebased since your review; same changes"
        case .changedSinceReview: return "Changed since your review"
        }
    }

    var checksText: String {
        switch checks {
        case .none: return "No checks reported"
        case .pending: return "Checks still running"
        case .failing: return "Failing: \(failingChecks.joined(separator: ", "))"
        case .passing: return "Checks passed"
        }
    }

    /// What's missing before you could merge, in plain words, most important first.
    var missing: [String] {
        var out: [String] = []
        if review == .notReviewed { out.append("Your review of this revision") }
        if review == .changedSinceReview { out.append("A re-review of what changed") }
        if blockingFindings > 0 { out.append("\(blockingFindings) blocking finding\(blockingFindings == 1 ? "" : "s") resolved") }
        if checks == .failing { out.append("Passing checks") }
        if checks == .pending { out.append("Checks to finish") }
        for gate in blockers where !["reviewed", "findings", "checks"].contains(gate.key) {
            out.append(gate.detail ?? gate.label)
        }
        return out
    }

    /// Reviewed at this head, nothing blocking, checks not failing or running.
    var readyToMerge: Bool { (review == .current || review == .rebasedSamePatch) && blockers.isEmpty }
}

/// What merging the stack bottom-up would do (`../ah/web/review/stackMerge.ts`), worked out
/// before asking; the host re-checks everything at merge time. Natively the merge never marks
/// a layer reviewed for you: a layer you haven't reviewed holds the merge.
struct StackMergePlan: Equatable, Sendable {
    enum State: String, Sendable { case ready, review, held, waits, restack }
    struct Row: Equatable, Sendable, Identifiable {
        var id: Int { layer.pr }
        let layer: Layer
        let state: State
        let why: String?
        let step: Int
    }

    let rows: [Row]
    let lands: [Layer]
    let needsReview: [Layer]
    let stop: Row?

    var upTo: Layer? { lands.last }

    init(stack: ReviewStack, method: String) {
        let open = stack.layers.filter { $0.state == "open" }
        var rows: [Row] = []
        var heads = Set<String>()
        var stop: Row?
        var step = 0
        for (i, l) in open.enumerated() {
            let prev = i > 0 ? open[i - 1] : nil
            if prev == nil || l.ghStack == nil || l.ghStack != prev?.ghStack || (l.ghPos ?? 0) < (prev?.ghPos ?? 0) { step += 1 }
            if let stopRow = stop {
                rows.append(Row(layer: l, state: .waits, why: "Waits for \(stopRow.layer.name)", step: step))
                continue
            }
            let currentStep = step
            let sat = rows.contains { $0.step < currentStep && $0.layer.headRef == l.baseRef && !(l.ghStack != nil && $0.layer.ghStack == l.ghStack) }
            if method != "merge" && sat {
                let row = Row(layer: l, state: .restack, why: "Needs a restack once \(prev?.name ?? "the layer below") lands", step: step)
                stop = row
                rows.append(row)
                continue
            }
            if let bad = l.gates.first(where: { !$0.ok && $0.key != "order" && $0.key != "below" && $0.key != "reviewed" && !($0.key == "base" && heads.contains(l.baseRef)) }) {
                let row = Row(layer: l, state: .held, why: bad.detail ?? bad.label, step: step)
                stop = row
                rows.append(row)
                continue
            }
            let review = l.gates.contains { $0.key == "reviewed" && !$0.ok }
            if review {
                // Native: an unreviewed layer holds the merge here; you review it first.
                let row = Row(layer: l, state: .review, why: "Review \(l.name) first", step: step)
                stop = row
                rows.append(row)
                continue
            }
            rows.append(Row(layer: l, state: .ready, why: nil, step: step))
            heads.insert(l.headRef)
        }
        self.rows = rows
        lands = rows.filter { $0.state == .ready }.map(\.layer)
        needsReview = rows.filter { $0.state == .review }.map(\.layer)
        self.stop = stop
    }
}

/// The Review area: stacks in progress, one stack's cockpit, one layer's evidence, the
/// reviewer thread, findings, dispatches and the merge.
@MainActor
@Observable
final class ReviewModel {
    let review: ReviewAPI
    private(set) var stacks: [StackSummary] = []
    private(set) var repos: [ReviewRepo] = []
    private(set) var stack: ReviewStack?
    private(set) var findings: [Finding] = []
    private(set) var thread: [ThreadMessage] = []
    private(set) var threadSubscription: String?
    private(set) var followups: [Followup] = []
    private(set) var diff: DiffOut? {
        didSet { if diff != oldValue { diffFiles = diff.map { FileDiff.files(in: $0.text) } ?? [] } }
    }
    /// The diff split into files, once per diff: parsing it in the view redid the work on
    /// every keystroke in the reviewer's field.
    private(set) var diffFiles: [FileDiff] = []
    private(set) var diffScope: DiffScope = .this
    private(set) var description: PRDescription?
    private(set) var plan: PlanText?
    private(set) var loading: Set<String> = []
    private(set) var error: String?
    /// Why the diff shown isn't the one asked for (the host or GitHub refused it): said where
    /// the diff goes, with a way to ask again. `error` is anyone's, and the next thing to
    /// load cleared it.
    private(set) var diffError: String?
    var selectedPR: Int?
    /// The selected layer's briefing is being written: the host's job, watched until it's in.
    private(set) var summarizing = false
    /// Why there's no briefing and none is coming (no model to write it, nothing fetched yet).
    private(set) var briefingBlocked: String?
    private var briefingWatch: Task<Void, Never>?
    /// Lines, files or findings attached to the next question for the reviewer.
    var attachments: [AskContext] = []

    init(api: APIClient) {
        review = ReviewAPI(api: api)
    }

    var layer: Layer? { stack?.layers.first { $0.pr == selectedPR } }
    var confidence: LayerConfidence? { layer.map(LayerConfidence.init) }

    private func load(_ what: String, _ body: () async throws -> Void) async {
        loading.insert(what)
        defer { loading.remove(what) }
        do {
            try await body()
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    func loadList() async {
        await load("stacks") {
            async let s = review.stacks()
            async let r = review.repos()
            stacks = try await s
            repos = (try? await r) ?? []
        }
    }

    func open(_ route: ReviewRoute, selecting: Bool = true) async {
        guard let id = route.stack else {
            stack = nil
            await loadList()
            return
        }
        // Another stack: nothing of the last one stays up while this one loads (its title,
        // its layers and one layer's diff read as this stack's until the host answered).
        if let shown = stack, shown.id != id {
            stack = nil
            findings = []
            thread = []
            followups = []
            attachments = []
            plan = nil
            selectedPR = nil
            diff = nil
            description = nil
            diffError = nil
            loading.remove("diff")
            briefingWatch?.cancel()
            summarizing = false
            briefingBlocked = nil
        }
        // The stack and its findings together, then the layer and the reviewer's thread
        // together: four round trips one after another held the page on its spinner.
        await load("stack") {
            async let fetched = review.stack(id)
            async let found = review.findings(id)
            stack = try await fetched
            findings = try await found
        }
        let threading = Task { await loadThread() }
        await withTaskCancellationHandler {
            if selecting {
                selectedPR = route.pr ?? stack?.next ?? stack?.layers.first { $0.state == "open" }?.pr
                if let pr = selectedPR { await select(pr) }
            }
            await threading.value
        } onCancel: {
            threading.cancel()
        }
    }

    func select(_ pr: Int) async {
        selectedPR = pr
        diff = nil
        diffError = nil
        description = nil
        briefingWatch?.cancel()
        summarizing = false
        briefingBlocked = nil
        guard let id = stack?.id else { return }
        // The briefing writes itself for an open layer that has none, and the next layer's
        // gets started too, so it's ready when you move on.
        if let stack, Self.wantsBriefing(pr, in: stack) {
            Task { await brief() }
            if let next = Self.nextOpen(after: pr, in: stack) { Task { _ = try? await review.summarize(id, pr: next) } }
        }
        // A layer you reviewed before opens on what changed since.
        let l = stack?.layers.first { $0.pr == pr }
        diffScope = (l.map(LayerConfidence.init)?.review == .changedSinceReview) ? .since : .this
        // The diff and the PR's description together.
        let describing = Task {
            // A description that fails is no error of the page's: the layer reads without it.
            guard let fetched = try? await review.description(id, pr: pr) else { return }
            // Another layer was picked while this one's was on its way: it isn't that layer's.
            if stack?.id == id, selectedPR == pr { description = fetched }
        }
        await withTaskCancellationHandler {
            await loadDiff(diffScope)
            await describing.value
        } onCancel: {
            describing.cancel()
        }
    }

    func loadDiff(_ scope: DiffScope) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        diffScope = scope
        diffError = nil
        loading.insert("diff")
        defer { if selectedPR == pr, diffScope == scope { loading.remove("diff") } }
        do {
            let fetched = try await review.diff(id, pr: pr, scope: scope)
            // Another layer or scope was picked while this was on its way: a slow answer for
            // the last one must not land on this one's page.
            guard stack?.id == id, selectedPR == pr, diffScope == scope else { return }
            diff = fetched
        } catch {
            guard stack?.id == id, selectedPR == pr, diffScope == scope, !Task.isCancelled else { return }
            diffError = APIError.shown(error)
        }
    }

    func loadThread() async {
        guard let id = stack?.id else { return }
        await load("thread") {
            let t = try await review.thread(id)
            thread = t.messages
            threadSubscription = t.subscriptionId
            findings = t.findings.isEmpty ? findings : t.findings
        }
    }

    func loadPlan() async {
        guard let id = stack?.id else { return }
        await load("plan") { plan = try await review.plan(id) }
    }

    func refresh() async {
        guard let id = stack?.id else { return }
        await load("sync") {
            // In turn: a sync can change the findings it's followed by.
            stack = try await review.sync(id)
            findings = try await review.findings(id)
        }
    }

    // MARK: Challenge

    func attach(_ context: AskContext) {
        if !attachments.contains(where: { $0.key == context.key }) { attachments.append(context) }
    }

    func ask(_ text: String, wholeStack: Bool = false) async {
        guard let id = stack?.id, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let context = attachments
        await load("ask") {
            let reply = try await review.ask(id, pr: wholeStack ? nil : selectedPR, text: text, subscriptionId: threadSubscription, context: context)
            thread.append(reply.asked)
            thread.append(reply.message)
            followups = reply.followups
            if !reply.findings.isEmpty { findings = try await review.findings(id) }
            attachments = []
        }
    }

    func pickSubscription(_ id: String) async {
        guard let stackID = stack?.id else { return }
        await load("subscription") {
            try await review.pickSubscription(stackID, subscription: id)
            threadSubscription = id
        }
    }

    func clearThread() async {
        guard let id = stack?.id else { return }
        await load("thread") {
            try await review.clearThread(id)
            thread = []
        }
    }

    // MARK: Findings

    func addFinding(title: String, body: String, severity: Finding.Severity, path: String?, lines: ClosedRange<Int>?) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("finding") {
            _ = try await review.addFinding(id, NewFinding(ownerPr: pr, foundOnPr: pr, title: title, body: body, severity: severity.rawValue, path: path, lineStart: lines?.lowerBound, lineEnd: lines?.upperBound))
            // Both at once, not one round trip after the other.
            async let found = review.findings(id)
            async let fetched = review.stack(id)
            findings = try await found
            stack = try await fetched
        }
    }

    func setFinding(_ finding: Finding, state: Finding.State? = nil, severity: Finding.Severity? = nil, owner: Int? = nil, note: String?? = nil) async {
        guard let id = stack?.id else { return }
        await load("finding") {
            _ = try await review.updateFinding(id, finding: finding.id, FindingPatch(state: state?.rawValue, severity: severity?.rawValue, ownerPr: owner, note: note))
            // Both at once, not one round trip after the other.
            async let found = review.findings(id)
            async let fetched = review.stack(id)
            findings = try await found
            stack = try await fetched
        }
    }

    func resolveThread(_ finding: Finding, reply: String) async {
        guard let id = stack?.id else { return }
        await load("resolve") {
            _ = try await review.resolveThread(id, finding: finding.id, body: reply)
            findings = try await review.findings(id)
        }
    }

    func importThreads() async -> Int {
        guard let id = stack?.id, let pr = selectedPR else { return 0 }
        var added = 0
        await load("threads") {
            added = try await review.importThreads(id, pr: pr).added
            findings = try await review.findings(id)
        }
        return added
    }

    func findings(for pr: Int) -> [Finding] { findings.filter { $0.ownerPr == pr } }

    /// Files you've marked viewed, per layer at its head (a new revision starts over), as
    /// GitHub's Viewed boxes. Kept while the app runs.
    private var viewedFiles: [String: Set<String>] = [:]

    private var viewedKey: String? {
        guard let id = stack?.id, let layer else { return nil }
        return "\(id)#\(layer.pr)@\(layer.headSha)"
    }

    var viewed: Set<String> { viewedKey.flatMap { viewedFiles[$0] } ?? [] }

    func setViewed(_ path: String, _ on: Bool) {
        guard let key = viewedKey else { return }
        if on { viewedFiles[key, default: []].insert(path) } else { viewedFiles[key]?.remove(path) }
    }

    /// The layer `offset` places from the selected one, bottom to top (+1 is the one above).
    func neighbor(_ offset: Int) -> Layer? {
        guard let layers = stack?.layers, let pr = selectedPR else { return nil }
        return Self.neighbor(of: pr, offset, in: layers)
    }

    nonisolated static func neighbor(of pr: Int, _ offset: Int, in layers: [Layer]) -> Layer? {
        guard let at = layers.firstIndex(where: { $0.pr == pr }) else { return nil }
        let to = at + offset
        return layers.indices.contains(to) ? layers[to] : nil
    }

    // MARK: Request fixes

    /// The instruction for the agent: fixes for findings, or (`kind`) a restack or a merge
    /// the agent carries out itself (`method` for a merge).
    func draftDispatch(findings ids: [Int], extra: String = "", kind: String? = nil, method: String? = nil) async -> String? {
        guard let id = stack?.id, let pr = selectedPR else { return nil }
        var text: String?
        await load("dispatch") { text = try await review.dispatchText(id, pr: pr, findings: ids, extra: extra, kind: kind, method: method) }
        return text
    }

    /// Send the requested fixes to the implementing agent (or a new one in a fresh worktree).
    func dispatch(findings ids: [Int], text: String, to target: String?, newSessionPreset: String?, kind: String? = nil) async -> DispatchResult? {
        guard let id = stack?.id, let pr = selectedPR else { return nil }
        var result: DispatchResult?
        await load("dispatch") {
            result = try await review.dispatch(id, pr: pr, findings: ids, text: text, targetUid: target, newSessionPreset: newSessionPreset, kind: kind)
            async let fetched = review.stack(id)
            async let found = review.findings(id)
            stack = try await fetched
            findings = try await found
        }
        return result
    }

    // MARK: Decide

    /// Your decision, at the head you're looking at. Withdraw with `false`.
    func markReviewed(_ approved: Bool = true) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("approve") { stack = try await review.approve(id, pr: pr, approved: approved) }
    }

    /// Accept a model re-review's verdict on the fixes, with your overrides.
    func acceptFixes(overrides: [Int: String] = [:]) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("accept") {
            stack = try await review.accept(id, pr: pr, overrides: overrides)
            findings = try await review.findings(id)
        }
    }

    /// Asks the host for the selected layer's briefing (`force`: write it again) and watches
    /// until it's written.
    func brief(force: Bool = false) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        briefingBlocked = nil
        await load("summary") {
            let start = try await review.summarize(id, pr: pr, force: force)
            if start.started {
                watchBriefing(id: id, pr: pr)
            } else {
                briefingBlocked = Self.blockedReason(start.reason)
            }
        }
    }

    private func watchBriefing(id: String, pr: Int) {
        briefingWatch?.cancel()
        summarizing = true
        briefingWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                let busy = try? await self.review.busy(id, pr: pr)
                if busy?.summarizing == true { continue }
                if let fresh = try? await self.review.stack(id), self.stack?.id == id { self.stack = fresh }
                if self.selectedPR == pr {
                    self.summarizing = false
                    if (self.layer?.current?.summary ?? "").isEmpty, busy != nil {
                        self.briefingBlocked = "The model didn’t write a briefing this time. Try again, or pick another model in Settings."
                    }
                }
                return
            }
        }
    }

    nonisolated static func wantsBriefing(_ pr: Int, in stack: ReviewStack) -> Bool {
        guard let layer = stack.layers.first(where: { $0.pr == pr }), layer.state == "open", let current = layer.current else { return false }
        return current.summary?.isEmpty ?? true
    }

    nonisolated static func nextOpen(after pr: Int, in stack: ReviewStack) -> Int? {
        let open = stack.layers.filter { $0.state == "open" }.map(\.pr)
        guard let at = open.firstIndex(of: pr), at + 1 < open.count else { return nil }
        return open[at + 1]
    }

    /// The host's reason a briefing didn't start, said for a person; nil when there's one already.
    nonisolated static func blockedReason(_ reason: String?) -> String? {
        switch reason {
        case "no subscription": return "Briefings need a model. Add a subscription in Settings and they write themselves."
        case "not fetched yet": return "This layer hasn’t been fetched yet. Sync the stack, then it can be briefed."
        default: return nil
        }
    }

    // MARK: Merge

    enum MergeOutcome: Equatable, Sendable {
        case merged(next: Int?, restack: [Int], waiting: String?)
        /// The head moved after you looked: nothing merged; review the new revision.
        case changed(String)
        case refused(String)
    }

    /// Merge this layer at the head you reviewed. Re-fetches first: a head that moved since
    /// the confirmation was shown stops the merge here, and the host checks again itself.
    func merge(expectedHead: String) async -> MergeOutcome {
        guard let id = stack?.id, let pr = selectedPR else { return .refused("No layer selected") }
        do {
            let fresh = try await review.sync(id)
            stack = fresh
            guard let l = fresh.layers.first(where: { $0.pr == pr }) else { return .refused("#\(pr) is no longer in this stack") }
            guard l.headSha == expectedHead else { return .changed("#\(pr) changed since you looked (now \(l.headSha.prefix(7))). Review the new revision before merging.") }
            let result = try await review.merge(id, pr: pr)
            stack = try await review.stack(id)
            if let next = result.next { await select(next) }
            return .merged(next: result.next, restack: result.restack, waiting: result.waiting)
        } catch {
            return .refused(APIError.wrap(error).message)
        }
    }

    /// Bottom-up to the last layer that can land; never marks anything reviewed for you.
    func mergeStack(method: String, upTo: Int?) async -> StackMergeResult? {
        guard let id = stack?.id else { return nil }
        var result: StackMergeResult?
        await load("merge") {
            result = try await review.mergeStack(id, method: method, markReviewed: false, upTo: upTo)
            stack = try await review.stack(id)
        }
        return result
    }

    func retarget() async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("retarget") { stack = try await review.retarget(id, pr: pr) }
    }

    func ready() async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("ready") { stack = try await review.ready(id, pr: pr) }
    }

    // MARK: Maintain

    func update(_ patch: StackPatch) async {
        guard let id = stack?.id else { return }
        await load("update") { stack = try await review.update(id, patch) }
    }

    func setLayer(_ patch: LayerPatch) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("layer") { stack = try await review.setLayer(id, pr: pr, patch) }
    }

    func addDecision(_ text: String) async {
        guard let id = stack?.id else { return }
        await load("decision") { stack = try await review.addDecision(id, text: text, fromPr: selectedPR) }
    }

    func removeDecision(_ decision: Int) async {
        guard let id = stack?.id else { return }
        await load("decision") { stack = try await review.removeDecision(id, decision: decision) }
    }

    func addLayers(_ prs: [Int]) async {
        guard let id = stack?.id, !prs.isEmpty else { return }
        await load("layers") { stack = try await review.addLayers(id, prs: prs) }
    }

    func removeLayer(_ pr: Int) async {
        guard let id = stack?.id else { return }
        await load("layers") {
            stack = try await review.removeLayer(id, pr: pr)
            if selectedPR == pr { selectedPR = stack?.next ?? stack?.layers.first?.pr }
        }
    }

    /// Sessions that could own fixes, the one that made the stack first.
    func owners() async -> [OwnerSuggestion] {
        guard let id = stack?.id else { return [] }
        var out: [OwnerSuggestion] = []
        await load("owners") { out = try await review.owners(id) }
        return out
    }

    func link() async {
        guard let id = stack?.id else { return }
        await load("link") { stack = try await review.link(id) }
    }

    func create(root: String, pick: ReviewAPI.Pick, title: String?) async -> String? {
        var created: String?
        await load("create") {
            let s = try await review.create(root: root, pick: pick, title: title)
            stack = s
            created = s.id
        }
        return created
    }

    func remove() async {
        guard let id = stack?.id else { return }
        await load("remove") {
            try await review.remove(id)
            stack = nil
        }
    }
}
