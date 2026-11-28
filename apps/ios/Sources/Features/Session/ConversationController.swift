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
    /// Live finger-drag offset while the user scrubs the composer settings tray (nil at rest).
    /// Visual-only: never changes dock height or transcript anchoring.
    var trayDragOffset: CGFloat? = nil
    @ObservationIgnored var files: HostFiles?
    /// Arms an experimental visual bubble flight from the composer's global rect into the newly placed outgoing row.
    @ObservationIgnored var launchFlight: ((String, CGRect) -> Void)?
}

/// The conversation as SwiftUI places it in the session screen. It reaches under the bars on every
/// side; the controller keeps the transcript's rows and the dock clear of them.
struct ConversationSurface: UIViewControllerRepresentable {
    let session: SessionModel
    let scene: SceneModel
    var paneFocused = true
    var narrow = true
    /// Opens a message's pictures and videos together in Quick Look, at the one tapped.
    var browse: @MainActor ([String], Int) async -> Void = { _, _ in }
    /// Opens a host path (a link to a file in the conversation, an attachment) in Quick Look.
    let open: @MainActor (String) async -> Void
    @Environment(\.theme) private var theme

    func makeUIViewController(context: Context) -> ConversationController {
        let controller = ConversationController(session: session, scene: scene, open: open)
        controller.browse = browse
        return controller
    }

    func updateUIViewController(_ controller: ConversationController, context: Context) {
        let room = controller.room
        if room.theme != theme { room.theme = theme }
        if room.paneFocused != paneFocused { room.paneFocused = paneFocused }
        if room.narrow != narrow { room.narrow = narrow }
        controller.open = open
        controller.browse = browse
    }
}

@MainActor
final class ConversationController: UIViewController {
    let session: SessionModel
    let scene: SceneModel
    let room = ConversationRoom()
    /// The transcript's controller and what its SwiftUI shows about its scroll.
    let scroll = TranscriptScroll()
    var open: @MainActor (String) async -> Void
    var browse: @MainActor ([String], Int) async -> Void = { _, _ in }

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
    /// Eligible short outgoing message waiting for its transcript cell to be placed.
    private var pendingFlight: (text: String, startFrame: CGRect, at: Date)?
    /// Currently running flight overlay and masked cell, kept so rapid sends or teardown restore visibility immediately.
    private var activeFlight: SendFlight?
    /// Every flight still on screen, its proxy fading out too: each rides with its row to the end.
    private var flights: [SendFlight] = []
    #if DEBUG
    private var probe: LayoutProbe?
    #endif

    init(session: SessionModel, scene: SceneModel, open: @escaping @MainActor (String) async -> Void) {
        self.session = session
        self.scene = scene
        self.open = open
        super.init(nibName: nil, bundle: nil)
        room.files = HostFiles(
            load: { [hub = session.hub, key = session.key] path in try? await hub.client(forKey: key).file(path) },
            open: { [weak self] path in await self?.open(path) },
            browse: { [weak self] sources, index in await self?.browse(sources, index) },
            kept: session.files,
            mentions: session.mentionLookup,
            sessions: { [session] in session.sessionChipLabels() },
            openSession: { [scene, session] uid in scene.open(session.sessionKey(for: uid)) })
        room.launchFlight = { [weak self] text, globalFrame in
            self?.armSendFlight(text: text, fromGlobalFrame: globalFrame)
        }
        scroll.hasArmedFlight = { [weak self] in
            self?.hasFreshPendingFlight ?? false
        }
        scroll.onOutgoingPlaced = { [weak self] cell, cellFrameInCollection, collectionView in
            self?.performSendFlightIfArmed(into: cell, frameInCollection: cellFrameInCollection, collectionView: collectionView)
        }
        scroll.onOutgoingLanded = { [weak self] cell in
            self?.flightLanded(on: cell) ?? false
        }
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
        float = embed(ComposerFloatRoot(session: session, scene: scene, room: room) { [weak self] height in self?.floatMeasured(height) })
        float.safeAreaRegions = []
        // The transcript's soft bottom edge takes the box and what floats over it into account,
        // as it does a toolbar: the conversation fades out under and below them, rather than
        // reading on through the glass and in the strip under the box. The float only while
        // something shows in it (`updateProperties`): folded, the settings keep their height
        // out of sight, and the conversation faded out a row of nothing above the box.
        dockEdge.edge = .bottom
        floatEdge.edge = .bottom
        dock.view.addInteraction(dockEdge)

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

    /// The dock's and the float's parts in the transcript's soft bottom edge.
    private let dockEdge = UIScrollEdgeElementContainerInteraction()
    private let floatEdge = UIScrollEdgeElementContainerInteraction()

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The transcript's scroll view exists once its SwiftUI host has made it.
        if let scrollView = scroll.controller?.scrollView {
            for edge in [dockEdge, floatEdge] where edge.scrollView !== scrollView { edge.scrollView = scrollView }
        }
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
            // The queue's own animation, not a UIKit spring of the same length: in one, the
            // conversation set off a frame or two ahead of the queue and pulled away from it by
            // a line, and the queue caught up after.
            UIView.animate(QueueTrayView.motion) {
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
        // What floats over the transcript takes touches only while it shows something: the
        // settings, suggestions, dictation's card, or while the user is actively dragging the tray.
        let floats = session.composer.floats || room.trayDragOffset != nil || DictationCard.shows(session.dictation)
        guard let float else { return }
        if float.view.isUserInteractionEnabled != floats { float.view.isUserInteractionEnabled = floats }
        // And has the conversation fade out under it only then.
        if floats, floatEdge.view == nil {
            float.view.addInteraction(floatEdge)
        } else if !floats, floatEdge.view != nil {
            float.view.removeInteraction(floatEdge)
        }
    }

    /// The dock's content is this tall at the dock's width. The transcript's end follows at once,
    /// in the queue's own animation (unless motion is reduced); the dock's frame
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

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        finishActiveFlightImmediately()
        pendingFlight = nil
    }

