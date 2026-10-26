import Foundation

/// What a terminal viewer sees happen to its connection.
enum TerminalEvent: Equatable, Sendable {
    case connected(windowId: String)
    /// Raw PTY bytes for the emulator.
    case output(Data)
    /// Lost: keys typed now are not sent. `retrying` while it reconnects on its own.
    case disconnected(reason: String, retrying: Bool)
    case ended(TerminalEnd)
}

enum TerminalEnd: Equatable, Sendable {
    /// The host revoked or expired this device's sign-in (close 4401).
    case signedOut
    /// The session isn't running any more (no window to attach to).
    case sessionGone
}

/// One viewer's terminal for a session (`../ah/server/terminal.ts`): a WebSocket to a
/// throwaway tmux client grouped with the session, so every device views independently.
/// The session's stable uid is resolved to its current tmux window on each attach, so a
/// resumed session reattaches to its new window. Input is never queued or replayed: a
/// keystroke either goes out on a live socket or is reported as not sent.
actor TerminalConnection {
    typealias WindowResolver = @Sendable () async -> String?

    private let api: APIClient
    private let resolveWindow: WindowResolver
    private var columns: Int
    private var rows: Int
    private var socket: (any WebSocketConnection)?
    private var loop: Task<Void, Never>?
    private var observers: [UUID: AsyncStream<TerminalEvent>.Continuation] = [:]
    private(set) var isConnected = false

    init(api: APIClient, columns: Int = 80, rows: Int = 24, resolveWindow: @escaping WindowResolver) {
        self.api = api
        self.resolveWindow = resolveWindow
        self.columns = max(2, min(1000, columns))
        self.rows = max(2, min(500, rows))
    }

    func events() -> AsyncStream<TerminalEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<TerminalEvent>.makeStream(bufferingPolicy: .unbounded)
        observers[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(id) } }
        return stream
    }

    private func removeObserver(_ id: UUID) { observers[id] = nil }

    private func emit(_ event: TerminalEvent) {
        for observer in observers.values { observer.yield(event) }
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { await run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        socket?.close(code: 1000)
        socket = nil
        isConnected = false
    }

    /// Reconnect now (foreground, network back).
    func reconnect() {
        socket?.close(code: 1000)
        loop?.cancel()
        loop = Task { await run() }
    }

    /// Sends keys/paste. False when there's no live connection: the caller says so, never pretends.
    @discardableResult
    func send(_ input: TerminalInput) async -> Bool {
        guard isConnected, let socket else { return false }
        do {
            let data = try JSONEncoder().encode(input)
            try await socket.send(.text(String(decoding: data, as: UTF8.self)))
            return true
        } catch {
            return false
        }
    }

    /// The viewer's size: sent now if connected, and used for the next attach. The last
    /// writer sets the tmux window's size for every viewer.
    func resize(columns: Int, rows: Int) async {
        let c = max(2, min(1000, columns))
        let r = max(2, min(500, rows))
        guard c != self.columns || r != self.rows else { return }
        self.columns = c
        self.rows = r
        await send(.resize(columns: c, rows: r))
    }

    private func run() async {
        var backoff = Duration.milliseconds(500)
        while !Task.isCancelled {
            guard let windowId = await resolveWindow() else {
                emit(.ended(.sessionGone))
                return
            }
            let socket = await api.terminalSocket(windowId: windowId, columns: columns, rows: rows)
            self.socket = socket
            socket.open()
            var announced = false
            var closeReason = "Connection lost"
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    if !announced {
                        announced = true
                        isConnected = true
                        backoff = .milliseconds(500)
                        emit(.connected(windowId: windowId))
                    }
                    switch message {
                    case .binary(let data): emit(.output(data))
                    case .text(let text): emit(.output(Data(text.utf8)))
                    }
                }
            } catch {
                closeReason = APIError.wrap(error).message
            }
            isConnected = false
            self.socket = nil
            if Task.isCancelled { return }
            if !announced, let status = socket.upgradeStatus, status == 401 || status == 403 {
                emit(.ended(.signedOut))
                return
            }
            switch socket.closeCode {
            case 4401:
                emit(.ended(.signedOut))
                return
            case 4404:
                // That window is gone; the session may live on in another (resumed).
                break
            default:
                break
            }
            emit(.disconnected(reason: closeReason, retrying: true))
            try? await Task.sleep(for: backoff)
            backoff = min(backoff * 2, .seconds(10))
        }
    }
}
