import SwiftUI
import UIKit

/// Content that stands above the on-screen keyboard: its bottom edge is the keyboard's top, as
/// UIKit's keyboard layout guide has it, or the bottom of the screen when there's none. For what
/// shrinks to make room (a terminal, a side panel, a pane's chooser, an iPad's New session); the conversation does it
/// itself (`ConversationController`), with its transcript running on under the keyboard.
///
/// SwiftUI's own keyboard avoidance is off around the session screens (their hosting controllers
/// leave the keyboard out of the safe area), so this is the only thing that moves them for it:
/// the guide follows the keyboard's animations and a drag that puts it away, counts only the
/// part over the window (Split View, Stage Manager), and treats a floating or split keyboard as
/// none.
struct AboveKeyboard<Content: View>: UIViewControllerRepresentable {
    @ViewBuilder let content: Content
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles

    func makeUIViewController(context: Context) -> AboveKeyboardController<AboveKeyboardRoot<Content>> {
        AboveKeyboardController(root: root)
    }

    func updateUIViewController(_ controller: AboveKeyboardController<AboveKeyboardRoot<Content>>, context: Context) {
        controller.host.rootView = root
    }

    private var root: AboveKeyboardRoot<Content> { AboveKeyboardRoot(theme: theme, files: hostFiles, content: content) }
}

/// The hosted content with what it would have inherited from the screen around it.
struct AboveKeyboardRoot<Content: View>: View {
    let theme: Theme
    let files: HostFiles?
    let content: Content

    var body: some View {
        content
            .environment(\.theme, theme)
            .environment(\.hostFiles, files)
            .tint(theme.accent)
            .font(.ah(.body))
    }
}

final class AboveKeyboardController<Root: View>: UIViewController {
    let host: UIHostingController<Root>

    init(root: Root) {
        host = UIHostingController(rootView: root)
        super.init(nibName: nil, bundle: nil)
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The keyboard is this controller's to place; the content keeps only the bars' safe area.
        host.safeAreaRegions = .container
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addChild(host)
        view.addSubview(host.view)
        host.didMove(toParent: self)
        // With no keyboard the guide's top is the view's bottom (not the safe area's): the content
        // reaches the bottom edge and keeps the home indicator's safe area itself.
        view.keyboardLayoutGuide.usesBottomSafeArea = false
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
    }
}
