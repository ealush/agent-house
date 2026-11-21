import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Settings → Hosts and Security's activity log, as words and times a person reads.

@MainActor @Test func activityReadsAsWordsAndTimesNotKeysAndTimestamps() {
    #expect(SecuritySettings.eventName("auth.signin") == "Signed in")
    #expect(SecuritySettings.eventName("review.stack") == "Review started")
    #expect(SecuritySettings.eventName("migration.start") == "Migration start", "an event without a name is spelled out, not shown as its key")
    let at = SecuritySettings.date("2026-11-16T00:01:03.858Z")
    #expect(abs((at?.timeIntervalSince1970 ?? 0) - 1_794_787_263.858) < 0.001)
    #expect(SecuritySettings.date("2026-11-16T00:01:03Z") != nil, "without milliseconds too")
    #expect(SecuritySettings.date("yesterday") == nil)
}
