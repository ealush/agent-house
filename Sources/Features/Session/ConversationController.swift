import SwiftUI
import UIKit

// The conversation under a session's header: the transcript, and the composer's dock standing on
// the keyboard. This is the one place that knows where the keyboard is.
//
// Who owns what (docs/native/CONVERSATION-LAYOUT.md):
// - UIKit owns the keyboard. The dock's bottom edge is `view.keyboardLayoutGuide.top`, which tracks
//   the keyboard's animations, a drag that puts it away, the hardware keyboard's bar, a floating or
//   split keyboard (treated as no keyboard), Split View and Stage Manager (only the part over the
//   window counts). With no keyboard, the guide is the bottom of the safe area.
// - SwiftUI never sees the keyboard. Every hosting controller here leaves the keyboard out of its
//   safe area (`safeAreaRegions`), and so does the one the session screen is in, so nothing is
//   moved for it twice.
// - The transcript fills the whole view, under the bars and the dock. This controller sets its
//   insets from where the dock is, in the same layout pass that moved the dock: inside the
//   keyboard's own animation, when that's what moved it.
// - The dock is as tall as its content (the queue, the attachments, the box) at the dock's width,
//   which SwiftUI reports. It never reaches up past the top of the conversation; the queue keeps
//   to a share of the room (`ConversationRoom`), so it never has to.

/// What the conversation's SwiftUI shows from the controller around it: the room it has, and the
/// screen's theme and files (a hosting controller in UIKit doesn't inherit SwiftUI's environment).
@MainActor @Observable
final class ConversationRoom {
    /// From the top of the conversation (under the bars) down to the keyboard, or to the bottom of
    /// the safe area: what the transcript and the dock share. Set only from the keyboard's guide
    /// and the safe area, never from the dock's size, so the queue sized from it can't feed back.
    var available: CGFloat = 0
    var theme = Theme.system
    /// The session screen's pane has the keys (iPad), or it's a phone's: toasts sit above its box.
    var paneFocused = true
    var narrow = true
    @ObservationIgnored var files: HostFiles?
}

/// The conversation as SwiftUI places it in the session screen. It reaches under the bars on every
/// side; the controller keeps the transcript's rows and the dock clear of them.
struct ConversationSurface: UIViewControllerRepresentable {
    let session: SessionModel
    let scene: SceneModel
    var paneFocused = true
    var narrow = true
    /// Opens a host path (a link to a file in the conversation) in Quick Look.
    let open: @MainActor (String) -> Void
    @Environment(\.theme) private var theme

    func makeUIViewController(context: Context) -> ConversationController {
        ConversationController(session: session, scene: scene, open: open)
    }

    func updateUIViewController(_ controller: ConversationController, context: Context) {
        let room = controller.room
        if room.theme != theme { room.theme = theme }
        if room.paneFocused != paneFocused { room.paneFocused = paneFocused }
        if room.narrow != narrow { room.narrow = narrow }
        controller.open = open
    }
}

@MainActor
final class ConversationController: UIViewController {
    let session: SessionModel
    let scene: SceneModel
    let room = ConversationRoom()
    /// The transcript's controller and what its SwiftUI shows about its scroll.
    let scroll = TranscriptScroll()
    var open: @MainActor (String) -> Void

    private var transcript: UIHostingController<Rooted<TranscriptCollection>>!
    private var dock: UIHostingController<Rooted<ComposerDock>>!
    private var float: UIHostingController<Rooted<ComposerFloatRoot>>!
    private var dockHeight: NSLayoutConstraint!
    private var floatHeight: NSLayoutConstraint!
    private var availableWritten: CGFloat = -1
    /// How tall the dock's content is, as SwiftUI last measured it. The dock's frame catches up
    /// once SwiftUI has moved what's in it (`dockMeasured`); the transcript goes by this.
    private var dockContent: CGFloat = 0
    private var dockCatchUp: DispatchWorkItem?
    /// The dock's content just changed height: the next layout moves the transcript's end in a spring.
    private var insetsFollow = false
    #if DEBUG
    private var probe: LayoutProbe?
    #endif

