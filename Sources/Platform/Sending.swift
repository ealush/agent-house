import UIKit

/// What the outbox is doing, carried on with the app put away: a message waiting on its
/// attachments (or just sending) asks iOS for the time to finish, and gives it back when done.
@MainActor
enum Sending {
    static func install(_ app: AppModel) {
        app.outbox.keepAlive = { name in
            let held = Held()
            // Out of time: the upload stops where it is (and the message comes back to its box).
            held.task = UIApplication.shared.beginBackgroundTask(withName: name) { held.end() }
            return { held.end() }
        }
    }

    /// One stretch of background time, given back once.
    private final class Held: @unchecked Sendable {
        var task = UIBackgroundTaskIdentifier.invalid

        @MainActor func end() {
            guard task != .invalid else { return }
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
    }
}
