import Foundation

/// Handoff between your own devices (`NSUserActivity`): where a window is, as an activity
/// another device continues in this app (same host, same place) or, without the app, in the
/// host's web app at the same place. The web's hash names it: "#<uid>", "#<host>/<uid>",
/// "#history", "#review/<stack>/<pr>" (`apps/server/web/App.tsx` fromHash). Only non-secret
/// navigation travels: the host's origin and that hash.
struct Handoff: Equatable, Sendable {
    static let activityType = "dev.ealush.ah.native.handoff"

    let origin: String
    let route: SceneSnapshot.Route
    let title: String

    /// The web app's hash for this place, without "#".
    var hash: String { Self.hash(route) }

    /// The same place in the host's web app, for a device without this app.
    var webpageURL: URL? {
        guard var components = URLComponents(string: origin), components.scheme == "https" else { return nil }
        components.path = "/"
        components.fragment = hash.isEmpty ? nil : hash
        return components.url
    }

    var userInfo: [String: String] { ["origin": origin, "hash": hash] }

    init(origin: String, route: SceneSnapshot.Route, title: String) {
        self.origin = origin
        self.route = route
        self.title = title
    }

    /// From a continued activity; nil when it isn't ours or names no host.
    init?(userInfo: [AnyHashable: Any]) {
        guard let origin = userInfo["origin"] as? String, !origin.isEmpty else { return nil }
        let hash = userInfo["hash"] as? String ?? ""
        self.init(origin: origin, route: Self.route(hash: hash), title: "")
    }

    static func hash(_ route: SceneSnapshot.Route) -> String { Place(route).hash }

    /// The web's `fromHash` (`Place`): a page, review with its place, settings with its
    /// section, a session key ("uid" or "host/uid"), anything else the Inbox.
    static func route(hash raw: String) -> SceneSnapshot.Route { Place(hash: raw).route }
}
