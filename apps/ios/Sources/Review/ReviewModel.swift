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
    /// Merge order, when this layer isn't next: a layer under it merges first.
    let order: MergeGate?
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
        order = layer.gates.first { !$0.ok && $0.key == "order" }
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
        // Last: the one thing that's another layer's to do, not this one's.
        if let order { out.append(order.detail ?? order.label) }
        return out
    }

    /// Reviewed at this head, nothing blocking, checks not failing or running.
    /// Ready to merge now: reviewed, nothing holding it, and next in merge order (the host
    /// refuses a merge out of order, so offering one only led to its refusal).
    var readyToMerge: Bool { (review == .current || review == .rebasedSamePatch) && blockers.isEmpty && order == nil }

    /// Every non-review gate passes and this layer is next in merge order: the user can explicitly
    /// approve and merge this exact head in one confirmed step.
    var onlyNeedsReview: Bool {
        (review == .notReviewed || review == .changedSinceReview)
            && order == nil
            && blockers.allSatisfy { $0.key == "reviewed" }
            && checks != .failing
            && checks != .pending
            && blockingFindings == 0
    }
}

/// What merging the stack bottom-up would do (`apps/server/web/review/stackMerge.ts`), worked out
/// before asking; the host re-checks everything at merge time. Natively the merge never marks
/// a layer reviewed for you: a layer you haven't reviewed holds the merge.
struct StackMergePlan: Equatable, Sendable {
    /// `stays`: above where you chose to stop (`upTo(_:)`); it stays in review.
    enum State: String, Sendable { case ready, review, held, waits, restack, stays }
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

    private init(rows: [Row], lands: [Layer], needsReview: [Layer], stop: Row?) {
        self.rows = rows
        self.lands = lands
        self.needsReview = needsReview
        self.stop = stop
    }

