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
}

extension HTTPTransport {
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) {
        var request = request
        request.httpBody = try Data(contentsOf: file)
        return try await data(for: request)
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

    override init() {
        configuration = URLSessionTransport.makeConfiguration()
        let redirects = RedirectRefusal()
        session = URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
        super.init()
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
    #endif

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        let streamConfiguration = URLSessionTransport.makeConfiguration()
        // A stream stays open for hours; only the idle timeout between bytes applies (pings come every 25 s).
        streamConfiguration.timeoutIntervalForRequest = 60
        streamConfiguration.timeoutIntervalForResource = 7 * 24 * 3600
        let delegate = StreamDelegate()
        let session = URLSession(configuration: streamConfiguration, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request)
        let stream = AsyncThrowingStream<Data, any Error>(bufferingPolicy: .unbounded) { continuation in
            delegate.attach(continuation)
            continuation.onTermination = { _ in
                task.cancel()
                session.invalidateAndCancel()
            }
        }
        task.resume()
        let response = try await delegate.response()
        return (response, stream)
    }

    func webSocket(for request: URLRequest) -> any WebSocketConnection {
        URLSessionWebSocket(task: session.webSocketTask(with: request))
    }
}

/// Never follow a redirect: it could carry the bearer to another origin.
private final class RedirectRefusal: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Bridges a streaming data task to an AsyncThrowingStream, plus a one-shot for its response head.
private final class StreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncThrowingStream<Data, any Error>.Continuation?
    private var head: Result<HTTPURLResponse, any Error>?
    private var waiters: [CheckedContinuation<HTTPURLResponse, any Error>] = []
    private var pending: [Data] = []

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
        session.finishTasksAndInvalidate()
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
