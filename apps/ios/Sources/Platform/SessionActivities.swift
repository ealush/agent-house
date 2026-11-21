import OSLog
import UIKit
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
#endif

private let activityLog = Logger(subsystem: "dev.ealush.ah.native", category: "live-activity")

/// A session you sent a message to from this device, on the Lock Screen and in the Dynamic
/// Island until it finishes (`SessionActivityRules`). While the app runs it moves each one
/// itself from the session lists it follows; put away, the host moves it by push
/// (`PUT /api/push/apns/activity`), when the host has an APNs key and the session is its
/// own (a peer's sessions are followed only while the app runs). An activity iOS kept from
/// before (the app was closed) is picked up again at launch.
@MainActor
enum SessionActivities {
    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    /// One followed activity, by account origin and session key.
    private final class Live {
        let activity: Activity<SessionAttributes>
        let origin: String
        let key: String
        var follow: SessionActivityRules.Follow
        /// The host took its push token: it keeps it current with the app put away.
        var pushed = false
        /// When iOS shows it as out of date unless the app looks again (nil: not known, or pushed).
        var staleAt: Double?
        var tokens: Task<Void, Never>?

        init(activity: Activity<SessionAttributes>, origin: String, key: String, follow: SessionActivityRules.Follow) {
            self.activity = activity
            self.origin = origin
            self.key = key
            self.follow = follow
        }
    }

    private static var live: [String: Live] = [:]
    /// Looks again now and then while the app runs: a turn quiet for a while isn't out of date.
    private static var ticker: Task<Void, Never>?
    private static func id(_ origin: String, _ key: String) -> String { "\(origin)#\(key)" }
    /// The longest a Live Activity runs (iOS ends it at eight hours).
    private static let lifetime: TimeInterval = 8 * 3600
    /// A finished one stays on the Lock Screen this long (the host's `ACTIVITY_LINGER_S`).
    private static let linger: TimeInterval = 15 * 60
    /// Shown as out of date past this while nothing can move it (no push, app put away).
    private static let staleAfter: TimeInterval = 10 * 60
    #endif

