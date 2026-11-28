import Foundation
import Observation

/// Bringing the hub's host up to this app (`apps/server/server/update.ts`, feature
/// `serverUpdate`): what it runs, what GitHub has, and an update to GitHub's main, only when
/// that announces everything this app needs (`AppProtocol.requires`), built and restarted
/// into. The hub store keeps one, so the Inbox's banner and Settings → System show the same
/// update while it runs.
@MainActor
@Observable
final class HostUpdater {
    enum Phase: Equatable {
        case idle
        case checking
        /// The host is fetching, installing and building: minutes.
        case updating
        /// Built; the host is restarting into it.
        case restarting
    }

    let api: APIClient
    let requires: [String: Int]
    private(set) var phase: Phase = .idle
    /// What the host runs, as it last said.
    private(set) var version: HostVersion?
    /// What GitHub has, from the last check.
    private(set) var check: HostUpdateCheck?
    /// The last update didn't build: the build's log (the host went back to what it ran).
    private(set) var buildLog: String?
    /// Why the last check or update was refused or failed, in the host's words.
    private(set) var error: String?
    /// The last update found the host already on GitHub's newest main.
    private(set) var alreadyCurrent = false
    /// Between asks for the version while the host restarts.
    @ObservationIgnored private let pause: @Sendable (Duration) async -> Void
    /// Asks before giving up on seeing the host back (it may come back later; the stream says so).
    @ObservationIgnored private let restartTries: Int

    init(api: APIClient, requires: [String: Int] = AppProtocol.requires, restartTries: Int = 90, pause: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
        self.api = api
        self.requires = requires
        self.restartTries = restartTries
        self.pause = pause
    }

    func loadVersion() async {
        do { version = try await api.hostVersion() } catch { self.error = APIError.shown(error) }
    }

    /// Asks the host to look at GitHub; moves nothing.
    func lookForUpdate() async {
        guard phase == .idle else { return }
        phase = .checking
        error = nil
        alreadyCurrent = false
        defer { if phase == .checking { phase = .idle } }
        do {
            let found = try await api.checkHostUpdate(requires: requires)
            check = found
            version = found.current
        } catch {
            self.error = APIError.shown(error)
        }
    }

    /// Updates the host to GitHub's main (when that serves this app), then waits to see it run.
    func update() async {
        guard phase == .idle else { return }
        phase = .updating
        error = nil
        buildLog = nil
        alreadyCurrent = false
        let result: HostUpdated
        do {
            result = try await api.updateHost(requires: requires)
        } catch {
            phase = .idle
            // A build that failed answers 500 with its log; a refusal (409) or GitHub out of
            // reach (502) answers with why.
            if case .server(500, let log) = APIError.wrap(error) { buildLog = log } else { self.error = APIError.shown(error) }
            return
        }
        check = nil
        guard result.restarting else {
            alreadyCurrent = !result.updated
            phase = .idle
            return
        }
        phase = .restarting
        for _ in 0..<restartTries {
            await pause(.seconds(2))
            if let now = try? await api.hostVersion(), now.commit == result.to {
                version = now
                break
            }
        }
        phase = .idle
    }
}
