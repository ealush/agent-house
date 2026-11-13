import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The network boundary: one-shot requests, long-lived byte streams (SSE) and WebSockets.
/// `URLSessionTransport` is the real one; tests substitute their own.
protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
    /// Sends `file` as the request's body, from disk rather than from memory.
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse)
    /// Opens a streaming response. The stream ends when the server closes it, fails on a
    /// network error, and cancels the request when the consumer stops iterating.
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>)
    func webSocket(for request: URLRequest) -> any WebSocketConnection
    /// Sends `body` (in memory or from a file), telling `progress` the share of it sent so
    /// far, from 0 to 1, as it goes.
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse)
}

/// What an upload sends: bytes held in memory, or a file read from disk as it goes.
enum UploadBody: Sendable {
    case data(Data)
    case file(URL)
}

extension HTTPTransport {
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) {
        var request = request
        request.httpBody = try Data(contentsOf: file)
        return try await data(for: request)
    }

    /// Where nothing reports bytes as they go: all of it at once, when it's done.
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) {
        let answer: (Data, HTTPURLResponse)
        switch body {
        case .data(let data):
            var request = request
            request.httpBody = data
            answer = try await self.data(for: request)
        case .file(let file):
            answer = try await upload(for: request, fromFile: file)
        }
        progress(1)
        return answer
    }
}

enum WebSocketMessage: Equatable, Sendable {
    case text(String)
    case binary(Data)
}

protocol WebSocketConnection: AnyObject, Sendable {
    func open()
    func send(_ message: WebSocketMessage) async throws
    func receive() async throws -> WebSocketMessage
    func close(code: Int)
    /// The server's close code once closed (4401 signed out, 4404 window gone, 1000 detached).
    var closeCode: Int? { get }
    /// The HTTP status of a refused upgrade (401, 403), when there was one.
    var upgradeStatus: Int? { get }
}

/// An ephemeral URLSession that never stores or sends cookies, never caches, and follows
/// no redirect: the native credential travels only as `Authorization: Bearer`, and the
/// server refuses any request that also carries a cookie.
final class URLSessionTransport: NSObject, HTTPTransport, @unchecked Sendable {
    private let session: URLSession
    private let configuration: URLSessionConfiguration
    #if !canImport(FoundationNetworking)
    /// Every stream's, each with a delegate of its own: over HTTP/2 (a tailnet's HTTPS) they
    /// share one connection, so a transcript's stream opens without a TCP and TLS handshake
    /// of its own first. Apart from the requests' session, with room for a stream per pane
    /// over HTTP/1.1, where each holds a connection: in the requests' six, a few open
    /// streams left the requests queued behind them.
    private let streams: URLSession
    #endif

    override init() {
        configuration = URLSessionTransport.makeConfiguration()
        let redirects = RedirectRefusal()
        session = URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
        #if !canImport(FoundationNetworking)
        streams = URLSession(configuration: URLSessionTransport.makeStreamConfiguration(), delegate: RedirectRefusal(), delegateQueue: nil)
        #endif
        super.init()
    }

    /// A stream stays open for hours; only the idle timeout between bytes applies. Pings come
    /// every 25 s: 40 lets one arrive late, and a host gone quiet (asleep, unreachable without
    /// a reset) reads as reconnecting sooner than at 60.
    static func makeStreamConfiguration() -> URLSessionConfiguration {
        let configuration = makeConfiguration()
        configuration.timeoutIntervalForRequest = 40
        configuration.timeoutIntervalForResource = 7 * 24 * 3600
        configuration.httpMaximumConnectionsPerHost = 16
        return configuration
    }

