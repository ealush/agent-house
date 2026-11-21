import Foundation

/// One GUI viewer's transcript (`apps/server/server/feed/stream.ts`, `web/gui/useFeed.ts`): a
/// snapshot, then appends, reconnecting with backoff. While it's open the host counts this
/// device as looking at the session (presence, unread).
actor FeedStream {
    private let api: APIClient
    let ref: String
    private var state = FeedState.initial
    private var loop: Task<Void, Never>?
    /// When the current connection was asked for.
    private var startedAt: ContinuousClock.Instant?
    private var observers: [UUID: AsyncStream<FeedState>.Continuation] = [:]
    private var loadingOlder = false

    /// The agent whose transcript this is (`claude`), as the host names it in a snapshot:
    /// what the stream can carry on from the newest page with, before any snapshot named it.
    private let agent: String?

    init(api: APIClient, ref: String, agent: String? = nil) {
        self.api = api
        self.ref = ref
        self.agent = agent
    }

    func updates() -> AsyncStream<FeedState> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<FeedState>.makeStream(bufferingPolicy: .bufferingNewest(1))
        continuation.yield(state)
        observers[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(id) } }
        return stream
    }

    private func removeObserver(_ id: UUID) { observers[id] = nil }

    var current: FeedState { state }

    /// Closed for good (its session left the screen): nothing starts it again.
    private var closed = false

    /// Opens the stream, and reads the newest page ahead of it at once. `seeded`: this
    /// device's copy going in (`seed`). The stream waits for whichever of the two is shown
    /// first and carries on from it: the host sends what came after it, not its newest two
    /// hundred entries (megabytes on a long session); scrolling back reads older pages in.
    func start(seeded: Task<Void, Never>? = nil) {
        guard loop == nil, !closed else { return }
        startedAt = .now
        readTail()
        seedRead = seeded == nil
        if let seeded { Task { await seeded.value; seedRead = true } }
        loop = Task {
            await waitForACopy()
            await run()
        }
    }

    private var seedRead = true
    private var tailRead = true

    /// Until something is shown to carry on from, or both reads came back without it (a
    /// first look at a fresh session; a host without the page), for two seconds at most.
    private func waitForACopy() async {
        let deadline = ContinuousClock.now + .seconds(2)
        while !Task.isCancelled, state.entries.isEmpty, !(seedRead && tailRead), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        tailTask?.cancel()
    }

    /// Stopped, and never to start again: a start still on its way finds it closed.
    func close() {
        closed = true
        stop()
    }

    func resync() {
        guard !closed else { return }
        loop?.cancel()
        // Not live until the new stream says so: what came while away can show ahead of it.
        apply(.disconnected)
        startedAt = .now
        loop = Task { await run() }
        readTail()
    }

    /// Back in the foreground: a stream opened a moment ago (the app launching into this
    /// session) is current already; another would send its snapshot, megabytes of it, again.
    func wake() {
        if loop != nil, let startedAt, ContinuousClock.now - startedAt < .seconds(3) { return }
        resync()
    }

    /// The newest page, small, alongside the stream: it's in long before a big snapshot.
    static let tailSize = 20
    /// A page reading back: two hundred of a long session's entries ran to 7 MB, seconds on a
    /// phone's connection before anything above showed. The next comes as you reach it.
    static let olderSize = 60
    private var tailTask: Task<Void, Never>?

    private func readTail() {
        tailTask?.cancel()
        tailRead = false
        tailTask = Task {
            defer { tailRead = true }
            guard let page = try? await api.feedPage(ref, before: nil, limit: Self.tailSize), !Task.isCancelled else { return }
            apply(.tail(page))
        }
    }

    /// What this device cached, painted until the stream catches up (never over live data).
    func seed(harness: String, entries: [FeedEntry], hasOlder: Bool) {
        apply(.cached(harness: harness, entries: entries, hasOlder: hasOlder))
    }

    private func apply(_ action: FeedAction) {
        let next = FeedReducer.reduce(state, action)
        guard next != state else { return }
        state = next
        for observer in observers.values { observer.yield(state) }
    }

    /// One more page above the oldest loaded entry. False when there's nothing older.
    @discardableResult
    func loadOlder() async throws -> Bool {
        // Not while the stream catches up: a page of two hundred would hold up the snapshot on
        // the same slow link, and the snapshot replaces what's shown anyway.
        guard state.hasOlder, state.status == .live, !loadingOlder, let oldest = state.entries.first?.seq else { return false }
        loadingOlder = true
        defer { loadingOlder = false }
        let page = try await api.feedPage(ref, before: oldest, limit: Self.olderSize)
        apply(.older(page))
        return !page.entries.isEmpty
    }

    /// Where the host can carry on from: the newest entry shown, of a transcript known by name.
    private var resumePoint: APIClient.FeedResume? {
        let harness = state.harness.isEmpty ? agent ?? "" : state.harness
        guard let last = state.entries.last, !harness.isEmpty, state.status != .unavailable else { return nil }
        return APIClient.FeedResume(after: last.seq, id: last.id, harness: harness)
    }

    /// ah sends a snapshot as one line of JSON; a long session's (screenshots, long outputs)
    /// runs to megabytes. Room for that, with a ceiling against a runaway stream.
    static let largestEvent = 64 << 20

    private func run() async {
        var backoff = Duration.milliseconds(500)
        var unreadable = 0
        while !Task.isCancelled {
            var opened: ContinuousClock.Instant?
            do {
                // From the newest entry held (this device's copy, or the last connection's).
                let bytes = try await api.feedStream(ref, resume: resumePoint)
                opened = ContinuousClock.now
                var parser = ServerSentEventParser(maximumLineBytes: Self.largestEvent, maximumEventBytes: Self.largestEvent)
                for try await chunk in bytes {
                    try Task.checkCancellation()
                    for event in try parser.append(chunk) {
                        if let message = try FeedMessage.decode(event) {
                            unreadable = 0
                            apply(.message(message))
                        }
                    }
                }
            } catch {
                let failure = APIError.wrap(error)
                if case .cancelled = failure { return }
                if case .unauthorized = failure {
                    apply(.disconnected)
                    return
                }
                // The same transcript failing to read every time won't read next time either:
                // say so (with the terminal at hand) instead of "Connecting…" forever.
                if error is ServerSentEventParser.ParseError || error is DecodingError {
                    unreadable += 1
                    if unreadable >= 3 {
                        apply(.message(.unavailable(reason: "unreadable")))
                        return
                    }
                }
            }
            // Only a stream that stayed up a while resets the wait: one that opens and then
            // fails (or sends its snapshot and closes) the same way mustn't come back every half
            // second. Each try re-renders the session, megabytes of snapshot and all.
            if let opened, ContinuousClock.now - opened >= .seconds(5) { backoff = .milliseconds(500) }
            apply(.disconnected)
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, .seconds(15))
        }
    }
}
