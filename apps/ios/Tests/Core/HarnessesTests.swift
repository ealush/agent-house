import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Settings → Agents reads the host's agents (`GET /api/harnesses`); pi's carries `bridge`
// (experimental, as the web's Settings shows it). Older hosts, and every other agent, send none.
@Test func piCarriesItsBridgeSettingAndOtherAgentsAndOlderHostsNone() throws {
    let json = Data("""
    {"agents":[
      {"id":"claude","name":"Claude Code","command":"claude","custom":false,"installed":true,"hidden":false,"version":"2.1.0","changes":[]},
      {"id":"pi","name":"pi","command":"pi","custom":false,"installed":true,"hidden":false,"version":"1.2.0","changes":[],"bridge":true}
    ],"suggestions":[]}
    """.utf8)
    let harnesses = try JSONDecoder().decode(Harnesses.self, from: json)
    #expect(harnesses.agents.first { $0.id == "pi" }?.bridge == true)
    #expect(harnesses.agents.first { $0.id == "claude" }?.bridge == nil)
}
