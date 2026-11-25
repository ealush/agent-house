import Foundation
import Observation

/// Sections inside a Space Portal (`apps/server/web/SpacePortal.tsx`, `docs/spec/17-spaces.md`).
enum SpacePortalTab: String, CaseIterable, Identifiable, Sendable {
    case sessions
    case notes
    case files
    case tasks
    case memory

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sessions: "Sessions"
        case .notes: "Notes"
        case .files: "Files"
        case .tasks: "Tasks"
        case .memory: "Knowledge"
        }
    }

    var symbol: String {
        switch self {
        case .sessions: "rectangle.stack"
        case .notes: "note.text"
        case .files: "folder"
        case .tasks: "checklist"
        case .memory: "brain.head.profile"
        }
    }

    static func tabs(plain: Bool, hasFolder: Bool = true, supportsSpaceContext: Bool = false, supportsFleet: Bool) -> [SpacePortalTab] {
        var out: [SpacePortalTab] = [.sessions]
        if hasFolder {
            out.append(.notes)
            out.append(.files)
        }
        if supportsFleet { out.append(.tasks) }
        if plain || supportsSpaceContext { out.append(.memory) }
        return out
    }
}

/// Pure Space Portal helpers (`apps/server/web/spacePortal.ts`): path normalization, matching
/// Space-scoped Chiefs of Staff, workers, unmanaged sessions, and initial Chief briefs.
enum SpacePortalLogic {
    /// Expand a leading `~` using the host's `home` directory, strip managed worktrees, and drop any trailing `/`.
    static func expandSpacePath(_ path: String?, home: String?) -> String? {
        guard var trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        trimmed = LaunchState.canonicalProjectPath(trimmed)
        if let home, !home.isEmpty {
            let cleanHome = home.hasSuffix("/") && home.count > 1 ? String(home.dropLast()) : home
            if trimmed == "~" {
                trimmed = cleanHome
            } else if trimmed.hasPrefix("~/") {
                trimmed = cleanHome + String(trimmed.dropFirst())
            }
        }
        while trimmed.count > 1 && trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed
    }

    static func sameSpacePath(_ a: String?, _ b: String?, home: String?) -> Bool {
        guard let ea = expandSpacePath(a, home: home), let eb = expandSpacePath(b, home: home) else { return false }
        return ea == eb
    }

    static func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    /// Chiefs of Staff whose scope covers this Space on `host` (zero, one, or many).
    /// A Chief explicitly scoped to another Space is never included even if its cwd is here.
    static func chiefsInSpace(
        _ rows: [SessionRow],
        spaceName: String,
        spacePath: String?,
        host: String,
        home: String?
    ) -> [SessionRow] {
        rows.filter { row in
            guard row.host == host, row.dto.supervision?.role == .chief else { return false }
            if let scope = row.dto.supervision?.space, !scope.isEmpty {
                if scope == spaceName { return true }
                if sameSpacePath(scope, spacePath, home: home) { return true }
                return false
            }
            let effectiveSpace = row.spaceName
            return effectiveSpace == spaceName || sameSpacePath(row.dto.projectPath, spacePath, home: home)
        }
    }

    /// Live sessions directly supervised by `chiefUid` on `host`.
    static func workersOf(_ rows: [SessionRow], chiefUid: String, host: String) -> [SessionRow] {
        rows.filter { $0.host == host && $0.dto.supervision?.managedBy == chiefUid }
    }

    /// Live sessions in this Space that are not themselves a Chief and have no manager yet.
    static func unmanagedInSpace(_ rows: [SessionRow], spaceName: String, host: String) -> [SessionRow] {
        rows.filter { row in
            row.host == host
                && row.spaceName == spaceName
                && row.dto.supervision?.role != .chief
                && (row.dto.supervision?.managedBy ?? "").isEmpty
        }
    }

