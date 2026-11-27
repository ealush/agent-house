import SwiftUI
import UIKit

/// A phone's Search tab: what's found (`SearchPage`) and, at its foot, the search field standing
/// on the keyboard. The tab bar's Search button opens it: the field over the tab bar, ✕ beside
/// it, and the keyboard and the field rise together. The tab bar stays where it is, Search
/// chosen in it, under the keyboard while it's up. Hidden and shown again around the search, its
/// glass sometimes never reported the change finished, and UI tests waited a minute at every
/// step after.
///
/// The field is ah's own, not iOS's search tab's: that one followed the keyboard a few frames
/// behind, so the keyboard ran over it on its way up and it showed from under it after. This one's
/// bottom is the keyboard's layout guide, moved inside the keyboard's own animation, as a
/// session's box is (`ConversationController`).
///
/// What's typed is the scene's query (`SceneModel.search`), which the page searches.
@MainActor
final class SearchTabController: UIViewController, UITextFieldDelegate {
    /// The tab Search was opened from: ✕ goes back to it.
    struct Origin {
        let title: String
        let route: SceneSnapshot.Route
    }

    private unowned let scene: SceneModel
    private let page: UIHostingController<Themed<SearchPage>>
    private let field: UISearchTextField
    private let fieldGlass = UIVisualEffectView(effect: UIGlassEffect())
    /// The search put away, back on the tab it was opened from.
    private let close = UIButton(configuration: .glass())
    private let row = UIStackView()
    private let edge = UIScrollEdgeElementContainerInteraction()
    /// The last ⌘F (or the session menu's Search) that raised the keyboard.
    private var raisedFor: Int?
    /// Raise the keyboard the next time the page shows: Search was tapped in the tab bar.
    var raiseOnAppear = false
    var origin = Origin(title: "Inbox", route: .inbox) { didSet { showOrigin() } }
    /// Back to the tab it was opened from (✕).
    var leave: () -> Void = {}

    init(root: SceneRootController) {
        scene = root.scene
        let field = UISearchTextField()
        self.field = field
        page = root.host(SearchPage(scene: root.scene) { [weak field] in
            if field?.isFirstResponder == true { field?.resignFirstResponder() }
        })
        super.init(nibName: nil, bundle: nil)
        title = "Search"
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The page fills the view, under the field; the keyboard is this controller's to place
        // (the field stands on it), so SwiftUI leaves it out of the page's safe area.
        addChild(page)
        page.safeAreaRegions = .container
        page.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(page.view)
        page.didMove(toParent: self)

        field.borderStyle = .none
        field.backgroundColor = .clear
        field.font = AhType.uiFont(.body)
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.returnKeyType = .search
        field.enablesReturnKeyAutomatically = true
        field.clearButtonMode = .whileEditing
        field.accessibilityIdentifier = "inbox-search"
        field.delegate = self
        field.addTarget(self, action: #selector(typed), for: .editingChanged)
        field.translatesAutoresizingMaskIntoConstraints = false
        fieldGlass.cornerConfiguration = .capsule()
        fieldGlass.contentView.addSubview(field)

        close.configuration?.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(weight: .medium))
        close.configuration?.cornerStyle = .capsule
        close.accessibilityLabel = "Close"
        close.addAction(UIAction { [weak self] _ in self?.leave() }, for: .primaryActionTriggered)
        showOrigin()

        row.axis = .horizontal
        row.spacing = 10
        row.alignment = .center
        for part in [fieldGlass, close] as [UIView] { row.addArrangedSubview(part) }
        row.translatesAutoresizingMaskIntoConstraints = false
        row.addInteraction(edge)
        edge.edge = .bottom
        view.addSubview(row)

        let guide = view.keyboardLayoutGuide
        // With no keyboard, the guide's top is the bottom of the safe area, the tab bar's top:
        // the field stands on it.
        guide.usesBottomSafeArea = true
        let height: CGFloat = 48
        NSLayoutConstraint.activate([
            page.view.topAnchor.constraint(equalTo: view.topAnchor),
            page.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            page.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            page.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            row.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            row.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            row.bottomAnchor.constraint(equalTo: guide.topAnchor, constant: -8),
            fieldGlass.heightAnchor.constraint(equalToConstant: height),
            close.widthAnchor.constraint(equalToConstant: height),
            close.heightAnchor.constraint(equalToConstant: height),

            field.leadingAnchor.constraint(equalTo: fieldGlass.contentView.leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: fieldGlass.contentView.trailingAnchor, constant: -10),
            field.topAnchor.constraint(equalTo: fieldGlass.contentView.topAnchor),
            field.bottomAnchor.constraint(equalTo: fieldGlass.contentView.bottomAnchor),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The page's foot clears the field (and the keyboard under it): its last results scroll
        // up past them. Set in the same pass that moved the field, inside the keyboard's animation.
        let covered = max(0, view.bounds.maxY - row.frame.minY + 8 - view.safeAreaInsets.bottom)
        if abs(page.additionalSafeAreaInsets.bottom - covered) > 0.5 { page.additionalSafeAreaInsets.bottom = covered }
        if edge.scrollView == nil, let list = Self.firstScrollView(in: page.view) { edge.scrollView = list }
    }

    /// The query set elsewhere (a window put away mid-search, "See all results for …"): the
    /// field says it too. Empty, it says what it looks in: the Inbox's Space, when one is
    /// chosen (the page says so under its title too, which scrolls away).
    override func updateProperties() {
        super.updateProperties()
        let q = scene.search?.q ?? ""
        if field.text != q { field.text = q }
        let placeholder = scene.shownInboxProject.map { $0.isOutside ? "Search outside Spaces" : "Search \($0.title)" } ?? "Sessions, history, what was said"
        if field.placeholder != placeholder { field.placeholder = placeholder }
        focusIfAsked()
    }

    /// Tapped in the tab bar: the keyboard rises as the page shows, in the same pass, so the
    /// field goes up with it from over the tab bar (Back from a session found leaves it down).
    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        if raiseOnAppear {
            raiseOnAppear = false
            field.becomeFirstResponder()
        }
        focusIfAsked()
    }

    /// Asked for by name on its way here: the field takes the keyboard, as a tap on the tab gives it.
    private func focusIfAsked() {
        guard let request = scene.focusRequest, request.target == .search, request.nonce != raisedFor,
              request.isFresh(forBoxMadeAt: Date()), isViewLoaded, view.window != nil else { return }
        raisedFor = request.nonce
        field.becomeFirstResponder()
    }

    @objc private func typed() {
        let text = field.text ?? ""
        var query = scene.search ?? SearchQuery(q: "")
        guard query.q != text else { return }
        query.q = text
        scene.search = query
    }

    /// Search (return): the keyboard down, the results under it.
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    private func showOrigin() {
        close.accessibilityHint = "Back to \(origin.title)"
    }

    /// The first vertical scroller under a view, breadth first: the page's list.
    private static func firstScrollView(in view: UIView) -> UIScrollView? {
        var queue = [view]
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let scroll = next as? UIScrollView { return scroll }
            queue.append(contentsOf: next.subviews)
        }
        return nil
    }
}
