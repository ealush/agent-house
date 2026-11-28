import Foundation
import Observation

/// The Inbox's interrupted cards' actions (`web/InterruptedCard.tsx`): restore an incident's
/// sessions, one of them, or dismiss the incident. The host's state brings the change back.
@MainActor
@Observable
final class InterruptionsModel {
    let api: APIClient
    /// What's on its way: an incident id, or a session's ref.
    private(set) var busy: Set<String> = []
    /// Why the last one didn't go through, by incident.
    private(set) var errors: [String: String] = [:]
    private let refresh: () -> Void

    init(api: APIClient, refresh: @escaping () -> Void = {}) {
        self.api = api
        self.refresh = refresh
    }

    func restoreAll(_ incident: String) async {
        await run(incident, incident) {
            let out = try await self.api.restoreInterrupted(incident: incident)
            if let failed = out.failed, let first = failed.first { return "\(failed.count) couldn’t be restored: \(first.error)" }
            return nil
        }
    }

    func restore(_ row: HistoryRow, of incident: String) async {
        await run(row.dto.ref, incident) {
            try await self.api.restoreSession(row.dto.ref)
            return nil
        }
    }

    func dismiss(_ incident: String) async {
        await run(incident, incident) {
            _ = try await self.api.dismissInterrupted(incident: incident)
            return nil
        }
    }

    private func run(_ key: String, _ incident: String, _ body: () async throws -> String?) async {
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            errors[incident] = try await body()
        } catch {
            errors[incident] = APIError.shown(error)
        }
        refresh()
    }
}
