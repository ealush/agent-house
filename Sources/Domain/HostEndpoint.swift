import Foundation

/// A Tailscale Serve origin. This validates an address; it does not prove host identity
/// (sign-in does: the host signs nothing, but only it can spend its own setup code).
struct HostEndpoint: Hashable, Codable, Sendable {
    let url: URL

    /// `allowLoopback` admits `http://127.0.0.1:<port>` / `http://localhost:<port>`: a host on
    /// this machine, for tests and the simulator in Debug builds. Release builds never pass it.
    init(_ input: String, allowLoopback: Bool = false) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if allowLoopback, let loopback = Self.loopback(trimmed) {
            url = loopback
            return
        }
        guard var components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              let hostname = components.host?.lowercased(),
              hostname.hasSuffix(".ts.net"),
              hostname != "ts.net",
              hostname.utf8.count <= 253,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port == nil || components.port == 443,
              components.path.isEmpty || components.path == "/",
              hostname.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ label in
                  !label.isEmpty && label.utf8.count <= 63
                      && label.first != "-" && label.last != "-"
                      && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
              }) else {
            throw ValidationError.invalidOrigin
        }
        components.scheme = "https"
        components.host = hostname
        components.port = nil
        components.path = ""
        guard let url = components.url else { throw ValidationError.invalidOrigin }
        self.url = url
    }

    private static func loopback(_ input: String) -> URL? {
        guard let components = URLComponents(string: input),
              components.scheme?.lowercased() == "http",
              let host = components.host?.lowercased(), host == "127.0.0.1" || host == "localhost",
              let port = components.port, (1...65535).contains(port),
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else { return nil }
        return URL(string: "http://\(host):\(port)")
    }

    var isLoopback: Bool { url.scheme == "http" }

    /// The machine's name as the address shows it ("box" for box.tail1234.ts.net).
    var shortName: String {
        let host = url.host ?? url.absoluteString
        return isLoopback ? host : String(host.split(separator: ".").first ?? Substring(host))
    }

    enum ValidationError: LocalizedError {
        case invalidOrigin

        var errorDescription: String? {
            "Enter your host’s HTTPS .ts.net address, without a path, credentials, or a custom port."
        }
    }
}
