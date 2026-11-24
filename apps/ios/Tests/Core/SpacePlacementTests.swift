import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Spaces are only the ones you make (`spaces` 3, docs/spec/17-spaces.md SPC-6, SPC-8): the
// Inbox's menu, what each Space holds, New session's Space beside its folder, and the projects
// a Space can be made of. An older host keeps what it had.

private func live(
    _ uid: String, host: String = "mac", project: String, projectPath: String, space: String? = nil, places: Bool
) throws -> SessionRow {
    var object: [String: Any] = [
        "id": "@\(uid)", "uid": uid, "name": uid, "title": uid, "statusSource": "hook",
        "project": project, "projectPath": projectPath, "status": "idle",
    ]
    if let space { object["space"] = space }
    let dto = try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
    return SessionRow(key: uid, host: host, isLocal: host == "mac", dto: dto, hostPlacesSpaces: places)
}

private func past(_ ref: String, host: String = "mac", project: String, cwd: String, space: String? = nil, places: Bool) throws -> HistoryRow {
    var object: [String: Any] = ["ref": ref, "kind": "ended", "harness": "claude", "title": ref, "cwd": cwd, "project": project, "at": 1]
    if let space { object["space"] = space }
    let dto = try JSONDecoder().decode(HistoryItemDTO.self, from: JSONSerialization.data(withJSONObject: object))
    return HistoryRow(host: host, isLocal: host == "mac", dto: dto, hostPlacesSpaces: places)
}

private func list(_ spaces: [SpaceDTO]) -> SpacesListDTO { SpacesListDTO(root: "~/spaces", spaces: spaces) }

@Test func aSpaces3HostListsOnlyItsSpacesThenNotInASpace() throws {
    let trips = SpaceDTO(name: "Trips", kind: .space, path: "~/spaces/Trips", projects: ["~/code/agent-house"])
    let empty = SpaceDTO(name: "Books", kind: .space, path: "~/spaces/Books")
    let inTrips = try live("a", project: "agent-house", projectPath: "/home/me/code/agent-house", space: "Trips", places: true)
    let loose = try live("b", project: "web", projectPath: "/home/me/code/web", places: true)
    let worktree = try past("h1", project: "claude-17fd", cwd: "~/code/.worktrees/agent-house/claude-17fd", places: true)
    let menu = InboxProject.menu([inTrips, loose], [worktree], lists: ["mac": list([trips, empty])], placing: ["mac"])

    #expect(menu.spaces == [InboxProject(host: "mac", name: "Books"), InboxProject(host: "mac", name: "Trips")], "every Space made there, an empty one too, by name")
    #expect(menu.projects.isEmpty, "a project, a worktree or a folder is never an entry")
    #expect(menu.outside)
    #expect(menu.choices.last == .outside)

    let tripsChoice = InboxProject(host: "mac", name: "Trips")
    #expect(tripsChoice.holds(inTrips) && !tripsChoice.holds(loose))
    #expect(!InboxProject(host: "mac", name: "web").holds(loose), "never by its project")
    #expect(InboxProject.outside.holds(loose) && !InboxProject.outside.holds(inTrips))
    #expect(InboxProject.outside.holds(worktree))
    #expect(loose.spaceName == nil && inTrips.spaceName == "Trips")

    // Everything placed: no "Not in a Space".
    let placed = InboxProject.menu([inTrips], [], lists: ["mac": list([trips])], placing: ["mac"])
    #expect(!placed.outside && placed.choices == [tripsChoice])
}

