import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    // Shared across windows; navigation models belong to each SceneDelegate.
    let sceneStore = SceneStore()

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Default Configuration",
            sessionRole: connectingSceneSession.role
        )
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    func application(_ application: UIApplication, didDiscardSceneSessions sceneSessions: Set<UISceneSession>) {
        let identifiers = sceneSessions.map(\.persistentIdentifier)
        Task {
            do {
                for identifier in identifiers {
                    try await sceneStore.remove(sceneID: identifier)
                }
            } catch {
                // Cleanup is retried when a future cache-retention policy is added.
                // Do not print scene payloads or host details to logs.
            }
        }
    }
}

