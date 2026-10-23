import Foundation

/// Navigation metadata only. Credentials, drafts, titles and transcripts do not belong here.
struct SceneSnapshot: Codable, Equatable, Sendable {
    static let currentVersion = 1

    let version: Int
    let sceneID: String
    let hostOrigin: String?

    init(sceneID: String, hostOrigin: String?) {
        version = Self.currentVersion
        self.sceneID = sceneID
        self.hostOrigin = hostOrigin
    }
}

