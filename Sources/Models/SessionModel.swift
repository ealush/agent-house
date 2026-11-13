import Foundation
import Observation

/// One open session in one window: its live row (or ended record), the GUI transcript, the
/// composer and queue, model/effort/mode, and every action on it. Server truth comes from the
/// hub store and the feed stream; this only holds what's transient to the view.
@MainActor
@Observable
final class SessionModel: Identifiable {
    /// "uid" / "host/uid" for a live session, or a history id for an ended one.
    nonisolated let key: String
    nonisolated var id: String { key }
    let api: APIClient
    let hub: HubStore
    /// This session's row, observed on its own (see `HubStore.Slot`).
    private let slot: HubStore.Slot
    let outbox: Outbox
    let composer: ComposerModel
    let queue: QueueModel

    private(set) var feed = FeedState.initial
    private(set) var prompts: [FeedPrompt] = []
    private(set) var notices: [Notice] = []
    /// The view this device chose for it.
    private(set) var chosenSurface: SceneSnapshot.Surface
    /// The view it shows: the chosen one, except that a session without a transcript (a shell,
    /// an agent ah has no reader for, or one whose reader isn't attached yet) shows its terminal.
    var surface: SceneSnapshot.Surface {
        get { chosenSurface == .gui && hasGUI ? .gui : .terminal }
        set { chosenSurface = newValue }
    }
    var panel: SceneSnapshot.Panel?
    /// A message a link asked for (its transcript seq): the transcript brings it into sight once
    /// it has loaded, then clears it.
    var pendingMessage: Int?
    /// A message to restore the files to before: Snapshots finds its turn and asks.
    var restoreRequest: String?
    /// A rename in progress (⌃⌥N): Return saves, Escape cancels.
    var renaming: String?
    private(set) var busy: Set<String> = []
    /// The agent as the screen shows it (`AgentHold`), kept from this session's row.
    private(set) var hold = AgentHold()
    /// Whether a model switched through ah is newer than what the agent last reported.
    private(set) var modelReport = ModelReport()
    @ObservationIgnored private var holdCheck: Task<Void, Never>?

    @ObservationIgnored private var feedStream: FeedStream?
    @ObservationIgnored private var feedTask: Task<Void, Never>?
    @ObservationIgnored private var blocksCache: (count: Int, epoch: Int, last: Int, blocks: [FeedBlock])?
    @ObservationIgnored private var endsCache: (count: Int, epoch: Int, last: Int, working: Bool, ends: [String: Double])?

    struct Notice: Equatable, Identifiable, Sendable {
        enum Tone: Sendable { case info, error }
        let id: Int
        let text: String
        let tone: Tone
    }
    @ObservationIgnored private var noticeID = 0

    /// The session's tmux uid / history ref on its own host (what the API takes).
    let ref: String

    init(key: String, hub: HubStore, outbox: Outbox, surface: SceneSnapshot.Surface) {
        self.key = key
        self.hub = hub
        self.outbox = outbox
        let parsed = SessionKey(key)
        api = hub.client(forKey: key)
        slot = hub.slot(key)
        ref = parsed?.uid ?? key.split(separator: "/").last.map(String.init) ?? key
        let row = hub.row(key)
        let isShell = row.map { $0.dto.agent == nil } ?? false
        composer = ComposerModel(api: api, outbox: outbox, key: key, uid: ref, isShell: isShell)
        queue = QueueModel(api: api, outbox: outbox, uid: ref, key: key)
        // Agents open in the GUI unless this device chose the terminal. Not pinned to the
        // terminal when the host hasn't attached a transcript reader yet: a session opened
        // right after it started would have stayed there.
        chosenSurface = surface
        watchRow()
    }

    /// Every change of this session's row goes through the hold.
    private func watchRow() {
        let row = withObservationTracking { slot.row } onChange: { [weak self] in
            Task { @MainActor in self?.watchRow() }
        }
        takeRow(row)
    }

