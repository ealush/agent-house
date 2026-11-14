#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
import Foundation

/// A session you sent a message to from this device, on the Lock Screen and in the Dynamic
/// Island while it works, waits on you and finishes: shared by the app (which starts it and
/// moves it while it runs) and its widgets. The host moves it with the app put away.
struct SessionAttributes: ActivityAttributes {
    typealias ContentState = SessionActivityState

    /// The session's title ("A session" on a private preview), its project (empty on a
    /// private preview) and agent, by name and by id (its logo; nil for an older activity).
    let title: String
    let project: String
    let agent: String
    var agentId: String? = nil
    /// The host it's on and its uid: Approve and Deny answer it there.
    let host: String
    let uid: String
    /// Opens it (`agenthub://`).
    let link: URL
}
#endif
