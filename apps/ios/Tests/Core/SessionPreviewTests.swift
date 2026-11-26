import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@MainActor
@Test func sessionIfOpenNeverInstantiatesOrOpensAnUnopenedSession() throws {
    let services = AppServices(
        database: try AppDatabase(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)),
        vault: CredentialVault(store: MemorySecretStore()),
        keys: MemoryDeviceKeyStore(),
        transport: URLSessionTransport(),
        device: DeviceDescriptor(name: "iPhone", client: DeviceDescriptor.newClientID()),
        allowLoopback: true
    )
    let scene = SceneModel(sceneID: "preview-no-open", app: AppModel(services: services))
    let beforeRoute = scene.route

    // Querying for preview state must stay read-only and never instantiate a SessionModel or navigate.
    #expect(scene.sessionIfOpen("581f6e1d") == nil)
    #expect(scene.sessionIfOpen("581f6e1d") == nil)
    #expect(scene.route == beforeRoute)
}
