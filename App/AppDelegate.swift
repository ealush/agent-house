import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    // Shared across windows; navigation models belong to each SceneDelegate. Nil when the
    // database can't open, which the setup screen reports.
    let sceneStore: SceneRepository? = (try? AppDatabase()).map { SceneRepository(database: $0) }

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
        do {
            for identifier in identifiers {
                try sceneStore?.remove(sceneID: identifier)
            }
        } catch {
            // Cleanup is retried when a future cache-retention policy is added.
            // Do not print scene payloads or host details to logs.
        }
    }
}

