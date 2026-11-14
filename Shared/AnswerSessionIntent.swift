#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import AppIntents
import Foundation

/// Approve or Deny from a session's Live Activity, for a plain permission prompt: the same
/// answer as the notification's buttons. The widgets show the buttons; iOS runs the intent in
/// the app's own process (`SessionActivities.answer`), only once the device is unlocked.
struct AnswerSessionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Answer a Session"
    static let isDiscoverable = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Host") var host: String
    @Parameter(title: "Session") var uid: String
    @Parameter(title: "Approve") var approve: Bool
    /// The prompt the activity showed (the host's `askId`): the host refuses an answer to an
    /// older one. Empty from a host that predates it.
    @Parameter(title: "Prompt") var prompt: String

    init() {}

    init(host: String, uid: String, approve: Bool, prompt: String?) {
        self.host = host
        self.uid = uid
        self.approve = approve
        self.prompt = prompt ?? ""
    }

    func perform() async throws -> some IntentResult {
        guard let answer = await LiveAnswer.handler else { throw LiveAnswer.Unavailable() }
        try await answer(host, uid, approve, prompt.isEmpty ? nil : prompt)
        return .result()
    }
}

/// What answers it, set by the app at launch (the widgets never run it).
@MainActor
enum LiveAnswer {
    static var handler: (@MainActor (_ host: String, _ uid: String, _ approve: Bool, _ prompt: String?) async throws -> Void)?

    struct Unavailable: Error, CustomLocalizedStringResourceConvertible {
        var localizedStringResource: LocalizedStringResource { "Open Agent Hub to answer it." }
    }

    /// The host said no (it asks something else now, it stopped waiting): nothing was sent.
    struct Refused: Error, CustomLocalizedStringResourceConvertible {
        let reason: String
        var localizedStringResource: LocalizedStringResource { "\(reason)" }
    }
}
#endif
