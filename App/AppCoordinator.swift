import SwiftUI
import UIKit

@MainActor
final class AppCoordinator {
    private let navigation = UINavigationController()
    private let model: HostSetupModel
    private var restorationTask: Task<Void, Never>?

    init(sceneID: String, store: SceneRepository?) {
        model = HostSetupModel(sceneID: sceneID, store: store)
    }

    func start(in window: UIWindow) {
        let controller = UIHostingController(rootView: HostSetupView(model: model))
        controller.title = "Agent Hub"
        controller.navigationItem.largeTitleDisplayMode = .always
        navigation.navigationBar.prefersLargeTitles = true
        navigation.setViewControllers([controller], animated: false)
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        restorationTask = Task { await model.restore() }
    }

    func persist() {
        // Significant edits also save immediately; backgrounding is supplementary.
        Task { await model.persist() }
    }

    func stop() {
        restorationTask?.cancel()
    }
}