    init(session: SessionModel, scene: SceneModel, open: @escaping @MainActor (String) -> Void) {
        self.session = session
        self.scene = scene
        self.open = open
        super.init(nibName: nil, bundle: nil)
        room.files = HostFiles(
            load: { [hub = session.hub, key = session.key] path in try? await hub.client(forKey: key).file(path) },
            open: { [weak self] path in self?.open(path) })
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        transcript = embed(TranscriptCollection(session: session, scene: scene, scroll: scroll))
        // The transcript's own SwiftUI (the ↓, the rail, the empty states) keeps to the safe area,
        // which this controller extends down to the dock's top; the keyboard isn't part of it.
        transcript.safeAreaRegions = .container

        dock = embed(ComposerDock(session: session, scene: scene, room: room) { [weak self] height in self?.dockMeasured(height) })
        // Placed by the constraints below: no safe area of its own (it would pad the box again).
        dock.safeAreaRegions = []
        float = embed(ComposerFloatRoot(session: session, scene: scene) { [weak self] height in self?.floatMeasured(height) })
        float.safeAreaRegions = []

        let guide = view.keyboardLayoutGuide
        // With no keyboard, the guide's top is the bottom of the safe area: the dock stands on it.
        guide.usesBottomSafeArea = true
        dockHeight = dock.view.heightAnchor.constraint(equalToConstant: 0)
        floatHeight = float.view.heightAnchor.constraint(equalToConstant: 0)
        // Short of room (a phone on its side, the keyboard up), the dock may be squeezed rather than
        // reach under the top bar: its content is laid out at its own height regardless.
        dockHeight.priority = .defaultHigh
        NSLayoutConstraint.activate([
            transcript.view.topAnchor.constraint(equalTo: view.topAnchor),
            transcript.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            transcript.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            transcript.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            dock.view.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            dock.view.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            dock.view.bottomAnchor.constraint(equalTo: guide.topAnchor),
            dock.view.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor),
            dockHeight,

            float.view.leadingAnchor.constraint(equalTo: dock.view.leadingAnchor),
            float.view.trailingAnchor.constraint(equalTo: dock.view.trailingAnchor),
            float.view.bottomAnchor.constraint(equalTo: dock.view.topAnchor),
            floatHeight,
        ])
        #if DEBUG
        if LayoutProbe.enabled { probe = LayoutProbe(in: view) }
        #endif
    }

    /// Adds a SwiftUI child, its background clear, with the screen's theme and files.
    private func embed<Content: View>(_ content: Content) -> UIHostingController<Rooted<Content>> {
        let host = UIHostingController(rootView: Rooted(room: room, content: content))
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addChild(host)
        view.addSubview(host.view)
        host.didMove(toParent: self)
        return host
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The transcript runs under the dock: its last row ends at the dock's top. Set here, in the
        // pass that moved the dock, so it moves in the same animation (the keyboard's, the dock's).
        // The content's top, which the frame's may lag behind while SwiftUI moves it; never above
        // the top of the room, as the frame isn't.
        let contentTop = max(view.safeAreaLayoutGuide.layoutFrame.minY, dock.view.frame.maxY - dockContent)
        let bottom = max(0, view.bounds.maxY - contentTop)
        let extra = max(0, bottom - view.safeAreaInsets.bottom)
        let follow = { [self] in
            if abs(transcript.additionalSafeAreaInsets.bottom - extra) > 0.5 {
                transcript.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 0, bottom: extra, right: 0)
            }
            scroll.controller?.setInsets(top: view.safeAreaInsets.top, bottom: bottom)
        }
        if insetsFollow {
            insetsFollow = false
            UIView.animate(springDuration: 0.25, bounce: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                follow()
                self.transcript.view.layoutIfNeeded()
            }
        } else {
            follow()
        }
        // Squeezed below its content's height (a room too small even for the box's least): what
        // doesn't fit is cut off at the dock's top, never drawn up over the bars.
        let squeezed = dock.view.bounds.height + 0.5 < dockHeight.constant
        if dock.view.clipsToBounds != squeezed { dock.view.clipsToBounds = squeezed }
        // A drag down the transcript takes the keyboard with it once it reaches the dock.
        let padding = dock.view.frame.maxY - contentTop
        if abs(view.keyboardLayoutGuide.keyboardDismissPadding - padding) > 0.5 { view.keyboardLayoutGuide.keyboardDismissPadding = padding }
        // Compared with what was last written, not read back: UIKit tracks what an Observable is read
        // for in here, and reading this one would lay the view out again each time it's written.
        let available = max(0, view.keyboardLayoutGuide.layoutFrame.minY - view.safeAreaInsets.top)
        if abs(availableWritten - available) > 0.5 {
            availableWritten = available
            room.available = available
        }
        #if DEBUG
        if probe != nil {
            scroll.controller?.placed = { [weak self] in self?.recordProbe() }
            recordProbe()
        }
        #endif
    }

    #if DEBUG
    private func recordProbe() {
        guard let probe else { return }
        probe.record(LayoutProbe.Snapshot(
            session: session.key,
            bounds: view.bounds,
            safeTop: view.safeAreaInsets.top,
            safeBottom: view.safeAreaInsets.bottom,
            keyboard: view.keyboardLayoutGuide.layoutFrame,
            keyboardTopInWindow: view.convert(CGPoint(x: 0, y: view.keyboardLayoutGuide.layoutFrame.minY), to: nil).y.rounded(),
            dockInWindow: dock.view.convert(dock.view.bounds, to: nil),
            dock: dock.view.frame,
            dockMeasured: dockHeight.constant,
            float: float.view.frame,
            floats: session.composer.floats,
            available: availableWritten,
            transcript: scroll.controller?.diagnostics,
            queued: session.queue.items.count), in: view)
    }
    #endif

    override func updateProperties() {
        super.updateProperties()
        // What floats over the transcript takes touches only while it shows something.
        let floats = session.composer.floats
        if let float, float.view.isUserInteractionEnabled != floats { float.view.isUserInteractionEnabled = floats }
    }

    /// The dock's content is this tall at the dock's width. The transcript's end follows at once,
    /// in a spring like the queue's own folding (unless motion is reduced); the dock's frame
    /// takes the height once SwiftUI has moved what's in it.
    ///
    /// SwiftUI animates the dock's content (the queue folding, a row coming) in the dock's own
    /// coordinates, from its top edge. A frame that changed height meanwhile (in UIKit's spring
    /// or at once) moved that edge under the animation: folding the queue, the box jumped up by
    /// what the queue gave back and slid down again, and unfolding it, the rows showed under the
    /// box. Kept as it is until then, the frame holds still and the content, standing on its
    /// bottom edge, grows or folds in place.
    private func dockMeasured(_ height: CGFloat) {
        guard abs(dockContent - height) > 0.5 else { return }
        let animated = view.window != nil && dockContent > 0 && !UIAccessibility.isReduceMotionEnabled
        dockContent = height
        dockCatchUp?.cancel()
        guard animated else {
            dockHeight.constant = height
            return
        }
        insetsFollow = true
        view.setNeedsLayout()
        let catchUp = DispatchWorkItem { [weak self] in
            guard let self else { return }
            dockHeight.constant = dockContent
        }
        dockCatchUp = catchUp
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: catchUp)
    }

    private func floatMeasured(_ height: CGFloat) {
        guard abs(floatHeight.constant - height) > 0.5 else { return }
        floatHeight.constant = height
    }

}