    // MARK: Experimental Spatial Send Flight (Decoupled X/Y Arc)

    private var hasFreshPendingFlight: Bool {
        guard let flight = pendingFlight else { return false }
        return !UIAccessibility.isReduceMotionEnabled && Date().timeIntervalSince(flight.at) < 0.6
    }

    private func armSendFlight(text: String, fromGlobalFrame: CGRect) {
        guard !UIAccessibility.isReduceMotionEnabled, isViewLoaded, view.window != nil else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, fromGlobalFrame.width > 20, fromGlobalFrame.height > 20 else { return }
        let localStart = view.convert(fromGlobalFrame, from: nil)
        pendingFlight = (text: trimmed, startFrame: localStart, at: Date())
    }

    private func finishActiveFlightImmediately() {
        guard let active = activeFlight else { return }
        activeFlight = nil
        active.horiz.stopAnimation(true)
        active.vert.stopAnimation(true)
        active.end()
    }

    /// Where the row's top is on screen right now, mid-animation too: the transcript moves under
    /// the flight (the box folding back to a line once its words are gone, the row measured).
    private func onScreenTop(of cell: UICollectionViewCell) -> CGFloat {
        guard let shown = cell.layer.presentation(), let here = view.layer.presentation() else {
            return view.convert(cell.bounds, from: cell).minY
        }
        return shown.convert(shown.bounds, to: here).minY
    }

    /// The host's copy of a send took its bubble's row, in the same place less the "Sent" under
    /// it: a flight still on its way goes on to it, and one fading out goes at once.
    private func flightLanded(on cell: UICollectionViewCell) -> Bool {
        guard let active = activeFlight else {
            flights.forEach { $0.end() }
            return false
        }
        if active.cell !== cell { active.cell?.contentView.alpha = 1 }
        active.cell = cell
        active.item = (cell as? TranscriptCell)?.item
        cell.contentView.alpha = 0
        return true
    }

    @objc private func followFlight(_ link: CADisplayLink) {
        guard let flight = flights.first(where: { $0.follow === link }), let cell = flight.cell, cell.window != nil else { return }
        // Its cell taken for another row (scrolled away mid-flight): the flight goes, and that
        // row is left as it is.
        guard (cell as? TranscriptCell)?.item == flight.item else {
            if activeFlight === flight {
                activeFlight = nil
                flight.horiz.stopAnimation(true)
                flight.vert.stopAnimation(true)
            }
            flight.cell = nil
            flight.end()
            return
        }
        flight.track.transform = CGAffineTransform(translationX: 0, y: onScreenTop(of: cell) - flight.launchTop)
    }