    static func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.httpAdditionalHeaders = ["Accept": "application/json"]
        return configuration
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.transport("no HTTP response") }
        return (data, http)
    }

    #if !canImport(FoundationNetworking)
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.upload(for: request, fromFile: file)
        guard let http = response as? HTTPURLResponse else { throw APIError.transport("no HTTP response") }
        return (data, http)
    }

    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) {
        var request = request
        request.httpBody = nil
        let meter = UploadMeter(report: progress)
        let (data, response): (Data, URLResponse)
        switch body {
        case .data(let bytes): (data, response) = try await session.upload(for: request, from: bytes, delegate: meter)
        case .file(let file): (data, response) = try await session.upload(for: request, fromFile: file, delegate: meter)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport("no HTTP response") }
        progress(1)
        return (data, http)
    }
    #endif

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        #if canImport(FoundationNetworking)
        let delegate = StreamDelegate(ownsSession: true)
        let session = URLSession(configuration: URLSessionTransport.makeStreamConfiguration(), delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request)
        #else
        let delegate = StreamDelegate(ownsSession: false)
        let task = streams.dataTask(with: request)
        task.delegate = delegate
        #endif
        let stream = AsyncThrowingStream<Data, any Error>(bufferingPolicy: .unbounded) { continuation in
            delegate.attach(continuation)
            continuation.onTermination = { _ in task.cancel() }
        }
        task.resume()
        // Cancelled while waiting for the head (the session left): the request goes with it.
        let response = try await withTaskCancellationHandler { try await delegate.response() } onCancel: { task.cancel() }
        return (response, stream)
    }

    func webSocket(for request: URLRequest) -> any WebSocketConnection {
        URLSessionWebSocket(task: session.webSocketTask(with: request))
    }
}

/// Never follow a redirect: it could carry the bearer to another origin.
private class RedirectRefusal: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

#if !canImport(FoundationNetworking)
/// One upload's own delegate: the bytes sent so far, as a share of the body (and, as the
/// session's does, no redirects).
private final class UploadMeter: RedirectRefusal, @unchecked Sendable {
    private let report: @Sendable (Double) -> Void

    init(report: @escaping @Sendable (Double) -> Void) { self.report = report }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }
}
#endif

/// Bridges a streaming data task to an AsyncThrowingStream, plus a one-shot for its response head.
private final class StreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    /// A session made for this one stream (where tasks can't have delegates of their own),
    /// let go when it ends; the shared one isn't.
    private let ownsSession: Bool
    private let lock = NSLock()
    private var continuation: AsyncThrowingStream<Data, any Error>.Continuation?
    private var head: Result<HTTPURLResponse, any Error>?
    private var waiters: [CheckedContinuation<HTTPURLResponse, any Error>] = []
    private var pending: [Data] = []

    init(ownsSession: Bool) {
        self.ownsSession = ownsSession
    }

    /// The shared session's own refusal doesn't hear of a task with a delegate of its own.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func attach(_ continuation: AsyncThrowingStream<Data, any Error>.Continuation) {
        lock.lock()
        self.continuation = continuation
        let early = pending
        pending = []
        lock.unlock()
        for chunk in early { continuation.yield(chunk) }
    }

    func response() async throws -> HTTPURLResponse {
        try await withCheckedThrowingContinuation { waiter in
            lock.lock()
            if let head {
                lock.unlock()
                waiter.resume(with: head)
            } else {
                waiters.append(waiter)
                lock.unlock()
            }
        }
    }

    private func resolve(_ result: Result<HTTPURLResponse, any Error>) {
        lock.lock()
        guard head == nil else { lock.unlock(); return }
        head = result
        let waiting = waiters
        waiters = []
        lock.unlock()
        for waiter in waiting { waiter.resume(with: result) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse {
            resolve(.success(http))
        } else {
            resolve(.failure(APIError.transport("no HTTP response")))
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        if let continuation {
            lock.unlock()
            continuation.yield(data)
        } else {
            pending.append(data)
            lock.unlock()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        if let error {
            resolve(.failure(error))
        } else {
            resolve(.failure(APIError.transport("the stream closed before responding")))
        }
        lock.lock()
        let continuation = self.continuation
        lock.unlock()
        if let error { continuation?.finish(throwing: error) } else { continuation?.finish() }
        if ownsSession { session.finishTasksAndInvalidate() }
    }
}

final class URLSessionWebSocket: WebSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
        task.maximumMessageSize = 16 * 1024 * 1024
    }

    func open() { task.resume() }

    func send(_ message: WebSocketMessage) async throws {
        switch message {
        case .text(let text): try await task.send(.string(text))
        case .binary(let data): try await task.send(.data(data))
        }
    }

    func receive() async throws -> WebSocketMessage {
        switch try await task.receive() {
        case .string(let text): return .text(text)
        case .data(let data): return .binary(data)
        @unknown default: throw APIError.transport("unknown WebSocket message")
        }
    }

    func close(code: Int) {
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
    }

    var closeCode: Int? {
        let code = task.closeCode.rawValue
        return code == 0 ? nil : code
    }

    var upgradeStatus: Int? {
        guard let status = (task.response as? HTTPURLResponse)?.statusCode, status != 101 else { return nil }
        return status
    }
}
