import Foundation

/// One GUI viewer's transcript (`../ah/server/feed/stream.ts`, `web/gui/useFeed.ts`): a
/// snapshot, then appends, reconnecting with backoff. While it's open the host counts this
/// device as looking at the session (presence, unread).
actor FeedStream {
    private let api: APIClient
    let ref: String
    private var state = FeedState.initial
    private var loop: Task<Void, Never>?
    private var observers: [UUID: AsyncStream<FeedState>.Continuation] = [:]
    private var loadingOlder = false

    init(api: APIClient, ref: String) {
        self.api = api
        self.ref = ref
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

    func start() {
        guard loop == nil else { return }
        loop = Task { await run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    func resync() {
        loop?.cancel()
        loop = Task { await run() }
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
        guard state.hasOlder, !loadingOlder, let oldest = state.entries.first?.seq else { return false }
        loadingOlder = true
        defer { loadingOlder = false }
        let page = try await api.feedPage(ref, before: oldest)
        apply(.older(page))
        return !page.entries.isEmpty
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
                let bytes = try await api.feedStream(ref)
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
