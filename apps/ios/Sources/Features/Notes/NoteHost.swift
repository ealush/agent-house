import SwiftUI
import UIKit

/// A note on a phone: pushed as a session is, its title and place in the bar, its menu the
/// bar's one button.
final class NoteHostController: UIHostingController<Themed<NoteScreen>> {
    let key: String
    private unowned let scene: SceneModel
    private lazy var previewItem = UIBarButtonItem(image: UIImage(systemName: "eye"), primaryAction: UIAction { [weak self] _ in self?.scene.perform("note-preview") })
    private lazy var menuItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [
        UIDeferredMenuElement.uncached { [weak self] done in
            guard let self, let id = NoteKey.id(self.scene.notes.current(self.key)) else { return done([]) }
            done(NoteActions.menu(scene: self.scene, id: id))
        },
    ]))

    init(key: String, root: SceneRootController) {
        self.key = key
        scene = root.scene
        super.init(rootView: Themed(app: root.scene.app, theme: root.theme) { NoteScreen(scene: root.scene, key: key, inNavigationBar: true) })
        // The editor stands on the keyboard itself (`AboveKeyboard`): SwiftUI's own room for
        // it as well would lift it twice.
        safeAreaRegions = .container
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal
        menuItem.accessibilityLabel = "Note menu"
        navigationItem.rightBarButtonItems = [menuItem, previewItem]
        hidesBottomBarWhenPushed = true
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    override func updateProperties() {
        super.updateProperties()
        guard let id = NoteKey.id(scene.notes.current(key)), let summary = scene.notes.summary(id) else {
            navigationItem.title = "Note"
            navigationItem.subtitle = nil
            return
        }
        if scene.renamingNote == id {
            scene.renamingNote = nil
            rename(id, current: scene.notes.note(id)?.title ?? "")
        }
        if navigationItem.title != summary.title { navigationItem.title = summary.title }
        let place = NoteScreen.place(summary, scene: scene)
        if navigationItem.subtitle != place { navigationItem.subtitle = place }
        let preview = scene.notes.document(id)?.preview == true
        previewItem.image = UIImage(systemName: preview ? "pencil" : "eye")
        previewItem.accessibilityLabel = preview ? "Edit" : "Preview"
    }

    /// The phone's rename: an alert, as Rename is asked elsewhere in iOS.
    private func rename(_ id: String, current: String) {
        let alert = UIAlertController(title: "Rename Note", message: "Leave it empty to use the first line.", preferredStyle: .alert)
        alert.addTextField { field in
            field.text = current
            field.placeholder = "Title"
            field.clearButtonMode = .whileEditing
            field.autocapitalizationType = .sentences
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Rename", style: .default) { [weak self, weak alert] _ in
            self?.scene.notes.rename(id, to: alert?.textFields?.first?.text ?? "")
        })
        present(alert, animated: true)
    }
}
