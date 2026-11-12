#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
import Foundation

/// A message on its way with its attachments, shown on the Lock Screen and in the Dynamic
/// Island while it goes: shared by the app (which starts and moves it) and its widgets.
struct SendingAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable { case uploading, sending, sent, failed }
        var phase: Phase
        /// How much of the attachments has gone up, 0 to 1.
        var fraction: Double
        var attachments: Int
    }

    /// The session it's going to.
    let session: String
}
#endif
