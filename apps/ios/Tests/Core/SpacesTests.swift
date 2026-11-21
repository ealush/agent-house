import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Spaces (docs/spec/17-spaces.md): what the app reads from a host, the Inbox's menu with
// empty plain Spaces in it, and what Remove says before it does it.

@Test func aSpacesListReadsWhatAnOlderOrNewerHostSends() throws {
    let json = #"{"root":"~/spaces","spaces":[{"name":"Trips","kind":"space","path":"~/spaces/Trips","exists":true,"live":0,"conversations":2,"lastActivityAt":5},{"name":"ah","kind":"workspace"},{"name":"Home","kind":"folder","path":null}],"removed":[{"name":"old","kind":"repo","path":"~/code/old","removedAt":9,"conversations":3,"archived":false}]}"#
    let list = try JSONDecoder().decode(SpacesListDTO.self, from: Data(json.utf8))
    #expect(list.spaces.map(\.kind) == [.space, .folder, .folder], "a kind this build doesn't know reads as a folder")
    #expect(list.spaces[1].exists && list.spaces[1].conversations == 0, "fields a host leaves out have their defaults")
    #expect(list.spaces[2].path == nil)
    #expect(list.removed.first?.conversations == 3)
    let state = try JSONDecoder().decode(HubStateDTO.self, from: Data(#"{"api":28,"hostname":"mac","windows":[],"features":{"spaces":1},"spaces":{"revision":4}}"#.utf8))
    #expect(state.spaces?.revision == 4)
}

@Test func theInboxMenuListsAnEmptyPlainSpaceOnceAmongTheRest() {
    let trips = InboxProject(host: "mac", name: "Trips")
    let books = InboxProject(host: "mac", name: "books")
    let choices = InboxProject.choices([], [], plain: [trips, books, trips])
    #expect(choices == [books, trips])
}

@Test func removeSaysWhatItDoesToTheFilesBeforeItDoesIt() {
    #expect(SpaceWording.removal(kind: .space, conversations: 3, path: "~/spaces/Trips").hasPrefix("Takes its 3 conversations out of the Inbox and History. Its folder moves to the Spaces archive"))
    #expect(SpaceWording.removal(kind: .repo, conversations: 1, path: "~/code/ah").contains("The repository (~/code/ah) isn't touched."))
    #expect(SpaceWording.removal(kind: .folder, conversations: 0, path: nil).hasPrefix("Takes it out of the Inbox and History. The folder isn't touched. Nothing is deleted"))
}

@Test func aMemoryFileIsNamedAsTheHostTakesIt() {
    #expect(SpaceWording.memoryFile("decisions") == "decisions.md")
    #expect(SpaceWording.memoryFile("Open questions.md") == "Open-questions.md")
    for bad in ["", "  ", ".hidden", "../x", "a/b", "naïve", String(repeating: "x", count: 78)] { #expect(SpaceWording.memoryFile(bad) == nil, "\(bad)") }
}