@Test func anOlderHostKeepsItsSpacesAndProjectsAndNoNotInASpace() throws {
    let trips = SpaceDTO(name: "Trips", kind: .space, path: "~/spaces/Trips")
    let repo = SpaceDTO(name: "web", kind: .repo, path: "~/code/web")
    let loose = try live("b", project: "web", projectPath: "/code/web", places: false)
    let put = try live("c", project: "api", projectPath: "/code/api", space: "Trips", places: false)
    let older = try past("h", project: "infra", cwd: "/code/infra", places: false)
    let menu = InboxProject.menu([loose, put], [older], lists: ["mac": list([trips, repo])], placing: [])

    #expect(menu.spaces == [InboxProject(host: "mac", name: "Trips")])
    #expect(menu.projects == [InboxProject(host: "mac", name: "infra"), InboxProject(host: "mac", name: "web")])
    #expect(!menu.outside, "an older host's session is always in its project")
    #expect(loose.spaceName == "web", "an older host groups by `space`, else the project")
    #expect(InboxProject(host: "mac", name: "web").holds(loose))
    #expect(InboxProject(host: "mac", name: "infra").holds(older))
    #expect(!InboxProject.outside.holds(loose))

    // One of each: the newer host's Spaces only, the older one's projects as before.
    let other = try live("d", host: "box", project: "site", projectPath: "/srv/site", places: true)
    let mixed = InboxProject.menu([loose, other], [], lists: ["mac": list([trips, repo]), "box": list([SpaceDTO(name: "Ops", kind: .space)])], placing: ["box"])
    #expect(mixed.spaces == [InboxProject(host: "box", name: "Ops"), InboxProject(host: "mac", name: "Trips")])
    #expect(mixed.projects == [InboxProject(host: "mac", name: "web")])
    #expect(mixed.outside)
}

@Test func theSidebarsBlocksAreSpacesAndTheRestNotInASpace() throws {
    let a = try live("a", project: "agent-house", projectPath: "/c/agent-house", space: "Trips", places: true)
    let b = try live("b", project: "web", projectPath: "/c/web", places: true)
    let old = try live("c", project: "api", projectPath: "/c/api", places: false)
    let ids = SessionOrdering.sections([a, b, old], multiHost: false).map(\.id)
    #expect(Set(ids) == ["Trips", InboxProject.outsideTitle, "api"])
}

