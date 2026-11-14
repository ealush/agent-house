import Foundation

/// What a session's Live Activity shows on the Lock Screen and in the Dynamic Island: the
/// `ContentState` of `SessionAttributes`. The app's own updates and the host's pushes
/// (`server/apns.ts` `activityState`) use these keys and values, so either decodes as-is.
/// Compiled into the widgets too (`project.yml`), which draw it.
struct SessionActivityState: Codable, Hashable, Sendable {
    enum Phase: String, Codable, Sendable {
        /// Sent from this device, not yet seen at work (the app's own; the host never sends it).
        case starting
        case working, waiting, finished, limited
        /// The session went away mid-turn (ended, killed): it didn't finish.
        case failed
        /// A phase from a newer host this build doesn't know: shown as "open the app", never guessed.
        case unknown

        init(from decoder: any Decoder) throws {
            self = Phase(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    var phase: Phase
    /// What it's doing, what it asks, or when its limit resets: one short line. Nil on a
    /// private preview, and once it's finished.
    var detail: String?
    /// One-tap Approve/Deny applies (a plain permission prompt).
    var answerable: Bool
    /// When this phase began, seconds since 1970: the Lock Screen counts up from it.
    var since: Double
    /// The prompt Approve/Deny are about (the host's `askId`): the host refuses an answer to an
    /// older one. Nil from a host that predates it.
    var prompt: String? = nil
    /// Messages waiting in its queue behind this turn: real numbers, never a guessed percentage.
    var queued: Int? = nil

    var isOver: Bool { phase == .finished || phase == .limited || phase == .failed }

    init(phase: Phase, detail: String?, answerable: Bool, since: Double, prompt: String? = nil, queued: Int? = nil) {
        self.phase = phase
        self.detail = detail
        self.answerable = answerable
        self.since = since
        self.prompt = prompt
        self.queued = queued
    }
}