    /// Picks up activities from before, then follows every signed-in host's session lists.
    static func install(_ app: AppModel) {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        for activity in Activity<SessionAttributes>.activities where isUp(activity) {
            // Its account by host (sign-ins may still be coming back; one that's gone ends it later).
            guard let account = app.accounts.first(where: { $0.hostname == activity.attributes.host || $0.hub.hosts.contains { $0.name == activity.attributes.host } }) else {
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
                continue
            }
            let key = activity.attributes.host == account.hostname ? activity.attributes.uid : "\(activity.attributes.host)/\(activity.attributes.uid)"
            // From before: it was seen at work, or it'll end within the minute anyway.
            let follow = SessionActivityRules.Follow(began: Date().timeIntervalSince1970, started: true, shown: activity.content.state)
            adopt(activity, origin: account.origin, key: key, follow: follow, app: app)
        }
        LiveAnswer.handler = { [weak app] host, uid, approve, prompt in
            guard let app else { throw LiveAnswer.Unavailable() }
            try await answer(host: host, uid: uid, approve: approve, prompt: prompt, app: app)
        }
        watch(app)
        ticker = Task { @MainActor [weak app] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard let app else { return }
                step(app)
            }
        }
        #endif
    }

    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    /// Approve or Deny from its Live Activity: answered on its host, and shown at work again
    /// at once (its row, or the host's push, says where it goes from there).
    static func answer(host: String, uid: String, approve: Bool, prompt: String?, app: AppModel) async throws {
        guard let account = app.accounts.first(where: { $0.status == .signedIn && ($0.hostname == host || $0.hub.hosts.contains { $0.name == host }) }) else {
            throw LiveAnswer.Unavailable()
        }
        let key = host == account.hostname ? uid : "\(host)/\(uid)"
        do {
            try await account.hub.client(forKey: key).answer(uid, approve: approve, prompt: prompt)
        } catch {
            // Nothing was sent: the activity says where it is from the next look, not "Approved".
            let wrapped = APIError.wrap(error)
            if case .conflict = wrapped { throw LiveAnswer.Refused(reason: wrapped.message.contains("asking something else") ? "It’s asking something else now. Open it to see what." : "It’s no longer waiting on that.") }
            throw wrapped
        }
        let state = SessionActivityState(phase: .working, detail: approve ? "Approved" : "Denied", answerable: false, since: Date().timeIntervalSince1970)
        if let entry = live[id(account.origin, key)] {
            entry.follow.shown = state
            show(entry, state, now: state.since)
        } else if let activity = Activity<SessionAttributes>.activities.first(where: { $0.attributes.uid == uid && $0.attributes.host == host }) {
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
    }
    #endif

    /// You sent `key` a message: its activity starts (or carries on, if it's still up).
    static func began(key: String, app: AppModel) {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        let prefs = app.preferences.notifications
        // iOS starts one only from the foreground (a reply from a notification can't).
        guard UIApplication.shared.applicationState == .active,
              prefs.liveActivities, ActivityAuthorizationInfo().areActivitiesEnabled,
              let account = app.accounts.first(where: { $0.status == .signedIn && $0.hub.row(key) != nil }),
              let row = account.hub.row(key) else { return }
        let now = Date().timeIntervalSince1970
        if let current = live[id(account.origin, key)], isUp(current.activity) {
            // A new turn: it can't end before this one is seen at work.
            current.follow = .init(began: now, started: false, shown: current.follow.shown)
            return
        }
        let agent = account.hub.presets(host: row.isLocal ? nil : row.host).first { $0.id == row.dto.agent }?.name ?? row.dto.agent ?? "Shell"
        let attributes = SessionAttributes(
            title: prefs.privatePreview ? "A session" : row.title,
            project: prefs.privatePreview ? "" : row.dto.project,
            agent: agent,
            agentId: row.dto.agent,
            host: row.host,
            uid: row.uid,
            link: DeepLink.session(host: row.host, uid: row.uid).url
        )
        // The last turn's card, still lingering after it finished, gives way to this one.
        for old in Activity<SessionAttributes>.activities where old.attributes.uid == row.uid && old.attributes.host == row.host {
            Task { await old.end(nil, dismissalPolicy: .immediate) }
        }
        // A few at once, never a wall of them: the one longest without news gives way.
        let current = live.map { (key: $0.key, began: $0.value.follow.began, over: $0.value.follow.shown?.isOver ?? false) }
        if let out = SessionActivityRules.evict(current), let entry = live[out] { end(out, entry, last: entry.follow.shown, app: app) }
        let first = SessionActivityRules.starting(at: now)
        let content = ActivityContent(state: first, staleDate: Date(timeIntervalSince1970: now + staleAfter))
        // A push token needs the Push Notifications entitlement; without it, a local one.
        let activity: Activity<SessionAttributes>
        do {
            activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
        } catch {
            activityLog.debug("no push-token activity (\(error.localizedDescription, privacy: .public)); a local one")
            guard let local = try? Activity.request(attributes: attributes, content: content, pushType: nil) else { return }
            activity = local
        }
        adopt(activity, origin: account.origin, key: key, follow: .init(began: now, shown: first), app: app)
        live[id(account.origin, key)]?.staleAt = now + staleAfter
        // Its row may already say where it is (a queued message, a session at work).
        step(app)
        #endif
    }

    /// `account` signed in again (Face ID): the host forgot its activities with the old sign-in,
    /// so each one's push token goes to it again.
    static func signedIn(_ account: AccountSession) {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        for (_, entry) in live where entry.origin == account.origin && SessionKey(entry.key)?.host == nil {
            let activity = entry.activity
            guard let token = activity.pushToken else { continue }
            let hex = token.map { String(format: "%02x", $0) }.joined()
            Task { @MainActor [weak entry] in
                do {
                    try await account.api.registerActivity(activity.attributes.uid, token: hex, environment: PushRegistrar.environment)
                    entry?.pushed = true
                } catch {
                    entry?.pushed = false
                }
            }
        }
        #endif
    }

    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    /// Still on screen: at work, or out of date (nothing moved it a while). An out-of-date one
    /// is still the app's to move: left behind, it showed its clock for hours.
    private static func isUp(_ activity: Activity<SessionAttributes>) -> Bool {
        activity.activityState == .active || activity.activityState == .stale
    }

    private static func adopt(_ activity: Activity<SessionAttributes>, origin: String, key: String, follow: SessionActivityRules.Follow, app: AppModel) {
        let entry = Live(activity: activity, origin: origin, key: key, follow: follow)
        live[id(origin, key)] = entry
        // Only the hub's own sessions: the host follows its own windows, not a peer's.
        guard SessionKey(key)?.host == nil else { return }
        entry.tokens = Task { @MainActor [weak entry, weak app] in
            @MainActor func register(_ token: Data) async {
                guard let entry, let app, let account = app.account(origin: origin) else { return }
                let hex = token.map { String(format: "%02x", $0) }.joined()
                do {
                    try await account.api.registerActivity(activity.attributes.uid, token: hex, environment: PushRegistrar.environment)
                    entry.pushed = true
                    activityLog.debug("the host keeps it current")
                } catch {
                    // No APNs key on the host (409): the app moves it while it runs.
                    entry.pushed = false
                    activityLog.debug("the host didn't take it: \(APIError.wrap(error).message, privacy: .public)")
                }
            }
            // One picked up from before has its token already; a new one gets it shortly.
            if let token = activity.pushToken { await register(token) }
            for await token in activity.pushTokenUpdates { await register(token) }
        }
    }

    private static func watch(_ app: AppModel) {
        withObservationTracking {
            for account in app.accounts where account.status == .signedIn { _ = account.hub.rows }
        } onChange: {
            Task { @MainActor in
                step(app)
                watch(app)
            }
        }
    }

    /// Each activity takes the next step its session's row calls for.
    private static func step(_ app: AppModel) {
        guard !live.isEmpty else { return }
        let now = Date().timeIntervalSince1970
        let prefs = app.preferences.notifications
        for (id, entry) in live {
            guard isUp(entry.activity), now - entry.follow.began < lifetime else {
                // Dismissed from the Lock Screen, or ended by the host's push.
                forget(id, entry, app: app)
                continue
            }
            guard let account = app.account(origin: entry.origin), account.status == .signedIn else {
                end(id, entry, last: nil, app: app)
                continue
            }
            // A host with nothing current to say (coming back from the background) says nothing;
            // one polled while its stream is down does.
            guard account.hub.phase.isUsable else { continue }
            switch SessionActivityRules.step(&entry.follow, dto: account.hub.row(entry.key)?.dto, now: now, privatePreview: prefs.privatePreview) {
            case .wait:
                // Nothing new, and seen just now: not out of date.
                if !entry.pushed, let shown = entry.follow.shown, SessionActivityRules.looksAgain(staleAt: entry.staleAt, now: now, staleAfter: staleAfter) {
                    show(entry, shown, now: now)
                }
            case .update(let state):
                show(entry, state, now: now)
            case .end(let state):
                end(id, entry, last: state, app: app)
            }
        }
    }

    /// Shows `state`. With no push to move it, iOS shows it as out of date `staleAfter` on,
    /// unless the app looks again before then.
    private static func show(_ entry: Live, _ state: SessionActivityState, now: Double) {
        let activity = entry.activity
        let stale = entry.pushed ? nil : Date(timeIntervalSince1970: now + staleAfter)
        entry.staleAt = stale?.timeIntervalSince1970
        Task { await activity.update(ActivityContent(state: state, staleDate: stale)) }
    }

    private static func end(_ id: String, _ entry: Live, last: SessionActivityState?, app: AppModel) {
        let activity = entry.activity
        let content = last.map { ActivityContent(state: $0, staleDate: nil) }
        Task { await activity.end(content, dismissalPolicy: .after(.now + linger)) }
        forget(id, entry, app: app)
    }

    private static func forget(_ id: String, _ entry: Live, app: AppModel) {
        entry.tokens?.cancel()
        live[id] = nil
        guard entry.pushed, let account = app.account(origin: entry.origin) else { return }
        let uid = entry.activity.attributes.uid
        Task { try? await account.api.unregisterActivity(uid) }
    }
    #endif
}