@Test func aHistoryEntryReadsTheSpaceItWasIn() throws {
    let item = try JSONDecoder().decode(HistoryItemDTO.self, from: Data(#"{"ref":"r","kind":"ended","harness":"claude","title":"t","cwd":"/c","project":"c","at":1,"space":"Trips"}"#.utf8))
    #expect(item.space == "Trips")
    let none = try JSONDecoder().decode(HistoryItemDTO.self, from: Data(#"{"ref":"r","kind":"ended","harness":"claude","title":"t","cwd":"/c","project":"c","at":1,"space":""}"#.utf8))
    #expect(none.space == nil)
    let older = try JSONDecoder().decode(SpaceDTO.self, from: Data(#"{"name":"Trips","kind":"space"}"#.utf8))
    #expect(older.projects == nil, "an older host sends no projects")
}

@Test func newSessionsSpaceAndFolderProposeEachOther() {
    let home = "/home/me"
    let trips = SpaceDTO(name: "Trips", kind: .space, path: "~/spaces/Trips", projects: ["~/code/agent-house", "/home/me/code/site"])
    let books = SpaceDTO(name: "Books", kind: .space, path: "~/spaces/Books")
    let spaces = [trips, books]

    // A folder proposes the Space its project is attached to (a worktree's is its repository's).
    #expect(SpacePlacement.attachedSpace(folder: "/home/me/code/agent-house", spaces: spaces, home: home) == "Trips")
    #expect(SpacePlacement.attachedSpace(folder: "~/code/.worktrees/agent-house/claude-17fd", spaces: spaces, home: home) == "Trips")
    #expect(SpacePlacement.attachedSpace(folder: "~/code/site/apps/web", spaces: spaces, home: home) == "Trips")
    #expect(SpacePlacement.attachedSpace(folder: "~/code/agent-house-2", spaces: spaces, home: home) == nil)
    #expect(SpacePlacement.attachedSpace(folder: "~/spaces/Books", spaces: spaces, home: home) == nil, "a Space's own folder isn't a project attached to it")

    // A Space proposes its first project, else its own folder; a folder already in it stays.
    #expect(SpacePlacement.proposedFolder(for: trips, current: "~/code/web", home: home) == "~/code/agent-house")
    #expect(SpacePlacement.proposedFolder(for: trips, current: "/home/me/code/site", home: home) == "/home/me/code/site")
    #expect(SpacePlacement.proposedFolder(for: books, current: "~/code/web", home: home) == "~/spaces/Books")

    // `space` goes only when it differs from the folder's project's; "" for none.
    #expect(SpacePlacement.requestSpace(chosen: "Trips", folderSpace: "Trips") == nil)
    #expect(SpacePlacement.requestSpace(chosen: "Books", folderSpace: "Trips") == "Books")
    #expect(SpacePlacement.requestSpace(chosen: "Books", folderSpace: nil) == "Books")
    #expect(SpacePlacement.requestSpace(chosen: nil, folderSpace: "Trips") == "")
    #expect(SpacePlacement.requestSpace(chosen: nil, folderSpace: nil) == nil)
    #expect(SpacePlacement.requestSpace(chosen: "", folderSpace: nil) == nil)
}

@Test func theProjectsASpaceCanBeMadeOf() throws {
    let home = "/home/me"
    let rows = [
        try live("a", project: "agent-house", projectPath: "/home/me/code/.worktrees/agent-house/claude-17fd", places: true),
        try live("b", project: "agent-house", projectPath: "/home/me/code/agent-house", places: true),
        try live("c", project: "Trips", projectPath: "/home/me/spaces/Trips", space: "Trips", places: true),
        try live("d", project: "uploads", projectPath: "/home/me/.cache/ah/uploads", places: true),
        try live("e", host: "box", project: "elsewhere", projectPath: "/srv/elsewhere", places: true),
    ]
    let history = [
        try past("h1", project: "agent-house", cwd: "/home/me/code/agent-house/apps/server", places: true),
        try past("h2", project: "notes", cwd: "~/notes", places: true),
    ]
    let spaces = [SpaceDTO(name: "Ops", kind: .space, path: "~/spaces/Ops", projects: ["~/code/infra"])]
    let known = SpacePlacement.knownProjects(rows: rows, history: history, spaces: spaces, host: "mac", spacesRoot: "~/spaces", home: home)
    #expect(known == ["/home/me/code/agent-house", "~/code/infra", "~/notes"], "worktrees folded, each once, no cache or Spaces folder, this host only")

    #expect(SpacePlacement.attaching("~/code/web/", to: ["~/code/infra"]) == ["~/code/infra", "~/code/web"])
    #expect(SpacePlacement.attaching("~/code/infra", to: ["~/code/infra"]) == ["~/code/infra"])
    #expect(SpacePlacement.attaching("  ", to: []) == [])
    #expect(SpacePlacement.detaching("~/code/infra", from: ["~/code/infra", "~/code/web"]) == ["~/code/web"])
    #expect(SpacePlacement.short("/home/me/code/web", home: home) == "~/code/web")
    #expect(SpacePlacement.name("~/code/web/") == "web")
}

@MainActor
@Test func aSpacesNotesAreTheOnesFiledInItOrItsProjects() {
    func note(_ path: String?, host: String = "mac") -> NotesModel.Summary {
        NotesModel.Summary(id: path ?? "none", title: "t", project: path.map { NoteProject(origin: nil, host: host, path: $0) }, sync: .synced, syncOrigin: nil, createdAt: 0, updatedAt: 0)
    }
    let trips = InboxProject(host: "mac", name: "Trips")
    let projects = ["~/code/agent-house"]
    #expect(trips.holds(note("/home/me/spaces/Trips"), projects: projects, home: "/home/me"))
    #expect(trips.holds(note("/home/me/code/agent-house"), projects: projects, home: "/home/me"))
    #expect(!trips.holds(note("/home/me/code/web"), projects: projects, home: "/home/me"))
    #expect(!trips.holds(note("/home/me/code/agent-house", host: "box"), projects: projects, home: "/home/me"))
    #expect(InboxProject.outside.holds(note(nil)) && !InboxProject.outside.holds(note("/x")))
}