    private func performSendFlightIfArmed(into cell: UICollectionViewCell, frameInCollection: CGRect, collectionView: UICollectionView) {
        guard let flight = pendingFlight else { return }
        pendingFlight = nil
        // Reveal any in-flight rapid send immediately before launching the next arc.
        finishActiveFlightImmediately()
        guard Date().timeIntervalSince(flight.at) < 0.6, !UIAccessibility.isReduceMotionEnabled else { return }
        let targetRow = view.convert(frameInCollection, from: collectionView)
        guard targetRow.height > 10, targetRow.width > 20 else { return }

        // What flies is the row itself, drawn as the transcript draws it, so it lands on it exactly.
        let hosting = UIHostingController(rootView: Rooted(room: room, content: UserBubble(text: flight.text, pending: "Sending…", captionHangs: true).padding(.horizontal, 2)))
        hosting.safeAreaRegions = []
        hosting.view.backgroundColor = .clear
        hosting.view.isUserInteractionEnabled = false
        let rowHeight = ceil(hosting.sizeThatFits(in: CGSize(width: targetRow.width, height: .greatestFiniteMagnitude)).height)
        // The bubble is at the row's right, as wide as its words (UserBubble: body, 14 × 10 padding,
        // 40 kept at the left). Its words set off where they were typed, the size they land.
        let font = AhType.uiFont(.body)
        let lines = NSMutableParagraphStyle()
        lines.lineSpacing = MentionChip.leading(font)
        let fit = NSAttributedString(string: flight.text, attributes: [.font: font, .paragraphStyle: lines])
            .boundingRect(with: CGSize(width: max(32, targetRow.width - 40 - 28), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
        let lead = targetRow.width - (ceil(fit.width) + 28)
        let start = CGPoint(
            x: max(view.bounds.minX + 8, min(flight.startFrame.minX + 30, view.bounds.maxX - 8 - targetRow.width + lead)) - lead,
            y: flight.startFrame.maxY - rowHeight
        )
        hosting.view.frame = CGRect(origin: start, size: CGSize(width: targetRow.width, height: rowHeight))
        // The proxy flies in a layer that rides with the row, so it lands where the row is when it
        // gets there, not where it was when you sent.
        let track = UIView(frame: view.bounds)
        track.isUserInteractionEnabled = false
        addChild(hosting)
        track.addSubview(hosting.view)
        view.addSubview(track)
        hosting.didMove(toParent: self)

        // The content view, not the cell: a layout pass sets a cell's alpha back from its
        // attributes, and the real bubble showed under the one flying.
        cell.contentView.alpha = 0

        let proxy = hosting.view!
        let horiz = UIViewPropertyAnimator(duration: 0.28, dampingRatio: 0.90) {
            proxy.frame.origin.x = targetRow.minX
        }
        let vert = UIViewPropertyAnimator(duration: 0.36, dampingRatio: 0.80) {
            proxy.frame.origin.y = targetRow.minY
        }
        let follow = CADisplayLink(target: self, selector: #selector(followFlight(_:)))
        let active = SendFlight(track: track, hosting: hosting, cell: cell, launchTop: targetRow.minY, follow: follow, horiz: horiz, vert: vert)
        active.ended = { [weak self] in self?.flights.removeAll { $0 === active } }
        flights.append(active)
        activeFlight = active
        follow.add(to: .main, forMode: .common)

        // Landed on it: the row shows itself and the proxy goes, in one frame. They're the same
        // view in the same place; faded across, the words paled and "Sending…" ghosted over "Sent".
        vert.addCompletion { [weak self] _ in
            guard let self, activeFlight === active else { return }
            activeFlight = nil
            active.end()
        }
        horiz.startAnimation()
        vert.startAnimation()
    }
}

/// A send's bubble on its way from the box to its row, and what it hid there.
@MainActor
private final class SendFlight {
    let track: UIView
    let hosting: UIViewController
    weak var cell: UICollectionViewCell?
    /// The row it flies to, as its cell showed it then.
    var item: TranscriptItem?
    let launchTop: CGFloat
    let follow: CADisplayLink
    let horiz: UIViewPropertyAnimator
    let vert: UIViewPropertyAnimator
    var ended: (() -> Void)?

    init(track: UIView, hosting: UIViewController, cell: UICollectionViewCell, launchTop: CGFloat, follow: CADisplayLink, horiz: UIViewPropertyAnimator, vert: UIViewPropertyAnimator) {
        self.track = track
        self.hosting = hosting
        self.cell = cell
        item = (cell as? TranscriptCell)?.item
        self.launchTop = launchTop
        self.follow = follow
        self.horiz = horiz
        self.vert = vert
    }

    /// The row shows again and the proxy goes. Safe to call twice.
    func end() {
        follow.invalidate()
        cell?.contentView.alpha = 1
        hosting.willMove(toParent: nil)
        track.removeFromSuperview()
        hosting.removeFromParent()
        ended?()
        ended = nil
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
        Group {
            // A subagent takes no messages of its own: where its box would be, whose it is and the way up.
            if session.acceptsInput {
                ComposerView(session: session, composer: session.composer, scene: scene, room: room)
            } else {
                SubagentFooter(session: session, scene: scene)
            }
        }
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
    let room: ConversationRoom
    let measured: @MainActor (CGFloat) -> Void

    var body: some View {
        ComposerFloat(session: session, composer: session.composer, scene: scene, room: room)
            .frame(maxWidth: SessionScreen.readableWidth)
            .frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured($0) }
            .frame(maxHeight: .infinity, alignment: .bottom)
    }
}
