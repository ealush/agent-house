import AppIntents
import UIKit

// Siri, Shortcuts, Spotlight and the Action button: open a session, ask what needs you,
// start a session, and send a message. They run in the app's own process against the
// hosts it's signed in to; nothing about a session is indexed or stored for them
// (`ShortcutCatalog`). Opening ones bring the app forward; asking and sending answer in
// place, and need the app's sign-in to still be valid.

struct SessionEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Agent House Session", numericFormat: "\(placeholder: .int) sessions")
    static let defaultQuery = SessionEntityQuery()

    let id: String
    let title: String
    let subtitle: String
    let needsYou: Bool

    init(_ session: ShortcutSession) {
        id = session.id
        title = session.title
        subtitle = session.subtitle
        needsYou = session.word == .needsYou || session.word == .limited
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)", image: .init(systemName: needsYou ? "exclamationmark.bubble" : "bubble.left.and.text.bubble.right"))
    }
}

struct SessionEntityQuery: EntityStringQuery {
    @MainActor func entities(for identifiers: [SessionEntity.ID]) async throws -> [SessionEntity] {
        let all = await IntentHost.sessions()
        return identifiers.compactMap { id in all.first { $0.id == id }.map(SessionEntity.init) }
    }

    @MainActor func entities(matching string: String) async throws -> [SessionEntity] {
        ShortcutCatalog.matching(string, in: await IntentHost.sessions()).map(SessionEntity.init)
    }

    @MainActor func suggestedEntities() async throws -> [SessionEntity] {
        Array(await IntentHost.sessions().prefix(12)).map(SessionEntity.init)
    }
}

/// The running app's hosts, for intents (which the system may start the app for).
@MainActor
enum IntentHost {
    static var app: AppModel? { (UIApplication.shared.delegate as? AppDelegate)?.app }

    /// Live sessions, after giving a just-launched app a moment to hear from its hosts.
    static func sessions() async -> [ShortcutSession] {
        guard let app else { return [] }
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline, app.accounts.contains(where: { $0.status == .signedIn && $0.hub.phase != .live && !$0.hub.showingCached }) {
            try? await Task.sleep(for: .milliseconds(150))
        }
        return ShortcutCatalog.sessions(app)
    }

    static func signedIn() throws -> AppModel {
        guard let app, app.accounts.contains(where: { $0.status == .signedIn }) else { throw IntentFailure.signedOut }
        return app
    }

    /// The window to act in: the one in front, else any; waits briefly for one to connect.
    static func scene() async -> SceneModel? {
        let deadline = Date().addingTimeInterval(3)
        repeat {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let target = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
            if let model = (target?.delegate as? SceneDelegate)?.model { return model }
            try? await Task.sleep(for: .milliseconds(100))
        } while Date() < deadline
        return nil
    }
}

enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    case signedOut
    case gone
    case notSent(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .signedOut: return "Open Agent House and sign in to your host first."
        case .gone: return "That session has ended."
        case .notSent(let why): return "Couldn’t send it: \(why)"
        }
    }
}

struct OpenSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Session"
    static let description = IntentDescription("Opens a session in Agent House.")
    static let openAppWhenRun = true

    @Parameter(title: "Session") var session: SessionEntity

    static var parameterSummary: some ParameterSummary { Summary("Open \(\.$session)") }

    @MainActor func perform() async throws -> some IntentResult {
        guard let (origin, key) = ShortcutSession.parse(session.id) else { throw IntentFailure.gone }
        guard let scene = await IntentHost.scene() else { return .result() }
        scene.useAccount(origin)
        scene.open(key)
        return .result()
    }
}

struct NeedsYouIntent: AppIntent {
    static let title: LocalizedStringResource = "What Needs Me"
    static let description = IntentDescription("Says which agent sessions are waiting on you.")

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<[SessionEntity]> & ProvidesDialog {
        _ = try IntentHost.signedIn()
        let sessions = await IntentHost.sessions()
        let waiting = sessions.filter { $0.word == .needsYou || $0.word == .limited }
        return .result(value: waiting.map(SessionEntity.init), dialog: "\(ShortcutCatalog.needsYouSummary(sessions))")
    }
}

struct ShowInboxIntent: AppIntent {
    static let title: LocalizedStringResource = "Show Inbox"
    static let description = IntentDescription("Opens the sessions that need you.")
    static let openAppWhenRun = true

    @MainActor func perform() async throws -> some IntentResult {
        await IntentHost.scene()?.show(.inbox)
        return .result()
    }
}

struct NewSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "New Session"
    static let description = IntentDescription("Opens New Session, with a first prompt filled in if you give one.")
    static let openAppWhenRun = true

    @Parameter(title: "First prompt", inputOptions: String.IntentInputOptions(multiline: true)) var prompt: String?

    static var parameterSummary: some ParameterSummary { Summary("New session with \(\.$prompt)") }

    @MainActor func perform() async throws -> some IntentResult {
        guard let scene = await IntentHost.scene() else { return .result() }
        scene.beginNewSession(SceneModel.NewSessionContext(prompt: prompt?.trimmingCharacters(in: .whitespacesAndNewlines)))
        return .result()
    }
}

struct SendMessageIntent: AppIntent {
    static let title: LocalizedStringResource = "Send Message"
    static let description = IntentDescription("Sends a message to a session; it waits in the queue while the agent works.")

    @Parameter(title: "Session") var session: SessionEntity
    @Parameter(title: "Message", inputOptions: String.IntentInputOptions(multiline: true)) var message: String

    static var parameterSummary: some ParameterSummary { Summary("Send \(\.$message) to \(\.$session)") }

    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let app = try IntentHost.signedIn()
        guard let (origin, key) = ShortcutSession.parse(session.id), let account = app.account(origin: origin) else { throw IntentFailure.gone }
        guard account.hub.row(key) != nil || account.hub.showingCached else { throw IntentFailure.gone }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw $message.needsValueError("What should it say?") }
        do {
            let result = try await account.hub.client(forKey: key).send(SessionKey(key)?.uid ?? key, text: text)
            return .result(dialog: "\(ShortcutCatalog.sentSummary(result.outcome, title: session.title))")
        } catch {
            throw IntentFailure.notSent(APIError.wrap(error).message)
        }
    }
}

struct AgentHubShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: NeedsYouIntent(), phrases: [
            "What needs me in \(.applicationName)",
            "What's waiting in \(.applicationName)",
            "Check \(.applicationName)",
        ], shortTitle: "What Needs Me", systemImageName: "exclamationmark.bubble")
        AppShortcut(intent: OpenSessionIntent(), phrases: [
            "Open \(\.$session) in \(.applicationName)",
            "Open a session in \(.applicationName)",
        ], shortTitle: "Open Session", systemImageName: "bubble.left.and.text.bubble.right")
        AppShortcut(intent: NewSessionIntent(), phrases: [
            "New \(.applicationName) session",
            "Start a session in \(.applicationName)",
        ], shortTitle: "New Session", systemImageName: "plus.bubble")
        AppShortcut(intent: SendMessageIntent(), phrases: [
            "Send a message in \(.applicationName)",
            "Tell \(\.$session) in \(.applicationName)",
        ], shortTitle: "Send Message", systemImageName: "paperplane")
        AppShortcut(intent: ShowInboxIntent(), phrases: [
            "Show my \(.applicationName) inbox",
        ], shortTitle: "Inbox", systemImageName: "tray")
    }
}
