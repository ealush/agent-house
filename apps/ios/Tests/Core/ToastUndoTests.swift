import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@MainActor
private func makeTestScene(_ id: String) throws -> SceneModel {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()),
        keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(),
        device: DeviceDescriptor(name: "iPhone", client: DeviceDescriptor.newClientID()),
        allowLoopback: true
    )
    return SceneModel(sceneID: id, app: AppModel(services: services))
}

@MainActor
@Test func toastUndoFiresAtMostOnceAndClearsOnDismiss() throws {
    let scene = try makeTestScene("undo-test")
    var runs = 0

    scene.toast("Pinned “Test”", undo: { runs += 1 })
    let firstID = scene.toasts.last?.id
    #expect(firstID != nil)
    #expect(scene.toasts.last?.undoTitle == "Undo")
    #expect(scene.toasts.last?.duration == 5)

    // Rapid double-tap on Undo executes the handler exactly once.
    #expect(scene.runToastUndo(firstID!) == true)
    #expect(scene.runToastUndo(firstID!) == false)
    #expect(runs == 1)
    #expect(scene.toasts.isEmpty)

    // Expiry / swipe dismissal discards the undo closure cleanly.
    scene.toast("Dismissed Alert", undo: { runs += 1 })
    let secondID = scene.toasts.last!.id
    scene.dismissToast(secondID)
    #expect(scene.runToastUndo(secondID) == false)
    #expect(runs == 1)
}

@MainActor
@Test func restoreNudgeIgnoresDuplicates() throws {
    let scene = try makeTestScene("nudge-test")
    let nudge = SceneModel.Nudge(id: 1, key: "abc123", title: "Worker", agent: "claude", kind: .needsYou)

    scene.restoreNudge(nudge)
    #expect(scene.nudges.count == 1)
    // Restoring a nudge for the same session key does not duplicate it.
    scene.restoreNudge(nudge)
    #expect(scene.nudges.count == 1)
}
