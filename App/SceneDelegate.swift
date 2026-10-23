import SwiftUI
import UIKit

@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var coordinator: AppCoordinator?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene,
              let app = UIApplication.shared.delegate as? AppDelegate else { return }
        let window = UIWindow(windowScene: windowScene)
        let coordinator = AppCoordinator(sceneID: session.persistentIdentifier, store: app.sceneStore)
        self.window = window
        self.coordinator = coordinator
        coordinator.start(in: window)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        coordinator?.persist()
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        coordinator?.stop()
    }

    func stateRestorationActivity(for scene: UIScene) -> NSUserActivity? {
        let activity = NSUserActivity(activityType: "dev.ealush.ah.native.scene")
        // Only a lookup identifier; GRDB is the versioned restoration journal.
        activity.userInfo = ["sceneID": scene.session.persistentIdentifier]
        return activity
    }
}

