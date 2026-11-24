import Foundation
import Observation

/// Each host's Spaces (feature `spaces` 1, docs/spec/17-spaces.md), read again when its state
/// says the list changed (`spaces.revision`). The Inbox's menu shows plain Spaces from here,
/// empty ones too; the rest of a host's Spaces already come from its sessions and History.
/// A host without the feature has no list.
@MainActor
@Observable
final class SpacesStore {
    private(set) var lists: [String: SpacesListDTO] = [:]
    @ObservationIgnored private var seen: [String: Int] = [:]
    @ObservationIgnored private var loads: [String: Task<Void, Never>] = [:]

    /// A host's state arrived: read its list again if the host says it changed.
    func observe(host: String, state: HubStateDTO?, client: APIClient) {
        guard let state, state.supports("spaces") else {
            if lists[host] != nil { lists[host] = nil }
            seen[host] = nil
            return
        }
        let revision = state.spaces?.revision ?? 0
        guard seen[host] != revision else { return }
        seen[host] = revision
        reload(host: host, client: client)
    }

    /// Hosts no longer reachable: their lists go with them.
    func keep(hosts: Set<String>) {
        for host in lists.keys where !hosts.contains(host) { lists[host] = nil }
        for host in seen.keys where !hosts.contains(host) { seen[host] = nil }
    }

    func reload(host: String, client: APIClient) {
        loads[host]?.cancel()
        loads[host] = Task { [weak self] in
            guard let list = try? await client.spaces(), !Task.isCancelled else { return }
            self?.lists[host] = list
        }
    }

    /// The plain Spaces, as the Inbox's menu places them.
    var plain: [InboxProject] {
        lists.flatMap { host, list in list.spaces.filter { $0.kind == .space }.map { InboxProject(host: host, name: $0.name) } }
    }

    func space(_ project: InboxProject) -> SpaceDTO? {
        lists[project.host]?.spaces.first { $0.name == project.name }
    }

    func list(host: String) -> SpacesListDTO? { lists[host] }

    /// A Space as its host just answered (attaching projects moves one from another Space, so
    /// the list is read again too).
    func update(host: String, space: SpaceDTO, client: APIClient) {
        if let i = lists[host]?.spaces.firstIndex(where: { $0.name == space.name }) { lists[host]?.spaces[i] = space }
        reload(host: host, client: client)
    }
}

/// Attaching and detaching a Space's projects (`spaces` 3, SPC-8), from Space settings and
/// the Space Portal: the whole list goes to the host each time.
@MainActor
@Observable
final class SpaceProjectsModel {
    let api: APIClient
    let name: String
    private(set) var busy = false
    private(set) var error: String?

    init(api: APIClient, name: String) {
        self.api = api
        self.name = name
    }

    /// The Space with `projects` attached, as the host has it now; nil when it refused (`error` says why).
    func save(_ projects: [String]) async -> SpaceDTO? {
        busy = true
        defer { busy = false }
        do {
            let saved = try await settled { [api, name] in try await api.setSpaceProjects(name, projects: projects) }
            error = nil
            return saved
        } catch {
            self.error = APIError.wrap(error).message
            return nil
        }
    }
}

/// What Remove does, said before it does it (SPC-5), as the web says it (`web/spaces.ts`).
enum SpaceWording {
    static func removal(kind: SpaceKind, conversations: Int, path: String?) -> String {
        let what = conversations == 1 ? "its conversation" : conversations > 0 ? "its \(conversations) conversations" : "it"
        let files: String
        switch kind {
        case .space: files = "Its folder moves to the Spaces archive, with its preferences and memory."
        case .repo: files = "The repository\(path.map { " (\($0))" } ?? "") isn't touched."
        case .folder: files = "The folder\(path.map { " (\($0))" } ?? "") isn't touched."
        }
        return "Takes \(what) out of the Inbox and History. \(files) Nothing is deleted: Restore it from Settings → Spaces, or start a session in it again."
    }

    static func counts(_ space: SpaceDTO) -> String {
        let running = space.live == 1 ? "1 session running" : "\(space.live) sessions running"
        let talks = space.conversations == 1 ? "1 conversation" : "\(space.conversations) conversations"
        return "\(running) · \(talks)"
    }

    /// A memory file's name from what was typed: letters, digits, ".", "_", "-", ending in .md.
    static func memoryFile(_ typed: String) -> String? {
        var name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.lowercased().hasSuffix(".md") { name = String(name.dropLast(3)) }
        name = name.replacingOccurrences(of: " ", with: "-")
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        guard !name.isEmpty, name.count <= 77, !name.hasPrefix("."), !name.contains(".."), name.unicodeScalars.allSatisfy({ allowed.contains($0) && $0.isASCII }) else { return nil }
        return name + ".md"
    }
}

