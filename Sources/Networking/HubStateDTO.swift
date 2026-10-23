import Foundation

/// Read-only Inbox projection of API 28, pinned in SOURCE.json.
/// History, presets, review and theme are deliberately outside this projection.
/// These DTOs stay in memory; they must not be written to the scene journal.
struct HubStateDTO: Decodable, Equatable, Sendable {
    static let supportedAPIVersion = 28

    var api: Int
    var hostname: String
    var hosts: [HostDTO]
    var windows: [SessionDTO]
    var focus: FocusDTO?

    func validate() throws {
        guard api == Self.supportedAPIVersion else {
            throw StateError.unsupportedAPI(api)
        }
        guard !hostname.isEmpty,
              hosts.allSatisfy({ !$0.name.isEmpty }),
              Set(hosts.map(\.name)).count == hosts.count,
              windows.allSatisfy({ !$0.id.isEmpty && !$0.uid.isEmpty }),
              Set(windows.map(\.uid)).count == windows.count,
              Set(windows.map(\.id)).count == windows.count else {
            throw StateError.invalidIdentity
        }
    }

    enum StateError: Error, Equatable {
        case unsupportedAPI(Int)
        case invalidIdentity
        case snapshotRequired
        case nullRequiredField
    }
}

struct HostDTO: Decodable, Equatable, Sendable {
    let name: String
    let isSelf: Bool
    let online: Bool

    private enum CodingKeys: String, CodingKey {
        case name, online
        case isSelf = "self"
    }
}

struct FocusDTO: Decodable, Equatable, Sendable {
    let key: String
    let device: String
    let client: String
    /// Server epoch seconds, not Foundation's reference date.
    let at: Double
}

struct SessionDTO: Decodable, Equatable, Sendable {
    /// Transient tmux address; never use this as the navigation identity.
    let id: String
    let uid: String
    let name: String
    let title: String
    let agent: String?
    let model: String?
    let statusSource: StatusSource
    let project: String
    let projectPath: String
    let branch: String?
    let worktree: Bool
    let status: Status
    let detail: String?
    let limit: String?
    let ask: AskDTO?
    let answerable: Bool
    let viewers: Int
    let devices: [String]
    let activity: Double
    let createdAt: Double
    let panes: Int
    let pinned: Bool
    let queued: Int
    let order: Double?
    let feed: String?

    func identity(on host: String) -> SessionIdentity {
        SessionIdentity(host: host, uid: uid)
    }

    // Unknown values fail decoding, rather than inventing an idle/safe state.
    enum Status: String, Decodable, Sendable {
        case busy, idle, waiting, attention
    }

    enum StatusSource: String, Decodable, Sendable {
        case hook, screen, activity
    }
}

struct AskDTO: Decodable, Equatable, Sendable {
    let kind: Kind
    let text: String
    let questions: [Question]?
    let options: [ScreenOption]?
    let dialog: Dialog?

    enum Kind: String, Decodable, Sendable {
        case command, tool, question, screen, choice
    }

    struct Question: Decodable, Equatable, Sendable {
        let question: String
        let header: String?
        let multiSelect: Bool
        let options: [Option]
    }

    struct Option: Decodable, Equatable, Sendable {
        let label: String
        let description: String?
        let checked: Bool?
    }

    struct ScreenOption: Decodable, Equatable, Sendable {
        let key: String
        let label: String
    }

    struct Dialog: Decodable, Equatable, Sendable {
        let question: String
        let multiSelect: Bool
        let options: [Option]
        let total: Int
        let answered: Int
    }
}