    /// The same merge, stopping once `pr` lands: what's above it stays in review. Merging
    /// only the next layer is this at the first layer that lands. A layer that can't land
    /// changes nothing.
    func upTo(_ pr: Int) -> StackMergePlan {
        guard let end = lands.firstIndex(where: { $0.pr == pr }), let at = rows.firstIndex(where: { $0.layer.pr == pr }) else { return self }
        let rows = rows.enumerated().map { i, r in i <= at ? r : Row(layer: r.layer, state: .stays, why: "Stays in review", step: r.step) }
        return StackMergePlan(rows: rows, lands: Array(lands[...end]), needsReview: [], stop: nil)
    }

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
        didSet {
            guard diff != oldValue else { return }
            diffFiles = diff.map { FileDiff.files(in: $0.text) } ?? []
            // Read from the layer's whole change only, and kept with the head it was read at.
            architecture = diff.flatMap { d in diffScope == .this ? ArchitectureOverview.read(diffFiles, head: d.to) : nil }
        }
    }
    /// How this layer changes the system, read from its own diff (`ArchitectureOverview`).
    private(set) var architecture: ArchitectureOverview?
    /// The layer moved on since the architecture was read: it describes an older head.
    var architectureIsStale: Bool {
        guard let read = architecture?.head, let now = layer?.headSha, !read.isEmpty, !now.isEmpty else { return false }
        return !(read.hasPrefix(now) || now.hasPrefix(read))
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

    /// The stack and its findings, both at once: one round trip after the other held the page.
    private func reload(_ id: String) async throws {
        async let fetched = review.stack(id)
        async let found = review.findings(id)
        stack = try await fetched
        findings = try await found
    }

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

    func clearError() { error = nil }

    func loadList() async {
        await load("stacks") {
            async let s = review.stacks()
            async let r = review.repos()
            stacks = try await s
            repos = (try? await r) ?? []
        }
    }

    func open(_ route: ReviewRoute, selecting: Bool = true) async {
        removed = false
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
            try await reload(id)
        }
        let threading = Task { await loadThread() }
        await withTaskCancellationHandler {
            if selecting {
                let shown = selectedPR
                selectedPR = route.pr ?? stack?.next ?? stack?.layers.first { $0.state == "open" }?.pr
                if let pr = selectedPR { await select(pr, again: pr == shown) }
            }
            await threading.value
        } onCancel: {
            threading.cancel()
        }
    }

    func select(_ pr: Int, again: Bool = false) async {
        // The layer on screen, opened again (the page came back into view): what it shows
        // stays up while it refreshes, instead of blanking to a spinner on a slow link.
        if again, selectedPR == pr, diff != nil, let id = stack?.id {
            let describing = Task {
                guard let fetched = try? await review.description(id, pr: pr) else { return }
                if stack?.id == id, selectedPR == pr { description = fetched }
            }
            await withTaskCancellationHandler {
                await loadDiff(diffScope)
                await describing.value
            } onCancel: {
                describing.cancel()
            }
            return
        }
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
            // Not the layer's findings: the thread's are only those the reviewer proposed in it
            // (yours and GitHub's were hidden until the next refresh). `findings` has them all.
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

    /// False when it didn't go (the field gives the question back).
    @discardableResult
    func ask(_ text: String, wholeStack: Bool = false) async -> Bool {
        guard let id = stack?.id, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let context = attachments
        var asked = false
        await load("ask") {
            let reply = try await review.ask(id, pr: wholeStack ? nil : selectedPR, text: text, subscriptionId: threadSubscription, context: context)
            thread.append(reply.asked)
            thread.append(reply.message)
            followups = reply.followups
            if !reply.findings.isEmpty { findings = try await review.findings(id) }
            attachments = []
            asked = true
        }
        return asked
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
            try await reload(id)
        }
    }

    func setFinding(_ finding: Finding, state: Finding.State? = nil, severity: Finding.Severity? = nil, owner: Int? = nil, note: String?? = nil) async {
        guard let id = stack?.id else { return }
        await load("finding") {
            _ = try await review.updateFinding(id, finding: finding.id, FindingPatch(state: state?.rawValue, severity: severity?.rawValue, ownerPr: owner, note: note))
            try await reload(id)
        }
    }

    func resolveThread(_ finding: Finding, reply: String) async {
        guard let id = stack?.id else { return }
        await load("resolve") {
            _ = try await review.resolveThread(id, finding: finding.id, body: reply)
            // The stack too: a layer's counts, gates and status are worked out from its findings.
            try await reload(id)
        }
    }

    func importThreads() async -> Int {
        guard let id = stack?.id, let pr = selectedPR else { return 0 }
        var added = 0
        await load("threads") {
            added = try await review.importThreads(id, pr: pr).added
            try await reload(id)
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

    /// The session linked to the open stack (fixes owner, falling back to the session that made it).
    var linkedSession: StackOwner? { stack?.owner ?? stack?.origin }

    /// Active open layer for actions triggered from Stack Overview (like Reviewer Chat → Send to Session).
    var activeOpenLayer: Layer? {
        if let layer, layer.state == "open" { return layer }
        guard let stack else { return nil }
        if let next = stack.next, let l = stack.layers.first(where: { $0.pr == next && $0.state == "open" }) { return l }
        return stack.layers.first(where: { $0.state == "open" })
    }

    // MARK: Request fixes

    /// The instruction for the agent: fixes for findings, or (`kind`) a restack or a merge
    /// the agent carries out itself (`method` for a merge).
    func draftDispatch(findings ids: [Int], extra: String = "", kind: String? = nil, method: String? = nil, pr overridePr: Int? = nil) async -> String? {
        guard let id = stack?.id, let pr = overridePr ?? selectedPR ?? activeOpenLayer?.pr else { return nil }
        var text: String?
        await load("dispatch") { text = try await review.dispatchText(id, pr: pr, findings: ids, extra: extra, kind: kind, method: method) }
        return text
    }

    /// Send the requested fixes to the implementing agent (or a new one in a fresh worktree).
    func dispatch(findings ids: [Int], text: String, to target: String?, newSessionPreset: String?, kind: String? = nil, pr overridePr: Int? = nil, postToGitHub: Bool = false, attachments: [String] = []) async -> DispatchResult? {
        guard let id = stack?.id, let pr = overridePr ?? selectedPR ?? activeOpenLayer?.pr else { return nil }
        var result: DispatchResult?
        await load("dispatch") {
            result = try await review.dispatch(id, pr: pr, findings: ids, text: text, targetUid: target, newSessionPreset: newSessionPreset, kind: kind, postToGitHub: postToGitHub, attachments: attachments)
            try await reload(id)
        }
        return result
    }

    /// Log a comment (optionally line-anchored) and send it directly back to the linked session in one call.
    func sendQuickComment(title: String, body: String? = nil, severity: String = "should", path: String? = nil, line: Int? = nil) async -> DispatchResult? {
        guard let id = stack?.id, let pr = selectedPR ?? activeOpenLayer?.pr else { return nil }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var result: DispatchResult?
        await load("quick-send") {
            result = try await review.dispatch(
                id,
                pr: pr,
                findings: [],
                text: nil,
                targetUid: nil,
                newSessionPreset: nil,
                comment: InlineComment(title: trimmed, body: body, severity: severity, path: path, lineStart: line, lineEnd: line)
            )
            try await reload(id)
        }
        return result
    }

    func deleteFinding(_ fid: Int) async {
        guard let id = stack?.id else { return }
        await load("finding:\(fid)") {
            try await review.deleteFinding(id, finding: fid)
            try await reload(id)
        }
    }

    // MARK: Decide

    /// Your decision, at the head you're looking at. Withdraw with `false`.
    func markReviewed(_ approved: Bool = true) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        // The head of the revision this page shows: a host that checks it refuses an approval
        // for any other (a push since, synced meanwhile).
        let head = layer?.current?.headSha ?? layer?.headSha
        await load("approve") { stack = try await review.approve(id, pr: pr, approved: approved, head: head) }
    }

    /// Accept a model re-review's verdict on the fixes, with your overrides.
    func acceptFixes(overrides: [Int: String] = [:]) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("accept") {
            stack = try await review.accept(id, pr: pr, overrides: overrides)
            findings = try await review.findings(id)
        }
    }

    /// Reject and close the current layer's PR on GitHub, optionally removing the review if done.
    @discardableResult
    func closeLayer(comment: String? = nil, removeIfDone: Bool = false) async -> Bool {
        guard let id = stack?.id, let pr = selectedPR else { return false }
        var closed = false
        await load("close") {
            let result = try await review.closeLayer(id, pr: pr, comment: comment, removeIfDone: removeIfDone)
            closed = true
            if result.removed {
                stack = nil
                removed = true
                stacks.removeAll { $0.id == id }
            } else if let updated = result.stack {
                stack = updated
                if let next = updated.next { await select(next) }
            }
        }
        return closed
    }

    /// Asks the host for the selected layer's briefing (`force`: write it again) and watches
    /// until it's written.
    func brief(force: Bool = false) async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        briefingBlocked = nil
        await load("summary") {
            let start = try await review.summarize(id, pr: pr, force: force)
            // Moved to another layer (or stack) meanwhile: this answer is the old one's.
            guard stack?.id == id, selectedPR == pr else { return }
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
                guard !Task.isCancelled else { return }
                // Still the watch under way (selecting another layer cancels it), so its
                // spinner is this one's to stop, whichever layer is showing.
                self.summarizing = false
                if self.selectedPR == pr {
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

    /// Merge this layer at the head you reviewed (or explicitly approve & merge that exact head).
    /// Re-fetches first: a head that moved since confirmation stops the merge here, and the host checks again itself.
    func merge(expectedHead: String, outOfOrder: Bool = false, approveHead: Bool = false) async -> MergeOutcome {
        guard let id = stack?.id, let pr = selectedPR else { return .refused("No layer selected") }
        do {
            let fresh = try await review.sync(id)
            stack = fresh
            guard let l = fresh.layers.first(where: { $0.pr == pr }) else { return .refused("#\(pr) is no longer in this stack") }
            guard l.headSha == expectedHead else { return .changed("#\(pr) changed since you looked (now \(l.headSha.prefix(7))). Review the new revision before merging.") }
            let result = try await review.merge(id, pr: pr, outOfOrder: outOfOrder, expectedHead: expectedHead, approveHead: approveHead)
            stack = try await review.stack(id)
            if let next = result.next { await select(next) }
            return .merged(next: result.next, restack: result.restack, waiting: result.waiting)
        } catch {
            return .refused(APIError.wrap(error).message)
        }
    }

    /// Bottom-up to the last layer that can land; never marks anything reviewed for you.
    /// Merge stack `id` bottom-up to `upTo`: the one open here, or one from the list. The
    /// list follows what landed.
    func mergeStack(_ id: String, method: String, upTo: Int?) async -> StackMergeResult? {
        var result: StackMergeResult?
        await load("merge") {
            result = try await review.mergeStack(id, method: method, markReviewed: false, upTo: upTo)
            if stack?.id == id { stack = try await review.stack(id) }
            if let listed = try? await review.stacks() { stacks = listed }
        }
        return result
    }

    /// One stack in full (its layers' gates), for merging it from the list without opening it:
    /// the stack open on the page stays as it is.
    func fetchStack(_ id: String) async -> ReviewStack? {
        var out: ReviewStack?
        await load("fetch:\(id)") { out = try await review.stack(id) }
        return out
    }

    func retarget() async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("retarget") { stack = try await review.retarget(id, pr: pr) }
    }

    func ready() async {
        guard let id = stack?.id, let pr = selectedPR else { return }
        await load("ready") { stack = try await review.ready(id, pr: pr) }
    }

    /// Every draft in the stack out of draft on GitHub; nil when the host refused the whole of it.
    func readyAll() async -> ReadyAllResult? {
        guard let id = stack?.id else { return nil }
        var out: ReadyAllResult?
        await load("ready") {
            let result = try await review.readyAll(id)
            stack = result.stack
            out = result
        }
        return out
    }

    /// The stack's open layers still in draft on GitHub.
    var drafts: [Layer] { stack?.layers.filter { $0.state == "open" && $0.draft } ?? [] }

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
        }
        // Through select, so the removed layer's diff and briefing go with it.
        if selectedPR == pr, let next = stack?.next ?? stack?.layers.first?.pr { await select(next) }
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

    func create(root: String, pick: ReviewAPI.Pick, title: String?, from: String? = nil) async -> String? {
        var created: String?
        await load("create") {
            let s = try await review.create(root: root, pick: pick, title: title, from: from)
            stack = s
            created = s.id
        }
        return created
    }

    /// Opens an existing review linked to `uid`, or creates and links one for its open PR/stack.
    func openOrStartForSession(_ uid: String) async -> (route: ReviewRoute, created: Bool)? {
        var out: (route: ReviewRoute, created: Bool)?
        await load("open-session:\(uid)") {
            let res = try await review.openForSession(uid)
            stack = res.stack
            out = (ReviewRoute(stack: res.stack.id, pr: res.pr), res.created)
        }
        return out
    }

    /// Remove a review directly by ID (e.g. from the Review list) without opening it first.
    @discardableResult
    func remove(stackId id: String) async -> Bool {
        var ok = false
        await load("remove:\(id)") {
            try await review.remove(id)
            stacks.removeAll { $0.id == id }
            if stack?.id == id {
                stack = nil
                removed = true
            }
            ok = true
        }
        return ok
    }

    /// Whether it went: a refused delete leaves the review, and says why (`error`).
    @discardableResult
    func remove() async -> Bool {
        guard let id = stack?.id else { return false }
        await load("remove") {
            try await review.remove(id)
            stack = nil
            stacks.removeAll { $0.id == id }
            removed = true
        }
        await loadList()
        return removed
    }

    /// The open stack was just deleted (its page goes back to the list).
    private(set) var removed = false
}
