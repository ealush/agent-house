import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Glibc)
import Glibc
#endif
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

/// The app's transport for everything but WebSockets, which go through a minimal RFC 6455
/// client: the Linux toolchain's FoundationNetworking was built against a libcurl without
/// WebSocket support. Test-only and loopback plain `ws://` only; the app uses URLSession.
final class LinuxTestTransport: HTTPTransport, @unchecked Sendable {
    private let base = URLSessionTransport()

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) { try await base.data(for: request) }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { try await base.stream(for: request) }
    func webSocket(for request: URLRequest) -> any WebSocketConnection {
        #if os(Linux)
        return RawWebSocket(request: request)
        #else
        return base.webSocket(for: request)
        #endif
    }
}

#if os(Linux)
final class RawWebSocket: WebSocketConnection, @unchecked Sendable {
    private let request: URLRequest
    private let lock = NSLock()
    private var fd: Int32 = -1
    private var buffer = [UInt8]()
    private var opened = false
    private var openError: (any Error)?
    private var _closeCode: Int?
    private var _upgradeStatus: Int?
    private let queue = DispatchQueue(label: "raw-websocket")

    init(request: URLRequest) { self.request = request }

    var closeCode: Int? { lock.withLock { _closeCode } }
    var upgradeStatus: Int? { lock.withLock { _upgradeStatus } }

    struct Failure: Error, CustomStringConvertible { let description: String }

    func open() {}

    private func connectIfNeeded() throws {
        if opened { if let openError { throw openError }; return }
        opened = true
        do { try handshake() } catch {
            openError = error
            throw error
        }
    }

    private func handshake() throws {
        guard let url = request.url, let host = url.host, let port = url.port else { throw Failure(description: "bad URL") }
        fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else { throw Failure(description: "socket") }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        inet_pton(AF_INET, host == "localhost" ? "127.0.0.1" : host, &address.sin_addr)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Glibc.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard connected == 0 else { throw Failure(description: "connect failed") }
        let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
        var head = "GET \(url.path)\(url.query.map { "?\($0)" } ?? "") HTTP/1.1\r\nHost: \(host):\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n"
        for (name, value) in request.allHTTPHeaderFields ?? [:] { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        try write(Array(head.utf8))
        // Response head.
        while !buffer.containsSequence([13, 10, 13, 10]) { try fill() }
        let end = buffer.firstRange(of: [13, 10, 13, 10])!
        let text = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        buffer.removeSubrange(..<end.upperBound)
        let status = Int(text.split(separator: " ").dropFirst().first ?? "") ?? 0
        guard status == 101 else {
            lock.withLock { _upgradeStatus = status }
            throw Failure(description: "upgrade refused: \(status)")
        }
    }

    private func write(_ bytes: [UInt8]) throws {
        var sent = 0
        while sent < bytes.count {
            let n = bytes[sent...].withUnsafeBytes { Glibc.send(fd, $0.baseAddress, $0.count, Int32(MSG_NOSIGNAL)) }
            guard n > 0 else { throw Failure(description: "send failed") }
            sent += n
        }
    }

    private func fill() throws {
        var chunk = [UInt8](repeating: 0, count: 65536)
        let n = recv(fd, &chunk, chunk.count, 0)
        guard n > 0 else { throw Failure(description: "connection closed") }
        buffer.append(contentsOf: chunk[..<n])
    }

    private func take(_ count: Int) throws -> [UInt8] {
        while buffer.count < count { try fill() }
        let out = Array(buffer[..<count])
        buffer.removeFirst(count)
        return out
    }

    private func frame(opcode: UInt8, payload: [UInt8]) -> [UInt8] {
        var out: [UInt8] = [0x80 | opcode]
        if payload.count < 126 {
            out.append(0x80 | UInt8(payload.count))
        } else if payload.count < 65536 {
            out.append(0x80 | 126)
            out += [UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)]
        } else {
            out.append(0x80 | 127)
            out += (0..<8).reversed().map { UInt8((UInt64(payload.count) >> (8 * UInt64($0))) & 0xFF) }
        }
        let mask = (0..<4).map { _ in UInt8.random(in: 0...255) }
        out += mask
        out += payload.enumerated().map { $0.element ^ mask[$0.offset % 4] }
        return out
    }

    func send(_ message: WebSocketMessage) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async {
                do {
                    try self.connectIfNeeded()
                    switch message {
                    case .text(let text): try self.write(self.frame(opcode: 1, payload: Array(text.utf8)))
                    case .binary(let data): try self.write(self.frame(opcode: 2, payload: [UInt8](data)))
                    }
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    func receive() async throws -> WebSocketMessage {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                do {
                    try self.queue.sync { try self.connectIfNeeded() }
                    var message = [UInt8]()
                    var kind: UInt8 = 0
                    while true {
                        let head = try self.take(2)
                        let fin = head[0] & 0x80 != 0
                        let opcode = head[0] & 0x0F
                        var length = Int(head[1] & 0x7F)
                        if length == 126 { let b = try self.take(2); length = Int(b[0]) << 8 | Int(b[1]) }
                        if length == 127 { length = try self.take(8).reduce(0) { $0 << 8 | Int($1) } }
                        let payload = try self.take(length)
                        switch opcode {
                        case 8:
                            let code = payload.count >= 2 ? Int(payload[0]) << 8 | Int(payload[1]) : 1005
                            self.lock.withLock { self._closeCode = code }
                            throw Failure(description: "closed \(code)")
                        case 9:
                            try self.queue.sync { try self.write(self.frame(opcode: 10, payload: payload)) }
                            continue
                        case 10:
                            continue
                        default:
                            if opcode != 0 { kind = opcode }
                            message += payload
                            if fin {
                                continuation.resume(returning: kind == 1 ? .text(String(decoding: message, as: UTF8.self)) : .binary(Data(message)))
                                return
                            }
                        }
                    }
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func close(code: Int) {
        queue.async {
            if self.fd >= 0 {
                if self.opened && self.openError == nil {
                    try? self.write(self.frame(opcode: 8, payload: [UInt8(code >> 8 & 0xFF), UInt8(code & 0xFF)]))
                }
                shutdown(self.fd, Int32(SHUT_RDWR))
                Glibc.close(self.fd)
                self.fd = -1
            }
        }
    }
}

private extension Array where Element == UInt8 {
    func containsSequence(_ needle: [UInt8]) -> Bool { firstRange(of: needle) != nil }
}
#endif
