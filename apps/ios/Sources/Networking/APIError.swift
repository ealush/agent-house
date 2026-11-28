import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What went wrong talking to a host, in the terms the UI acts on.
enum APIError: Error, Equatable, Sendable, LocalizedError {
    /// Signed out, expired or revoked: the account must sign in again.
    case unauthorized(String)
    /// The gate refused the request (wrong Tailscale user, CSRF, host-only action).
    case forbidden(String)
    case notFound(String)
    case conflict(String)
    /// 409 `agent_gone`: the session's agent exited, its shell is left; what was sent stays queued.
    /// The host's word for it: Resume brings the agent back (`resumeInPlace`).
    case agentGone(String)
    case tooManyAttempts(String)
    /// Any other answer the server gave, with its message.
    case server(status: Int, message: String)
    /// No answer at all: offline, Tailscale down, timeout.
    case transport(String)
    /// Something on this device failed before or after the request (Keychain, device key).
    case device(String)
    case decoding(String)
    case cancelled

    init(status: Int, body: Data) {
        let code = (try? JSONDecoder().decode([String: JSONValue].self, from: body))?["code"]?.string
        let message: String = {
            if let object = try? JSONDecoder().decode([String: JSONValue].self, from: body), let error = object["error"]?.string {
                return error
            }
            let text = String(decoding: body, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? HTTPURLResponse.localizedString(forStatusCode: status) : String(text.prefix(500))
        }()
        switch status {
        case 401: self = .unauthorized(message)
        case 403: self = .forbidden(message)
        case 404: self = .notFound(message)
        case 409: self = code == "agent_gone" ? .agentGone(message) : .conflict(message)
        case 429: self = .tooManyAttempts(message)
        default: self = .server(status: status, message: message)
        }
    }

    static func wrap(_ error: any Error) -> APIError {
        if let api = error as? APIError { return api }
        if error is CancellationError { return .cancelled }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return .cancelled }
        if error is DecodingError { return .decoding(String(describing: error)) }
        if ns.domain == NSURLErrorDomain || ns.domain == NSPOSIXErrorDomain || ns.domain == "kCFErrorDomainCFNetwork" {
            return .transport(ns.localizedDescription)
        }
        return .device((error as? LocalizedError)?.errorDescription ?? ns.localizedDescription)
    }

    var errorDescription: String? { message }

    /// What a page shows for a failed request: its message, or nothing for a cancellation (a
    /// page that went away, or a load handed to another task, has nothing to report).
    static func shown(_ error: Error) -> String? {
        let wrapped = wrap(error)
        if case .cancelled = wrapped { return nil }
        return wrapped.message
    }

    /// A sentence for the user: what the server said, or what reaching it failed on.
    var message: String {
        switch self {
        case .unauthorized(let m): return m.isEmpty ? "Signed out. Sign in again to continue." : m
        case .forbidden(let m): return m == "forbidden" ? "The host refused this request." : m
        case .notFound(let m), .conflict(let m), .agentGone(let m), .tooManyAttempts(let m): return m
        // The host's own words for an upload it won't take ("body too large") aren't a sentence.
        case .server(413, _): return "It’s larger than your host accepts."
        case .server(_, let m): return m
        case .transport(let m): return "Can’t reach your host. \(m)"
        case .device(let m): return m
        case .decoding: return "The host answered in a form this app doesn’t understand. Update the app or the host."
        case .cancelled: return "Cancelled."
        }
    }

    /// Worth retrying later on its own (network), as opposed to a refusal.
    var isTransient: Bool {
        switch self {
        case .transport: return true
        case .server(let status, _): return status >= 500
        default: return false
        }
    }
}
