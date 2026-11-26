import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@MainActor
@Test func insertReuseAppendsToExistingDraftInsteadOfOverwriting() {
    let api = APIClient(
        origin: URL(string: "https://desk.example.ts.net")!,
        transport: URLSessionTransport(),
        credentials: AccountCredentials(token: "t", onRejected: {}),
        device: DeviceDescriptor(name: "iPhone", client: "c1")
    )
    let composer = ComposerModel(api: api, outbox: Outbox(), key: "s1", uid: "s1", isShell: false, draftDebounce: .seconds(3600))

    // Empty composer: inserts directly.
    composer.insertReuse("First prompt")
    #expect(composer.text == "First prompt")

    // Non-empty draft: appends cleanly with paragraph break rather than replacing existing words.
    composer.insertReuse("> Quoted excerpt")
    #expect(composer.text == "First prompt\n\n> Quoted excerpt")
}
