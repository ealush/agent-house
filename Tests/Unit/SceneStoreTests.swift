import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func sceneJournalSurvivesReopeningAndKeepsWindowsIndependent() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let first = SceneSnapshot(sceneID: "window-a", hostOrigin: "https://one.example.ts.net")
    let second = SceneSnapshot(sceneID: "window-b", hostOrigin: "https://two.example.ts.net")
    let store = SceneStore(directory: root)
    try await store.save(first)
    try await store.save(second)
    let reopened = SceneStore(directory: root)
    #expect(try await reopened.load(sceneID: "window-a") == first)
    #expect(try await reopened.load(sceneID: "window-b") == second)
    try await reopened.remove(sceneID: "window-a")
    #expect(try await reopened.load(sceneID: "window-a") == nil)
    #expect(try await reopened.load(sceneID: "window-b") == second)
}

@Test func rejectsFutureSnapshotVersionsWithoutErasingData() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = SceneStore(directory: root)
    let original = SceneSnapshot(sceneID: "a", hostOrigin: "https://one.example.ts.net")
    try await store.save(original)
    let payload = Data(#"{"version":999,"sceneID":"a","hostOrigin":null}"#.utf8)
    let snapshot = try JSONDecoder().decode(SceneSnapshot.self, from: payload)
    await #expect(throws: SceneStore.StoreError.self) {
        try await store.save(snapshot)
    }
    #expect(try await store.load(sceneID: "a") == original)
}