    private func takeRow(_ row: SessionRow?) {
        guard let row else { return }
        var report = modelReport
        report.take(chosen: row.dto.launchModel, reported: row.dto.model)
        if report != modelReport { modelReport = report }
        var next = hold
        let until = next.take(agent: row.dto.agent, feed: row.dto.feed)
        if next != hold { hold = next }
        holdCheck?.cancel()
        // Still missing when the hold ends: the agent is gone, and the terminal shows.
        guard let until else { return }
        holdCheck = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, until.timeIntervalSinceNow) + 0.05))
            guard !Task.isCancelled, let self else { return }
            self.takeRow(self.slot.row)
        }
    }

    // MARK: What it is now

    var row: SessionRow? { slot.row }
    var history: HistoryRow? { hub.history.first { $0.id == key || $0.dto.ref == ref } }
    var isLive: Bool { row != nil }
    var title: String { row?.title ?? history?.dto.title ?? "Session" }
    var isShell: Bool { row != nil ? hold.agent == nil : history?.dto.harness == "shell" }
    /// Live: whether the host reads a transcript for it (held through a scan that missed the
    /// agent). Ended: any agent's conversation has one; a shell never did (it shows its last
    /// screen instead).
    var hasGUI: Bool { row != nil ? hold.feed != nil : !isShell }
    var working: Bool { row?.dto.status == .busy }
    var waiting: Bool { row?.dto.status == .waiting }
    /// On the agent's folder-trust prompt: what's sent waits in the queue until it's answered.
    var awaitingTrust: Bool { waiting && row?.dto.ask?.trust != nil }
    var turnLive: Bool { working || waiting }
    var launch: LaunchState { LaunchState(preset: slot.preset ?? heldPreset, session: row?.dto, preferChosen: modelReport.pickIsNewer) }
    /// The held agent's preset while a scan misses it, so its model and effort stay put.
    private var heldPreset: PresetDTO? {
        guard let agent = hold.agent, let row else { return nil }
        return hub.presets(host: row.isLocal ? nil : row.host).first { $0.id == agent }
    }
    var ask: AskDTO? { row?.dto.ask }
    var otherDevices: [String] { row?.dto.devices.filter { $0 != api.device.name } ?? [] }

    /// Blocks for the timeline, projected once per change.
    var blocks: [FeedBlock] {
        let last = feed.entries.last?.seq ?? -1
        if let cache = blocksCache, cache.count == feed.entries.count, cache.epoch == feed.epoch, cache.last == last { return cache.blocks }
        let projected = FeedProjection.project(feed.entries)
        blocksCache = (feed.entries.count, feed.epoch, last, projected)
        return projected
    }

    /// Where each finished turn ends, and how long it took: worked out once per change, not
    /// each time the transcript draws (it reads every entry and block).
    var turnEnds: [String: Double] {
        let last = feed.entries.last?.seq ?? -1, working = working
        if let cache = endsCache, cache.count == feed.entries.count, cache.epoch == feed.epoch, cache.last == last, cache.working == working { return cache.ends }
        let ends = FeedProjection.turnEnds(blocks, durations: FeedProjection.turnDurations(feed.entries), working: working)
        endsCache = (feed.entries.count, feed.epoch, last, working, ends)
        return ends
    }

    /// Optimistic bubbles still waiting for the transcript (queued ones live in the tray).
    var outgoing: [Outbox.Item] { outbox.items(for: key).filter { $0.state != .queued } }

    /// The message rail: every message you sent here, oldest first.
    var railItems: [RailItem] {
        FeedProjection.railItems(prompts: prompts, blocks: blocks, outgoing: outgoing.map { ($0.id, $0.text) })
    }

    /// The tool call a permission prompt is asking about, while it waits: the newest call
    /// without a result.
    var awaitingCall: String? {
        guard waiting else { return nil }
        for entry in feed.entries.reversed() {
            for part in entry.parts.reversed() {
                if case .toolCall(let call) = part, feed.results[call.id] == nil { return call.id }
            }
        }
        return nil
    }

    // MARK: Lifecycle

    func open() async {
        if hasGUI { startFeed() }
        queue.watch(queued: row?.dto.queued ?? 0)
        // None of these waits on another: asked together, the rail's prompts and this
        // device's focus no longer queue behind the draft, the history and the queue (five
        // round trips one after another). Closing the session cancels what's left.
        let api = api, key = key, ref = ref, live = isLive
        let composing = Task { await composer.open() }
        let queueing = Task { await queue.load() }
        let focusing = Task { if live { try? await api.focus(key: key) } }
        let asking = Task { (try? await api.feedPrompts(ref)) ?? [] }
        await withTaskCancellationHandler {
            prompts = await asking.value
            await composing.value
            await queueing.value
            await focusing.value
        } onCancel: {
            composing.cancel()
            queueing.cancel()
            focusing.cancel()
            asking.cancel()
        }
    }

    func close() {
        // What it showed last is what coming back paints, and where the stream carries on from.
        cacheFeed(feed, now: true)
        feedTask?.cancel()
        feedTask = nil
        if let stream = feedStream { Task { await stream.close() } }
        feedStream = nil
        queue.stop()
        Task { await composer.background() }
    }

    /// Back in the app (`reconnect`: asked to, so even a stream opened a moment ago).
    func foreground(reconnect: Bool = false) async {
        // Back in the app, everything catches up together rather than in turn.
        let stream = feedStream
        let resyncing = Task { if reconnect { await stream?.resync() } else { await stream?.wake() } }
        let composing = Task { await composer.foreground() }
        let queueing = Task { await queue.load() }
        await withTaskCancellationHandler {
            await resyncing.value
            await composing.value
            await queueing.value
        } onCancel: {
            resyncing.cancel()
            composing.cancel()
            queueing.cancel()
        }
    }

    /// Leaving the app: stop reading the transcript. ah counts an open stream as this device
    /// looking, so a turn that finished after you left would read as seen, and neither the
    /// host's push nor the app's own alert would say so. `foreground()` picks it up again.
    func background() async {
        cacheFeed(feed, now: true)
        await composer.background()
        if let feedStream { await feedStream.stop() }
    }

    /// This device's sealed cache for the account (set by the window that made this model):
    /// the newest transcript page, painted until the stream answers.
    struct FeedCache {
        struct Entry: Codable, Equatable, Sendable { let harness: String; let page: FeedPage }
        /// A read of it, made on the main thread and run off it (it's a page of transcript to
        /// open and decode); nil while there's no key to open it with.
        let load: @MainActor () -> (@Sendable () async -> Entry?)?
        let store: @MainActor (Entry) -> Void
    }
    @ObservationIgnored var feedCache: FeedCache?
    @ObservationIgnored private var feedCachedAt: Date = .distantPast

    private func startFeed() {
        guard feedStream == nil else { return }
        let stream = FeedStream(api: api, ref: ref, agent: row?.dto.agent ?? history?.dto.harness)
        feedStream = stream
        let read = feedCache?.load()
        // What this device kept, read and opened off the main thread: it paints only if nothing
        // from the host has, and the stream carries on from it (the host sends what came since,
        // not the newest page again).
        // Detached: the screen opening the session has the main thread meanwhile, and the
        // stream waits on this.
        let seeding = Task.detached {
            if let cached = await read?() { await stream.seed(harness: cached.harness, entries: cached.page.entries, hasOlder: cached.page.hasOlder) }
        }
        // Off the main actor: the newest page is asked for at once, not once the screen
        // opening it has been built.
        Task.detached { await stream.start(seeded: seeding) }
        feedTask = Task { [weak self] in
            let updates = await stream.updates()
            defer { seeding.cancel() }
            for await state in updates {
                guard let self else { return }
                self.feed = state
                self.cacheFeed(state)
                self.outbox.retireSent(key: self.key, userTurns: self.blocks.compactMap { block in
                    guard case .user = block else { return nil }
                    return (block.at / 1000, block.text)
                })
            }
        }
    }

    /// The newest page, sealed, every half minute while live and on leaving (`now`). A long
    /// session's page runs to megabytes: sealed every few seconds while an agent worked, its
    /// writes kept the database busy, and a write from the main thread waited its turn.
    private func cacheFeed(_ state: FeedState, now: Bool = false) {
        guard state.status == .live || now, let feedCache, now || Date().timeIntervalSince(feedCachedAt) > Self.cacheInterval, !state.entries.isEmpty else { return }
        feedCachedAt = Date()
        let newest = Array(state.entries.suffix(Self.cachedEntries))
        feedCache.store(FeedCache.Entry(harness: state.harness, page: FeedPage(entries: newest, hasOlder: state.hasOlder || state.entries.count > newest.count)))
    }

    static let cachedEntries = 120
    static let cacheInterval: TimeInterval = 30

    /// Seed from this device's sealed cache before the stream answers.
    func seed(_ page: FeedPage, harness: String) async {
        guard let stream = feedStream else { return }
        await stream.seed(harness: harness, entries: page.entries, hasOlder: page.hasOlder)
    }

    @discardableResult
    func loadOlder() async -> Bool {
        guard let stream = feedStream else { return false }
        return (try? await stream.loadOlder()) ?? false
    }

    /// Load older pages until the turn `seq` is in the transcript (a search hit's turn), up
    /// to `pages` pages. True when it's there to scroll to.
    func reveal(seq: Int, pages: Int = 20) async -> Bool {
        for _ in 0..<pages {
            if feed.entries.contains(where: { $0.seq == seq }) { return true }
            guard let oldest = feed.entries.first?.seq, oldest > seq, await loadOlder() else { break }
        }
        return feed.entries.contains { $0.seq == seq }
    }

    /// Something changed the queue or status: keep the tray's poll in step.
    func stateChanged() {
        queue.watch(queued: row?.dto.queued ?? 0)
        // Opened as it started, before the host attached a transcript reader: read it now.
        if hasGUI { startFeed() }
    }

    // MARK: Notices

    func notify(_ text: String, tone: Notice.Tone = .info) {
        noticeID += 1
        notices.append(Notice(id: noticeID, text: text, tone: tone))
    }

    func dismiss(_ id: Int) { notices.removeAll { $0.id == id } }

    private func run(_ what: String, _ body: () async throws -> Void) async {
        busy.insert(what)
        defer { busy.remove(what) }
        do {
            try await body()
        } catch {
            notify("Couldn’t \(what): \(APIError.wrap(error).message)", tone: .error)
        }
    }

    // MARK: Answering

    /// One-tap approve/deny: only for an answerable permission prompt; the server
    /// re-checks the prompt is still on screen before typing anything.
    func answer(approve: Bool) async {
        guard row?.dto.answerable == true else {
            notify("There’s no permission prompt to answer right now.")
            return
        }
        await run(approve ? "approve" : "deny") {
            try await api.answer(ref, approve: approve)
            hub.refresh(host: row?.isLocal == false ? row?.host : nil)
        }
    }

    /// A numbered picker row on screen (its key is what gets typed).
    func choose(_ option: AskDTO.ScreenOption) async {
        await run("answer") {
            let result = try await api.choose(ref, key: option.key)
            notify("Answered: \(result.label)")
        }
    }

    func answerQuestions(_ answers: [QuestionAnswer]) async {
        await run("answer") { try await api.answerQuestions(ref, answers) }
    }

    func answerDialog(question: String, answer: QuestionAnswer) async {
        await run("answer") { try await api.answerQuestion(ref, question: question, answer: answer) }
    }

    /// A widget's choice or card action: an ordinary message from you.
    func reply(_ text: String) async {
        await run("send") {
            let result = try await api.send(ref, text: text)
            if result.outcome == .queued { notify("Queued until the agent is free.") }
        }
    }

    // MARK: Turn control

    func interrupt() async {
        await run("interrupt") {
            try await api.interrupt(ref)
            notify("Interrupted")
        }
    }

    /// ⌃⌥S: deliver the oldest queued follow-up now, stopping the live turn.
    func sendNextNow() -> Bool { queue.steerFirst() }

    func clearQueue() async { await queue.cancelAll() }

    // MARK: Model, effort, mode

    /// Returns a confirmation to ask first, when the plan needs one.
    func plan(model: String? = nil, effort: String? = nil) -> LaunchState.Plan {
        launch.plan(LaunchState.Change(model: model, effort: effort), session: row?.dto)
    }

    func planMode(_ id: String) -> LaunchState.Plan { launch.planMode(id, session: row?.dto) }

    /// Carry out a plan (after any confirmation).
    func apply(_ plan: LaunchState.Plan) async -> String? {
        let launch = self.launch
        switch plan {
        case .nothing:
            return nil
        case .waitUntilIdle:
            notify("Wait until the session is idle to relaunch")
            return nil
        case .terminalPicker(let setting):
            await run("open settings") {
                let result = try await api.openSettings(ref, setting: setting.rawValue)
                notify(result.outcome == .queued ? "Settings will open in the terminal when the agent is free" : "Choose the setting in the terminal")
                if result.outcome == .delivered { surface = .terminal }
            }
            return nil
        case .switchLive(let change):
            await run("switch") {
                let result = try await api.switchLaunch(ref, model: change.model, effort: change.effort)
                let what = launch.describe(change)
                notify(result.outcome == .queued ? "Switching to \(what) when the agent is free" : "Switched to \(what)")
            }
            return nil
        case .relaunch(let change, _, _, _):
            do {
                let result = try await api.relaunch(ref, model: change.model, effort: change.effort, mode: change.mode)
                notify("Relaunched with \(launch.describe(change))")
                return result.uid
            } catch {
                // Just after a send the host still counts the agent as busy, before this
                // list has caught up: the same words as when the list already knows.
                let message = APIError.wrap(error).message
                notify(Self.refusedWhileBusy(message) ? "Wait until the session is idle to relaunch" : "Couldn’t relaunch: \(message)", tone: .error)
                return nil
            }
        case .switchMode(let id, _):
            do {
                if try await api.switchMode(ref, mode: id).switched {
                    notify("Switched to \(launch.describe(LaunchState.Change(mode: id)))")
                    return nil
                }
            } catch {
                notify("Couldn’t change permissions: \(APIError.wrap(error).message)", tone: .error)
                return nil
            }
            guard let row else { return nil }
            return await apply(launch.relaunchPlan(LaunchState.Change(mode: id), session: row.dto))
        }
    }

    nonisolated static func refusedWhileBusy(_ message: String) -> Bool {
        message.range(of: "relaunch when the session is idle", options: .caseInsensitive) != nil
    }

    // MARK: Session management

    /// The name being typed, or the one given (an alert hands its field's text over as it
    /// closes, after it's cleared `renaming`).
    func commitRename(_ given: String? = nil) async {
        guard let name = (given ?? renaming)?.trimmingCharacters(in: .whitespaces), !name.isEmpty, name != title else {
            renaming = nil
            return
        }
        renaming = nil
        await run("rename") {
            try await api.rename(ref, name)
            hub.refresh()
        }
    }

    func togglePin() async {
        let pinned = row?.dto.pinned ?? history?.dto.pinned ?? false
        await run(pinned ? "unpin" : "pin") {
            try await api.pin(ref, pinned: !pinned)
            hub.refresh()
        }
    }

    /// Stops the process; the record stays in History. Confirm before calling.
    func terminate() async -> Bool {
        var ok = false
        await run("terminate") {
            hub.hide(key, true)
            do {
                try await api.terminate(ref)
                ok = true
            } catch {
                hub.hide(key, false)
                throw error
            }
        }
        return ok
    }

    /// Resume an ended session in place; returns its live key.
    func resume() async -> String? {
        var key: String?
        await run("resume") {
            let result = try await api.resume(ref)
            let host = SessionKey(self.key)?.host
            key = host.map { "\($0)/\(result.uid)" } ?? result.uid
            hub.refresh(host: host)
        }
        return key
    }

    func forkInfo() async -> ForkInfo? {
        do { return try await api.forkInfo(ref) } catch {
            notify("Couldn’t prepare the fork: \(APIError.wrap(error).message)", tone: .error)
            return nil
        }
    }

    func fork(_ request: ForkRequest) async -> ForkResult? {
        var result: ForkResult?
        await run("fork") {
            result = try await api.fork(ref, request)
            if let prompt = result?.prompt { notify(prompt == .queued ? "Forked; your prompt is queued until it starts" : "Forked") }
        }
        return result
    }

    /// The newest agent reply as text (copy, Send to…), paging back if the turn is cut off.
    func lastReply() async -> String {
        let api = api
        let ref = ref
        return (try? await FeedProjection.readLastAssistant { before, limit in try await api.feedPage(ref, before: before, limit: limit) }) ?? FeedProjection.lastAssistantText(feed.entries)
    }

    /// Send to…: a subscription summary plus the latest reply, for another session.
    func handoff(summarize: Bool, subscription: String?) async -> String? {
        let api = api
        let ref = ref
        guard let read = try? await FeedProjection.readHandoff(page: { before, limit in try await api.feedPage(ref, before: before, limit: limit) }) else { return nil }
        var summary = ""
        if summarize && !read.transcript.isEmpty {
            do { summary = try await api.summarize(read.transcript, subscriptionId: subscription) } catch {
                notify("Couldn’t summarize: \(APIError.wrap(error).message)", tone: .error)
            }
        }
        return FeedProjection.handoffText(summary: summary, latest: read.latest)
    }

    /// Continue in…: this conversation as the first message for another agent (no model).
    func continuePrompt() async -> String? {
        guard let row else { return nil }
        let api = api
        let ref = ref
        guard let read = try? await FeedProjection.readHandoff(page: { before, limit in try await api.feedPage(ref, before: before, limit: limit) }) else { return nil }
        let agent = hub.preset(for: row)?.name ?? row.dto.agent ?? "another agent"
        return FeedProjection.continuePrompt(from: agent, cwd: row.dto.cwd, branch: row.dto.branch, transcript: read.transcript, latest: read.latest)
    }

    /// The terminal's scrollback as selectable text.
    /// `quietly`: an ended session may have no screen left to read, and that's no error.
    func scrollback(quietly: Bool = false) async -> String? {
        do { return try await api.capture(ref) } catch {
            if !quietly { notify("Couldn’t read the scrollback: \(APIError.wrap(error).message)", tone: .error) }
            return nil
        }
    }

    /// "ah attach <id>", to open this session from a terminal.
    var attachCommand: String { "ah attach \(ref)" }
}

/// The agent a live session runs, as its screen shows it: the host's report, held through
/// reports that miss it. The host finds the agent in the window's processes on every scan,
/// and a scan can miss it (the window's shell before the agent starts, a process between
/// two of its own); followed at once, the screen went from the conversation to the
/// terminal and back, several times as an agent started. Gone for a few seconds, it's gone:
/// the agent exited to its shell.
struct AgentHold: Equatable, Sendable {
    private(set) var agent: String?
    private(set) var feed: String?
    /// Until when a missing agent is still taken as there; nil while the host reports it.
    private(set) var until: Date?

    static let grace: TimeInterval = 5

    /// Take the host's report at `now`; returns when to look again while it's holding.
    mutating func take(agent reported: String?, feed reportedFeed: String?, now: Date = Date()) -> Date? {
        if let reported {
            agent = reported
            feed = reportedFeed
            until = nil
            return nil
        }
        guard agent != nil else { return nil }
        let end = until ?? now.addingTimeInterval(Self.grace)
        guard now < end else {
            agent = nil
            feed = nil
            until = nil
            return nil
        }
        until = end
        return end
    }
}