/// A hosted root with what SwiftUI would otherwise have inherited from the session screen.
struct Rooted<Content: View>: View {
    let room: ConversationRoom
    let content: Content

    var body: some View {
        content
            .environment(\.theme, room.theme)
            .environment(\.hostFiles, room.files)
            .tint(room.theme.accent)
            .font(.ah(.body))
    }
}

/// The dock: the queue, what you've attached and the box (`ComposerView`), at its own height,
/// which it reports to the controller that places it.
struct ComposerDock: View {
    let session: SessionModel
    let scene: SceneModel
    let room: ConversationRoom
    let measured: @MainActor (CGFloat) -> Void

    var body: some View {
        ComposerView(session: session, composer: session.composer, scene: scene, room: room)
            .frame(maxWidth: SessionScreen.readableWidth)
            .frame(maxWidth: .infinity)
            // Its own height, whatever the frame: that's what the controller sizes the dock to.
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured($0) }
            // Toasts sit above the box (and the keyboard under it): a phone's, or the focused pane's.
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                guard room.narrow || room.paneFocused else { return }
                scene.composerTop = Double(frame.minY)
                scene.composerMidX = Double(frame.midX)
            }
            .onChange(of: room.paneFocused) { _, focused in
                if !focused && !room.narrow {
                    scene.composerTop = nil
                    scene.composerMidX = nil
                }
            }
            .onDisappear {
                if room.narrow || room.paneFocused {
                    scene.composerTop = nil
                    scene.composerMidX = nil
                }
            }
            // On the dock's bottom edge, as tall as the dock whatever it holds: content taller than
            // the frame for a moment (the queue unfolding before the frame catches up) rises over its
            // top rather than being centred, which put the box below its place.
            .frame(minHeight: 0, maxHeight: .infinity, alignment: .bottom)
    }
}

/// What opens out of the box (`ComposerFloat`), at its own height above the dock.
struct ComposerFloatRoot: View {
    let session: SessionModel
    let scene: SceneModel
    let measured: @MainActor (CGFloat) -> Void

    var body: some View {
        ComposerFloat(session: session, composer: session.composer, scene: scene)
            .frame(maxWidth: SessionScreen.readableWidth)
            .frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured($0) }
            .frame(maxHeight: .infinity, alignment: .bottom)
    }
}
