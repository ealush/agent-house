import Foundation

/// A Tailscale Serve origin. This validates an address; it does not prove host identity.
struct HostEndpoint: Equatable, Sendable {
    let url: URL

    init(_ input: String) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
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

    enum ValidationError: LocalizedError {
        case invalidOrigin

        var errorDescription: String? {
            "Enter your host’s HTTPS .ts.net address, without a path, credentials, or a custom port."
        }
    }
}

