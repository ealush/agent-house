import Foundation

/// How fresh a host's state is, for the UI to say so honestly.
enum ConnectionPhase: Equatable, Sendable {
    case connecting
    /// The event stream is open: state is current.
    case live
    /// The stream is down but polling works: state is at most a few seconds old.
    case polling(String)
    /// Nothing gets through: the last state shown may be stale.
    case offline(String)
    /// The host no longer accepts this device's sign-in (expired, revoked, signed out).
    case signedOut

    var isUsable: Bool {
        switch self {
        case .live, .polling: return true
        default: return false
        }
    }
}

struct StateUpdate: Sendable, Equatable {
    let state: HubStateDTO?
    let phase: ConnectionPhase
}

/// One host's live state (`apps/server/web/api.ts subscribe`): the full state over SSE, then
/// patches; a fresh parser and baseline per connection; reconnect with backoff; polling
/// while the stream is down (never concurrently, so an old poll can't overwrite a newer
/// stream snapshot); and a forced resync when the app comes back to the foreground.
actor StateStream {
    private let api: APIClient
    private let pollInterval: Duration
    private let maxBackoff: Duration
    /// The newest validated state from any connection or poll: what the UI shows.
    private var latest: HubStateDTO?
    private var phase: ConnectionPhase = .connecting
    private var loop: Task<Void, Never>?
    /// When the current connection was asked for.
    private var startedAt: ContinuousClock.Instant?
    private var observers: [UUID: AsyncStream<StateUpdate>.Continuation] = [:]

    init(api: APIClient, pollInterval: Duration = .seconds(3), maxBackoff: Duration = .seconds(30)) {
        self.api = api
        self.pollInterval = pollInterval
        self.maxBackoff = maxBackoff
    }

    /// Every update from now on, starting with the current one.
    func updates() -> AsyncStream<StateUpdate> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<StateUpdate>.makeStream(bufferingPolicy: .bufferingNewest(1))
        continuation.yield(StateUpdate(state: latest, phase: phase))
        observers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeObserver(id) }
        }
        return stream
    }

    private func removeObserver(_ id: UUID) {
        observers[id] = nil
    }

    var current: StateUpdate { StateUpdate(state: latest, phase: phase) }

    func start() {
        guard loop == nil else { return }
        startedAt = .now
        loop = Task { await run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    /// Foreground, network change, or a user's pull to refresh: reconnect now.
    func resync() {
        loop?.cancel()
        startedAt = .now
        loop = Task { await run() }
    }

    /// After an action of ours: an open stream has it already (the host sends its state the
    /// moment an action lands), and a new one only drew the whole state again, often from
    /// before the action. Down, it's tried at once rather than at the end of its wait.
    func refresh() {
        if case .live = phase { return }
        resync()
    }

    /// Back in the foreground: a stream asked for a moment ago (the app launching, which
    /// comes to the foreground too) is current already; dropping it for another sent the
    /// whole state twice. One older than that may have died while away: reconnect.
    func wake() {
        if loop != nil, let startedAt, ContinuousClock.now - startedAt < .seconds(3) { return }
        resync()
    }

    private func publish(_ next: ConnectionPhase) {
        phase = next
        let update = StateUpdate(state: latest, phase: next)
        for observer in observers.values { observer.yield(update) }
    }

    private func run() async {
        var backoff = Duration.seconds(1)
        while !Task.isCancelled {
            let failure: APIError
            let opened = ContinuousClock.now
            do {
                try await streamOnce()
                // The server closed the stream (restart, revocation): reconnect at once. Unless
                // it closed as soon as it opened (a proxy ending every response): that went round
                // as fast as the network, the whole state drawn again each time.
                if ContinuousClock.now - opened < .seconds(5) {
                    try? await Task.sleep(for: backoff)
                    backoff = min(backoff * 2, maxBackoff)
                } else {
                    backoff = .seconds(1)
                }
                continue
            } catch {
                failure = APIError.wrap(error)
            }
            // Up a while before it dropped (a phone's connection mostly ends in an error, not a
            // close): a fresh blip, so a short wait. Only a clean close reset it, so after a few
            // drops every later one meant half a minute of polling the whole state.
            if ContinuousClock.now - opened >= .seconds(5) { backoff = .seconds(1) }
            switch failure {
            case .cancelled:
                return
            case .unauthorized:
                latest = nil
                publish(.signedOut)
                return
            default:
                break
            }
            // Down: poll while waiting to reconnect, so the UI never sits on stale state.
            let deadline = ContinuousClock.now + backoff
            var polled = false
            while !Task.isCancelled && ContinuousClock.now < deadline {
                if await pollOnce(after: failure) { polled = true }
                if case .signedOut = phase { return }
                try? await Task.sleep(for: min(pollInterval, max(.zero, deadline - ContinuousClock.now)))
            }
            if !polled && !Task.isCancelled { _ = await pollOnce(after: failure) }
            backoff = min(backoff * 2, maxBackoff)
        }
    }

    /// One connection: its own parser and baseline. What's shown changes only when a
    /// complete, valid state or patch arrives on it.
    private func streamOnce() async throws {
        var reducer = HubStateReducer()
        // Patches name only the sessions that changed (an older host sends them all): one
        // working session no longer sends every row again each tick.
        let bytes = try await api.eventStream("/api/events", query: [URLQueryItem(name: "delta", value: "1")])
        // A host with many sessions and a long History sends a large first state.
        var parser = ServerSentEventParser(maximumLineBytes: 32 << 20, maximumEventBytes: 32 << 20)
        for try await chunk in bytes {
            try Task.checkCancellation()
            for event in try parser.append(chunk) {
                if try reducer.apply(event) {
                    latest = reducer.state
                    publish(.live)
                }
            }
        }
        parser.finish()
    }

    /// One REST snapshot while the stream is down. True when it got through.
    private func pollOnce(after failure: APIError) async -> Bool {
        do {
            var reducer = HubStateReducer()
            try reducer.adopt(try await api.state())
            latest = reducer.state
            publish(.polling(failure.message))
            return true
        } catch {
            let error = APIError.wrap(error)
            if case .unauthorized = error {
                latest = nil
                publish(.signedOut)
            } else if case .cancelled = error {
                // Leaving: nothing to say.
            } else {
                publish(.offline(error.message))
            }
            return false
        }
    }
}
