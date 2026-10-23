import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func normalizesTailscaleServeOrigin() throws {
    let endpoint = try HostEndpoint("  https://MACHINE.example.ts.net:443/  ")
    #expect(endpoint.url.absoluteString == "https://machine.example.ts.net")
}

@Test(arguments: [
    "http://machine.example.ts.net", "https://example.com", "https://ts.net",
    "https://machine.example.ts.net.evil.com", "https://user:secret@machine.example.ts.net",
    "https://machine.example.ts.net/api", "https://machine.example.ts.net?token=secret",
    "https://machine.example.ts.net#secret", "https://machine.example.ts.net:7681",
    "https://localhost", "https://-machine.example.ts.net", "https://machine..ts.net"
])
func rejectsUnsafeOrNoncanonicalHostAddress(_ address: String) {
    #expect(throws: HostEndpoint.ValidationError.self) { try HostEndpoint(address) }
}

