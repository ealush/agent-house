import UIKit
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit

// ActivityKit's activities are for any thread to update (its methods are async and do their
// own work off the caller's), but the type isn't marked so; Swift 6 refused handing one to
// its own `update` and `end`.
extension Activity: @retroactive @unchecked Sendable {}
#endif

/// What the outbox is doing, carried on with the app put away: a message on its way asks iOS
/// for the time to finish (and gives it back when done), and one that waits on its
/// attachments says how far they've got on the Lock Screen and in the Dynamic Island.
@MainActor
enum Sending {
    static func install(_ app: AppModel) {
        let outbox = app.outbox
        outbox.keepUploading = { name in keepUploading(name) }
        outbox.keepAlive = { [weak app] id in
            let held = Held()
            // Out of time: the upload stops where it is (and the message comes back to its box).
            held.task = UIApplication.shared.beginBackgroundTask(withName: "Sending a message") { held.end() }
            let live = Live.start(for: id, outbox: outbox, session: app.flatMap { title(of: id, outbox: outbox, in: $0) } ?? "Agent Hub")
            return {
                live?.finish(outbox.items.first { $0.id == id })
                held.end()
            }
        }
    }

    /// Background time for an attachment's upload, given back when it's done.
    static func keepUploading(_ name: String) -> @MainActor () -> Void {
        let held = Held()
        held.task = UIApplication.shared.beginBackgroundTask(withName: name) { held.end() }
        return { held.end() }
    }

    private static func title(of id: Int, outbox: Outbox, in app: AppModel) -> String? {
        guard let key = outbox.items.first(where: { $0.id == id })?.key else { return nil }
        return app.accounts.lazy.compactMap { $0.hub.row(key)?.title }.first
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

    /// The Live Activity of a message waiting on its uploads, moved along as they go.
    @MainActor
    private final class Live {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        private let activity: Activity<SendingAttributes>
        private var watch: Task<Void, Never>?

        private init(activity: Activity<SendingAttributes>) { self.activity = activity }

        static func start(for id: Int, outbox: Outbox, session: String) -> Live? {
            // Only for one with something to upload: text alone is there before it'd show.
            guard let item = outbox.items.first(where: { $0.id == id }), !item.waitingOn.isEmpty,
                  ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
            let first = state(item, outbox)
            guard let activity = try? Activity.request(attributes: SendingAttributes(session: session), content: .init(state: first, staleDate: nil)) else { return nil }
            let live = Live(activity: activity)
            live.watch = Task { @MainActor [weak live] in
                var shown = first
                while !Task.isCancelled, let live {
                    try? await Task.sleep(for: .milliseconds(400))
                    guard let item = outbox.items.first(where: { $0.id == id }) else { return }
                    let next = state(item, outbox)
                    // In steps of a few percent: the Lock Screen has a budget for updates.
                    if next.phase != shown.phase || abs(next.fraction - shown.fraction) >= 0.03 {
                        shown = next
                        await live.activity.update(.init(state: next, staleDate: nil))
                    }
                }
            }
            return live
        }

        private static func state(_ item: Outbox.Item, _ outbox: Outbox) -> SendingAttributes.ContentState {
            let waiting = outbox.progress(item)
            return .init(phase: waiting == nil ? .sending : .uploading, fraction: waiting ?? 1, attachments: max(1, item.waitingOn.count))
        }

        /// Done: "Sent" for a moment, or that it didn't go (the item's gone: it failed).
        func finish(_ item: Outbox.Item?) {
            watch?.cancel()
            let phase: SendingAttributes.ContentState.Phase = item.map { $0.state == .sending && !$0.waitingOn.isEmpty ? .failed : .sent } ?? .failed
            let last = SendingAttributes.ContentState(phase: phase, fraction: 1, attachments: activity.content.state.attachments)
            let activity = activity
            Task { @MainActor in await activity.end(.init(state: last, staleDate: nil), dismissalPolicy: .after(.now + 4)) }
        }
        #else
        static func start(for id: Int, outbox: Outbox, session: String) -> Live? { nil }
        func finish(_ item: Outbox.Item?) {}
        #endif
    }
}