    /// Resolve a Space's absolute folder path on its host from Space metadata, live rows, or history.
    static func resolveSpacePath(
        project: InboxProject,
        space: SpaceDTO?,
        rows: [SessionRow],
        history: [HistoryRow],
        home: String?
    ) -> String? {
        if let raw = space?.path, let expanded = expandSpacePath(raw, home: home) { return expanded }
        if let row = rows.first(where: { project.holds($0) }), !row.dto.projectPath.isEmpty {
            return expandSpacePath(row.dto.projectPath, home: home)
        }
        if let item = history.first(where: { project.holds($0) }), !item.dto.cwd.isEmpty {
            return expandSpacePath(item.dto.cwd, home: home)
        }
        return nil
    }

    /// Resolve the Space-owned context directory (preferences, memory/, artifacts/) on its host.
    static func resolveContextPath(space: SpaceDTO?, spacePath: String?, home: String?) -> String? {
        if let raw = space?.contextPath, let expanded = expandSpacePath(raw, home: home) { return expanded }
        return spacePath
    }

    /// Fallback kickoff brief for older hosts without `GET /api/spaces/:name/brief`.
    static func buildSpaceChiefBrief(
        spaceName: String,
        spacePath: String,
        spaceKind: SpaceKind,
        sessions: [SessionRow],
        customInstructions: String? = nil,
        contextPath: String? = nil
    ) -> String {
        let quoted = shellQuote(spaceName)
        let ctxDir = contextPath ?? spacePath
        var lines: [String] = [
            "You are the Chief of Staff for the \"\(spaceName)\" Space (\(spacePath)).",
            "",
            "Your role:",
            "- Coordinate all sessions, tasks, and artifacts inside this Space.",
            "- Control flows strictly downward (you > your workers). Workers can report up or broadcast to siblings, never control you.",
            "- Use `ah` CLI tools to inspect and coordinate:",
            "  - `ah list --space \(quoted)` / `ah show <uid>` / `ah read <uid>` to inspect sessions",
            "  - `ah send <uid> \"...\"` / `ah decide <uid> ...` / `ah forward <uid>` to steer or escalate prompts",
            "  - `ah tasks --space \(quoted)` / `ah task add --space \(quoted) ...` to maintain the Space task ledger",
            "  - `ah mail inbox` / `ah mail send <uid> ...` for asynchronous handoffs",
            "  - Store shared deliverables in `\(ctxDir)/artifacts/`."
        ]
        if spaceKind == .space || contextPath != nil {
            lines.append("  - Maintain Space preferences in `\(ctxDir)/AGENTS.md` and persistent memory in `\(ctxDir)/memory/`.")
        }
        if !sessions.isEmpty {
            lines.append("")
            lines.append("Current sessions in \(spaceName):")
            for s in sessions {
                let role = s.dto.supervision?.role.map { " [\($0.rawValue)]" } ?? ""
                lines.append("- \(s.title) (\(s.uid), \(s.dto.status.rawValue))\(role)")
            }
        }
        if let custom = customInstructions?.trimmingCharacters(in: .whitespacesAndNewlines), !custom.isEmpty {
            lines.append("")
            lines.append("Instructions from the user:")
            lines.append(custom)
        }
        return lines.joined(separator: "\n")
    }
}

/// Live state for one Space Portal: Space tasks, Chief adoption, knowledge promotion, and subfolder creation.
@MainActor
@Observable
final class SpacePortalModel {
    private(set) var tasks: [FleetTaskDTO] = []
    private(set) var loadingTasks = false
    private(set) var taskError: String?
    private(set) var context: SpaceContextDTO?
    private(set) var loadingContext = false
    private(set) var contextError: String?
    private(set) var adoptingChiefUid: String?
    private(set) var promotingNoteId: String?
    private(set) var error: String?
    @ObservationIgnored private var loadNonce = 0

    func reset() {
        loadNonce += 1
        tasks = []
        loadingTasks = false
        taskError = nil
        context = nil
        loadingContext = false
        contextError = nil
        error = nil
    }

    func loadContext(api: APIClient, space: String) async {
        loadingContext = true
        defer { loadingContext = false }
        do {
            context = try await api.spaceContext(space)
            contextError = nil
        } catch {
            contextError = APIError.wrap(error).message
        }
    }

