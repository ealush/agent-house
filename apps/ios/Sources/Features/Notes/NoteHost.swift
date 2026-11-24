import SwiftUI
import UIKit

/// A note on a phone: pushed as a session is, its title and where it's saved in the bar, Done
/// and its menu the bar's buttons. It's saved as it's typed; Done, the subtitle and a word on
/// the way out say so (Back looked like leaving without saving).
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

    /// Saves what's typed now and goes back: what Back does, said as Done.
    private lazy var doneItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
        self?.scene.notes.flush()
        self?.scene.closeSession()
    })
    /// When it was last changed as it opened: leaving it changed says where it's kept.
    private var openedAt: Double?

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
        doneItem.accessibilityIdentifier = "note-done"
        navigationItem.rightBarButtonItems = [doneItem, menuItem, previewItem]
        hidesBottomBarWhenPushed = true
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        openedAt = summary?.updatedAt
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Gone back (not covered by a sheet or another page), with something typed.
        guard isMovingFromParent || navigationController?.isBeingDismissed == true else { return }
        scene.notes.flush()
        if let summary, let openedAt, summary.updatedAt != openedAt, scene.notes.note(summary.id)?.markdown.isEmpty == false {
            scene.toast(NoteScreen.savedWords(summary))
        }
    }

    private var summary: NotesModel.Summary? {
        NoteKey.id(scene.notes.current(key)).flatMap { scene.notes.summary($0) }
    }

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
        let went = scene.noteWentTo(summary.wentTo).map { " · In \($0.title)" } ?? ""
        // Saved, first; how it syncs only when that's news (not synced, changed elsewhere).
        let sync = summary.sync == .synced ? nil : NoteScreen.syncWords(summary, scene: scene)
        let place = [NoteScreen.savedWords(summary), sync].compactMap { $0 }.joined(separator: " · ") + went
        if navigationItem.subtitle != place { navigationItem.subtitle = place }
        doneItem.accessibilityLabel = "Done, \(NoteScreen.savedWords(summary))"
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
