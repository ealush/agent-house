import Foundation

/// Which Space a session is in and what a Space is made of, on a host that works it out
/// (`spaces` 3, docs/spec/17-spaces.md SPC-6, SPC-8): projects (repositories and folders, a
/// worktree folded into its repository) attach to a Space, and a session started in an
/// attached project is in that Space unless it's put in another, or in none.
enum SpacePlacement {
    /// The Space `folder`'s project is attached to: the one whose projects hold the folder (the
    /// project itself, or a folder inside it; the deepest project wins); nil when none.
    static func attachedSpace(folder: String, spaces: [SpaceDTO], home: String?) -> String? {
        guard let target = SpacePortalLogic.expandSpacePath(folder, home: home) else { return nil }
        var best: (name: String, depth: Int)?
        for space in spaces {
            for project in space.projects ?? [] {
                guard let root = SpacePortalLogic.expandSpacePath(project, home: home), contains(root, target) else { continue }
                if best.map({ root.count > $0.depth }) ?? true { best = (space.name, root.count) }
            }
        }
        return best?.name
    }

    /// The folder a new session in `space` proposes: `current` when it's already in one of the
    /// Space's projects, else its first project, else the Space's own folder.
    static func proposedFolder(for space: SpaceDTO, current: String?, home: String?) -> String? {
        let projects = space.projects ?? []
        if let current, attachedSpace(folder: current, spaces: [space], home: home) == space.name { return current }
        return projects.first ?? space.path
    }

    /// What New session sends as `space` (SPC-6): nothing when the folder's project puts the
    /// session in the chosen Space anyway; `""` for no Space when the folder's project is
    /// attached to one; else the chosen Space, the session's own choice.
    static func requestSpace(chosen: String?, folderSpace: String?) -> String? {
        let chosen = chosen.flatMap { $0.isEmpty ? nil : $0 }
        if chosen == folderSpace { return nil }
        return chosen ?? ""
    }

    /// The projects a Space can be made of on one host: the project folders of its live sessions
    /// and History (a worktree's folded into its repository; a conversation in a subfolder of a
    /// live project counts as that project), and the projects already attached to its Spaces.
    /// Without the cache's folders and the Spaces folder (`spacesRoot`) itself; each once, by name.
    static func knownProjects(rows: [SessionRow], history: [HistoryRow], spaces: [SpaceDTO] = [], host: String, spacesRoot: String?, home: String?) -> [String] {
        let live = rows.filter { $0.host == host && !$0.dto.projectPath.isEmpty }.map { LaunchState.canonicalProjectPath($0.dto.projectPath) }
        let liveRoots = live.compactMap { SpacePortalLogic.expandSpacePath($0, home: home) }
        let past = history.filter { $0.host == host && !$0.dto.cwd.isEmpty }.map { item -> String in
            let cwd = LaunchState.canonicalProjectPath(item.dto.cwd)
            guard let expanded = SpacePortalLogic.expandSpacePath(cwd, home: home) else { return cwd }
            return liveRoots.filter { contains($0, expanded) }.max { $0.count < $1.count } ?? cwd
        }
        let attached = spaces.flatMap { $0.projects ?? [] }
        let root = SpacePortalLogic.expandSpacePath(spacesRoot, home: home)
        let cache = home.flatMap { SpacePortalLogic.expandSpacePath("~/.cache", home: $0) }
        var seen = Set<String>()
        let kept = (attached + live + past).filter { path in
            guard let expanded = SpacePortalLogic.expandSpacePath(path, home: home) else { return false }
            if expanded.contains("/.cache/") || expanded.hasSuffix("/.cache") { return false }
            if let cache, contains(cache, expanded) { return false }
            if let root, contains(root, expanded) { return false }
            return seen.insert(expanded).inserted
        }
        return kept.sorted {
            let order = name($0).localizedStandardCompare(name($1))
            return order == .orderedSame ? $0 < $1 : order == .orderedAscending
        }
    }

    /// A Space's projects with `path` attached too (once; a trailing `/` is the same folder).
    static func attaching(_ path: String, to projects: [String]) -> [String] {
        let typed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let clean = typed.count > 1 && typed.hasSuffix("/") ? String(typed.dropLast()) : typed
        guard !clean.isEmpty, !projects.contains(clean) else { return projects }
        return projects + [clean]
    }

    /// A Space's projects without `path`.
    static func detaching(_ path: String, from projects: [String]) -> [String] {
        projects.filter { $0 != path }
    }

    /// A project's name, as the menus show it: its folder's last name.
    static func name(_ path: String) -> String {
        let trimmed = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
        let last = (trimmed as NSString).lastPathComponent
        return last.isEmpty ? trimmed : last
    }

    /// A path as people read it: under `home`, from `~`.
    static func short(_ path: String, home: String?) -> String {
        guard let home, !home.isEmpty, home != "/" else { return path }
        let clean = home.hasSuffix("/") ? String(home.dropLast()) : home
        if path == clean { return "~" }
        if path.hasPrefix(clean + "/") { return "~" + path.dropFirst(clean.count) }
        return path
    }

    /// `folder` is `root` or inside it.
    private static func contains(_ root: String, _ folder: String) -> Bool {
        folder == root || folder.hasPrefix(root == "/" ? "/" : root + "/")
    }
}