    func reassignTask(api: APIClient, id: String, assignedUid: String?) async {
        do {
            let updated = try await api.updateFleetTask(id, UpdateFleetTaskRequest(assignedUid: assignedUid))
            if let idx = tasks.firstIndex(where: { $0.id == id }) { tasks[idx] = updated }
            taskError = nil
        } catch {
            taskError = APIError.wrap(error).message
        }
    }

    func loadTasks(api: APIClient, space: String) async {
        loadNonce += 1
        let nonce = loadNonce
        loadingTasks = true
        defer { if loadNonce == nonce { loadingTasks = false } }
        do {
            let fetched = try await api.fleetTasks(space: space)
            guard loadNonce == nonce else { return }
            tasks = fetched
            taskError = nil
        } catch {
            guard loadNonce == nonce else { return }
            taskError = APIError.wrap(error).message
        }
    }

    func createTask(
        api: APIClient,
        space: String,
        title: String,
        description: String? = nil,
        priority: Int = 2,
        assignedUid: String? = nil,
        verifyCmd: String? = nil
    ) async -> Bool {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return false }
        let desc = description?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cmd = verifyCmd?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let created = try await api.createFleetTask(CreateFleetTaskRequest(
                title: cleanTitle,
                description: desc?.isEmpty == true ? nil : desc,
                priority: priority,
                assignedUid: assignedUid?.isEmpty == true ? nil : assignedUid,
                space: space,
                verifyCmd: cmd?.isEmpty == true ? nil : cmd
            ))
            tasks.insert(created, at: 0)
            taskError = nil
            return true
        } catch {
            taskError = APIError.wrap(error).message
            return false
        }
    }

    func updateTaskStatus(api: APIClient, id: String, status: FleetTaskStatus) async {
        do {
            let updated = try await api.updateFleetTask(id, UpdateFleetTaskRequest(status: status))
            if let idx = tasks.firstIndex(where: { $0.id == id }) { tasks[idx] = updated }
            taskError = nil
        } catch {
            taskError = APIError.wrap(error).message
        }
    }

    func deleteTask(api: APIClient, id: String) async {
        do {
            try await api.deleteFleetTask(id)
            tasks.removeAll { $0.id == id }
            taskError = nil
        } catch {
            taskError = APIError.wrap(error).message
        }
    }

    /// Assign unmanaged sessions in a Space under `chiefUid`. Returns `(adopted, failed)`.
    func adoptAll(api: APIClient, chiefUid: String, sessions: [SessionRow]) async -> (adopted: Int, failed: Int) {
        guard adoptingChiefUid == nil else { return (0, 0) }
        adoptingChiefUid = chiefUid
        error = nil
        defer { adoptingChiefUid = nil }
        var adopted = 0
        var failed = 0
        for row in sessions {
            do {
                _ = try await api.setSupervision(
                    row.uid,
                    patch: SupervisionPatch(role: .set(.worker), managedBy: .set(chiefUid), muteAlerts: .set(true))
                )
                adopted += 1
            } catch {
                failed += 1
                self.error = APIError.wrap(error).message
            }
        }
        return (adopted, failed)
    }

    /// Promote a Space note into durable Space Knowledge (`POST /api/spaces/:name/knowledge/promote`).
    func promoteNote(
        api: APIClient,
        space: String,
        title: String,
        markdown: String,
        noteId: String? = nil
    ) async -> String? {
        guard promotingNoteId == nil else { return nil }
        promotingNoteId = noteId ?? title
        error = nil
        defer { promotingNoteId = nil }
        do {
            let res = try await api.promoteSpaceKnowledge(
                space,
                PromoteSpaceKnowledgeRequest(
                    title: title,
                    markdown: markdown,
                    source: noteId.map { "note:\($0)" }
                )
            )
            return res.file.name
        } catch {
            self.error = APIError.wrap(error).message
            return nil
        }
    }

    /// Ensure `<basePath>/<name>` exists (ignoring already-exists) and return its path.
    func ensureSubfolder(api: APIClient, basePath: String, name: String) async -> String {
        let base = basePath.hasSuffix("/") ? String(basePath.dropLast()) : basePath
        let target = "\(base)/\(name)"
        _ = try? await api.mkdir(target)
        return target
    }
}