/// One Space's settings (SPC-6): its preferences and memory when it's a plain Space, and
/// Remove. On the Space's own host.
@MainActor
@Observable
final class SpaceSettingsModel {
    let api: APIClient
    let name: String
    let kind: SpaceKind
    /// Host supports Space-owned context for every Space kind (`spaces` 2).
    let supportsSpaceContext: Bool
    /// What's in the editor, and what the host has.
    var preferences: String = ""
    private(set) var savedPreferences: String?
    private(set) var preferencesUpdatedAt: Int?
    private(set) var memory: [SpaceMemoryFileDTO]?
    private(set) var error: String?
    private(set) var busy = false
    private(set) var justSaved = false

    init(api: APIClient, name: String, kind: SpaceKind, supportsSpaceContext: Bool = false) {
        self.api = api
        self.name = name
        self.kind = kind
        self.supportsSpaceContext = supportsSpaceContext
    }

    var plain: Bool { kind == .space }
    var hasContext: Bool { plain || supportsSpaceContext }
    var preferencesChanged: Bool { savedPreferences.map { $0 != preferences } ?? false }

    func load() async {
        guard hasContext else { return }
        do {
            let (prefs, mem) = try await settled { [api, name] in
                async let p = api.spacePreferences(name)
                async let m = api.spaceMemory(name)
                return try await (p, m)
            }
            if savedPreferences == nil || !preferencesChanged { preferences = prefs.text }
            savedPreferences = prefs.text
            preferencesUpdatedAt = prefs.updatedAt > 0 ? prefs.updatedAt : nil
            memory = mem.files
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    func savePreferences() async {
        busy = true
        defer { busy = false }
        do {
            let text = preferences
            let expected = preferencesUpdatedAt
            let saved = try await settled { [api, name] in try await api.putSpacePreferences(name, text: text, expectedUpdatedAt: expected) }
            savedPreferences = saved.text
            preferencesUpdatedAt = saved.updatedAt > 0 ? saved.updatedAt : nil
            error = nil
            justSaved = true
            try? await Task.sleep(for: .seconds(1.6))
            justSaved = false
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func saveMemory(_ file: String, text: String) async -> Bool {
        do {
            let existingAt = memory?.first(where: { $0.name == file })?.updatedAt
            let expected = (existingAt ?? 0) > 0 ? existingAt : nil
            let saved = try await settled { [api, name] in try await api.putSpaceMemory(name, file: file, text: text, expectedUpdatedAt: expected) }
            if let i = memory?.firstIndex(where: { $0.name == file }) { memory?[i] = saved } else { memory = (memory ?? []) + [saved] }
            error = nil
            return true
        } catch {
            self.error = APIError.wrap(error).message
            return false
        }
    }

    /// A new memory file from a typed name; nil when the name can't be one.
    func addMemory(_ typed: String) async -> String? {
        guard let file = SpaceWording.memoryFile(typed) else {
            error = "A memory file is named with letters, digits, “.”, “_” or “-”."
            return nil
        }
        if file.caseInsensitiveCompare("MEMORY.md") == .orderedSame {
            error = "MEMORY.md is the memory index: edit it above instead of adding a file named MEMORY."
            return nil
        }
        let title = String(file.dropLast(3))
        return await saveMemory(file, text: "# \(title)\n") ? file : nil
    }

    func deleteMemory(_ file: String) async {
        do {
            try await api.deleteSpaceMemory(name, file: file)
            memory?.removeAll { $0.name == file }
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func remove() async -> Bool {
        busy = true
        defer { busy = false }
        do {
            _ = try await settled { [api, name] in try await api.removeSpace(name) }
            return true
        } catch {
            self.error = APIError.wrap(error).message
            return false
        }
    }
}

/// Settings → Spaces (`web/SpacesSettings.tsx`): the Spaces folder, the plain Spaces, and
/// the removed ones to restore. On the account's hub.
@MainActor
@Observable
final class SpacesSettings {
    let api: APIClient
    private(set) var list: SpacesListDTO?
    private(set) var restoring: Set<String> = []
    private(set) var error: String?

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            list = try await settled { [api] in try await api.spaces() }
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    func restore(_ name: String) async {
        restoring.insert(name)
        defer { restoring.remove(name) }
        do {
            _ = try await settled { [api] in try await api.restoreSpace(name) }
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    var plain: [SpaceDTO] { list?.spaces.filter { $0.kind == .space } ?? [] }
}
