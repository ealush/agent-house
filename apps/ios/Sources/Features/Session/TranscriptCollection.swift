import SwiftUI
import UIKit

// The transcript, on a UIKit collection view. The rows are SwiftUI views (TranscriptRows.swift),
// each in a cell; the collection view decides where the transcript sits. One anchor does, the end
// or a row you're reading, and every layout puts the view there before it's drawn: no scroll view
// guessing at a lazy stack's heights, no follow scrolling a frame later, nothing pulling against
// anything else. (A SwiftUI ScrollView over a LazyVStack did this before, and its estimated row
// heights left it past the end of a long turn, laid out but not drawn: a blank screen.)

/// Where the transcript can sit, from its scroll view's size, the bars over it and its content.
struct TranscriptPlacement: Equatable {
    /// The scroll view's height.
    var height: CGFloat
    /// What lies over its top (the bar) and its bottom (the composer and the keyboard).
    var top: CGFloat
    var bottom: CGFloat
    /// The conversation's height.
    var content: CGFloat

    /// What's left between the bars.
    var room: CGFloat { height - top - bottom }
    /// Above a conversation shorter than its room, so it sits down by the composer.
    var pad: CGFloat { max(0, room - content) }
    var minOffset: CGFloat { -(top + pad) }
    var maxOffset: CGFloat { max(minOffset, content + bottom - height) }

    /// The offset with the end in view, as far down as it goes.
    var end: CGFloat { maxOffset }

    /// The offset with a row whose top is at `rowTop` (in the content) `fromTop` below the bar.
    func offset(rowTop: CGFloat, fromTop: CGFloat) -> CGFloat {
        min(max(rowTop - fromTop - top, minOffset), maxOffset)
    }

    /// How far the end lies below what's in view at `offset`; at or under zero, it's in view.
    func below(_ offset: CGFloat) -> CGFloat { maxOffset - offset }
}

/// One row of the transcript.
enum TranscriptItem: Hashable, Sendable {
    case older
    case block(String)
    case outgoing(Int)
    case working
    /// What a waiting session asks you (`AskRow`), last.
    case ask

    var blockID: String {
        if case .block(let id) = self { id } else { "" }
    }
}

/// What the transcript holds, as the wrapper read it from the session.
struct TranscriptContent: Equatable {
    struct Working: Equatable {
        var detail: String?
        var toolKind: ToolKind? = nil
        var queued: Int
        var hardwareKeyboard: Bool
        var steps: Bool?
    }

    var blocks: [FeedBlock] = []
    var ends: [String: Double] = [:]
    var outgoing: [Outbox.Item] = []
    var working: Working?
    var hasOlder = false
    var loadingOlder = false
    var stepsHidden = false
    /// Several pictures in a message in a pile or side by side (Settings → Appearance).
    var pictureLook: DevicePreferences.PictureLook = .stack
    /// A new copy from the host (or a rotated transcript): laid out afresh, held where it was.
    var epoch = 0
    var linked: String?
    var highlightNonce = 0
    var highlightLight = false
    /// The host's copy is in: near the top, the page before can be read.
    var live = false
    /// It's asking you something: the question is the last row.
    var ask = false

    var items: [TranscriptItem] {
        var items: [TranscriptItem] = hasOlder ? [.older] : []
        items += blocks.map { .block($0.id) }
        items += outgoing.map { .outgoing($0.id) }
        if working != nil { items.append(.working) }
        if ask { items.append(.ask) }
        return items
    }
}

/// What the SwiftUI around the transcript shows from its scroll (the way down, the rail's mark),
/// and how it asks for one.
@MainActor @Observable
final class TranscriptScroll {
    var atBottom = true
    var unseen = false
    /// A pending Ask exists at the end of the transcript and is currently scrolled out of view.
    var askOffscreen = false
    var loadingOlder = false
    /// Reading message by message from the keyboard: the transcript holds its focus.
    var browsing = false
    /// The message a link, search hit, or rail jump opened, marked for a moment.
    var linked: String?
    /// Monotonic trigger so repeated jumps to the same target replay the highlight cleanly.
    var highlightNonce = 0
    /// Lighter pulse for MessageRail / turn jumps vs deep links and search results.
    var highlightLight = false
    @ObservationIgnored weak var controller: TranscriptController?
    /// True when an eligible short text send has armed a visual flight, so the existing Arrival
    /// row modifier does not double-animate the same outgoing bubble.
    @ObservationIgnored var hasArmedFlight: (() -> Bool)?
    /// Notifies `ConversationController` once a newly sent outgoing row is placed.
    @ObservationIgnored var onOutgoingPlaced: ((UICollectionViewCell, CGRect, UICollectionView) -> Void)?
}

struct TranscriptCollection: View {
    @Bindable var session: SessionModel
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The conversation's (`ConversationController`), which sets the transcript's insets from where
    /// the dock and the keyboard are.
    let scroll: TranscriptScroll
    @FocusState private var browseFocused: Bool

    private var focused: Bool { scene.app.preferences.focusMode && !session.stepsShown }
    private var shownBlocks: [FeedBlock] { focused ? session.focusedBlocks : session.blocks }

    var body: some View {
        let blocks = shownBlocks
        let content = TranscriptContent(
            blocks: blocks,
            ends: session.turnEnds,
            outgoing: session.outgoing,
            working: session.working ? .init(detail: session.row?.dto.detail ?? session.subagentNode?.activity, toolKind: session.activeToolKind, queued: session.queue.items.count, hardwareKeyboard: scene.hardwareKeyboard, steps: scene.app.preferences.focusMode ? session.stepsShown : nil) : nil,
            hasOlder: session.feed.hasOlder,
            loadingOlder: scroll.loadingOlder,
            stepsHidden: scene.app.preferences.stepsHidden,
            pictureLook: scene.app.preferences.pictureLook,
            epoch: session.feed.epoch,
            linked: scroll.linked,
            highlightNonce: scroll.highlightNonce,
            highlightLight: scroll.highlightLight,
            live: session.feed.status == .live,
            ask: AskRow.shows(session)
        )
        // The rows go under the bars and the dock (their insets keep them clear); what's laid over
        // them here keeps to the safe area, which reaches down to the dock's top.
        Color.clear
            .background {
                TranscriptCollectionHost(session: session, scene: scene, scroll: scroll, content: content, theme: theme, hostFiles: hostFiles)
                    .ignoresSafeArea()
            }
            // Over the transcript, centred in all of it: while the session asks something (its
            // trust question, a sign-in) the question is the transcript's last row, and this
            // would cover it and take its taps. The question says what it is; this steps aside.
            .overlay { if !AskRow.shows(session) { status(blocks) } }
            .overlay(alignment: .bottom) {
                // Animated here alone: on the whole transcript, leaving the end handed the
                // animation to every row that changed with it (a page going in), and they grew
                // into their new heights frame by frame, each frame measured again.
                // One jump control: when an unanswered Ask is waiting off-screen below, it turns
                // into the raised hand instead of adding a second floating button beside the arrow.
                let waiting = scroll.askOffscreen
                let showsJump = (waiting || (!scroll.atBottom && !blocks.isEmpty)) && !session.composer.floats
                let emphasized = waiting || scroll.unseen
                ZStack {
                    if showsJump {
                        Button {
                            if waiting {
                                Haptics.threshold()
                                scroll.controller?.toAsk(animated: true)
                            } else {
                                Haptics.selection()
                                scroll.controller?.toEnd(animated: true)
                            }
                        } label: {
                            Image(systemName: waiting ? "hand.point.up.fill" : "arrow.down")
                                .font(.system(size: 15, weight: .semibold))
                                .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                                .foregroundStyle(emphasized ? theme.accentInk : theme.text2)
                                .frame(width: 40, height: 40)
                                .glassEffect(emphasized ? .regular.tint(theme.accentStrong).interactive() : .regular.interactive(), in: Circle())
                                .touchTarget()
                        }
                        .buttonStyle(.ahPress)
                        .padding(.bottom, 10)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                        .accessibilityIdentifier(waiting ? "jump-to-ask" : "jump-to-latest")
                        .accessibilityLabel(waiting ? "Jump to the agent's pending question" : (scroll.unseen ? "Jump to the newest message, new output" : "Jump to the newest message"))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: showsJump)
                .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: waiting)
            }
            .overlay(alignment: .top) {
                if session.feed.status == .connecting, !blocks.isEmpty {
                    CatchingUp(scene: scene, key: session.key).padding(.top, 8)
                }
            }
            .overlay(alignment: .leading) {
                let items = session.railItems
                if items.count > 2 {
                    let top = scene.scrollAnchors[session.key]?.seq
                    MessageRail(items: items, active: FeedProjection.activeRail(items, topSeq: top, atLatest: top == nil) ?? items.count - 1) { item in
                        guard let seq = item.seq else {
                            scroll.controller?.toEnd(animated: true)
                            return
                        }
                        Task {
                            guard await session.reveal(seq: seq) else { return }
                            await Task.yield()
                            scroll.controller?.show(seq: seq, mark: true, light: true)
                        }
                    }
                }
            }
            // A link to a message: once the transcript is here, page back to it, bring it to the
            // top and mark it a moment.
            .task(id: "\(session.pendingMessage ?? -1)/\(blocks.isEmpty)") {
                guard let seq = session.pendingMessage, !blocks.isEmpty else { return }
                defer { session.pendingMessage = nil }
                guard await session.reveal(seq: seq) else {
                    scene.toast("That message isn’t in this transcript any more")
                    return
                }
                await Task.yield()
                scroll.controller?.show(seq: seq, mark: true)
            }
            .onChange(of: scene.focusRequest) { _, request in
                guard let request else { return }
                switch request.target {
                case .latest(let key) where key == session.key:
                    scroll.controller?.toEnd(animated: true)
                case .messages(let key) where key == session.key:
                    if scroll.controller?.browse() == true { browseFocused = true }
                case .turn(let key, let seq) where key == session.key:
                    Task {
                        guard await session.reveal(seq: seq) else {
                            scene.toast("That turn isn’t in this transcript any more")
                            return
                        }
                        await Task.yield()
                        scroll.controller?.show(seq: seq, mark: true, light: true)
                    }
                default:
                    break
                }
            }
            // Reading message by message: the keys go to the transcript until Esc (or a tap
            // elsewhere) gives them back.
            .focusable(scroll.browsing)
            .focused($browseFocused)
            .onKeyPress(phases: .down) { press in
                scroll.controller?.browseKey(press.key) == true ? .handled : .ignored
            }
            .onChange(of: browseFocused) { _, focused in
                if !focused { scroll.controller?.endBrowsing() }
            }
            .onChange(of: scroll.browsing) { _, browsing in
                if !browsing { browseFocused = false }
            }
            .background(theme.surface)
    }

    /// A fresh conversation, a transcript on its way or none to show.
    @ViewBuilder
    private func status(_ blocks: [FeedBlock]) -> some View {
        let fresh = session.isLive && !session.isShell && session.outgoing.isEmpty && blocks.isEmpty
        switch session.feed.status {
        case .unavailable where session.isLive && !session.isShell && session.feed.reason == "no-transcript":
            if fresh { StartConversation(session: session, scene: scene) }
        case .unavailable where !session.outgoing.isEmpty || !blocks.isEmpty:
            EmptyView()
        case .unavailable:
            UnavailableFeed(reason: session.feed.reason) { scene.setSurface(.terminal, for: session.key) }
        case .connecting where blocks.isEmpty && session.outgoing.isEmpty:
            ProgressView("Connecting to the transcript…")
        default:
            if fresh && session.feed.status == .live {
                StartConversation(session: session, scene: scene)
            }
        }
    }
}

private struct TranscriptCollectionHost: UIViewControllerRepresentable {
    let session: SessionModel
    let scene: SceneModel
    let scroll: TranscriptScroll
    let content: TranscriptContent
    let theme: Theme
    let hostFiles: HostFiles?

    func makeUIViewController(context: Context) -> TranscriptController {
        TranscriptController(session: session, scene: scene, scroll: scroll)
    }

    func updateUIViewController(_ controller: TranscriptController, context: Context) {
        controller.theme = theme
        controller.hostFiles = hostFiles
        controller.reduceMotion = context.environment.accessibilityReduceMotion
        controller.update(content)
    }
}

/// Lays out, then puts the transcript where its anchor says, in the same pass.
private final class TranscriptCollectionView: UICollectionView {
    var afterLayout: (() -> Void)?
    /// Laying out: what moves the view meanwhile is the layout, not anyone scrolling.
    private(set) var laying = false
    /// The next layout moves in this animation (a row folding, which SwiftUI animates in it).
    var animatesNextLayout: Animation?

    override func layoutSubviews() {
        guard let animation = animatesNextLayout else { return lay() }
        animatesNextLayout = nil
        // The rows' frames and the view's place, both set in here, move with the row.
        UIView.animate(animation) { self.lay() }
    }

    private func lay() {
        laying = true
        super.layoutSubviews()
        laying = false
        afterLayout?()
    }
}

@MainActor
final class TranscriptController: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    enum Anchor: Equatable {
        /// At the newest message: what comes keeps it in view.
        case end
        /// Reading: this row stays this far below the bar.
        case row(TranscriptItem, CGFloat)
    }

    static let slack: CGFloat = 48

    let session: SessionModel
    let scene: SceneModel
    let scroll: TranscriptScroll
    var theme = Theme.system
    var hostFiles: HostFiles?
    var reduceMotion = false

    private var collectionView: TranscriptCollectionView!
    /// The transcript's scroll view, for what overlays its edges to shape their soft edge
    /// (`UIScrollEdgeElementContainerInteraction`); nil until it's loaded.
    var scrollView: UIScrollView? { isViewLoaded ? collectionView : nil }
    private var dataSource: UICollectionViewDiffableDataSource<Int, TranscriptItem>!
    private var content = TranscriptContent()
    private var blocksByID: [String: (block: FeedBlock, index: Int)] = [:]
    private var anchor: Anchor = .end
    private var top: CGFloat = 0
    private var bottom: CGFloat = 0
    /// A scroll of ours under way (to the end, to a message): the anchor waits for it. When it
    /// began, so one that never reported its end can't hold the transcript still for good.
    private var scrolling: Date?
    private var placing = false
    /// A snapshot going in: the collection view moving the view meanwhile isn't anyone scrolling.
    private var applying = false
    /// The block the keyboard is on, reading back message by message (↑↓ or k/j).
    private var browsing: Int?
    /// What you just sent and the agent's working row, not yet on screen: they arrive in motion.
    private var arriving: Set<TranscriptItem> = []
    /// Turns a page carried on (its block's key → the row it was drawn in).
    private var aliases: [String: String] = [:]
    /// The row being read, grown at its top by a page that carried its turn on, and how tall it
    /// was: once it's measured again, what was read stays where it was.
    private var growing: (item: TranscriptItem, height: CGFloat)?
    /// A question just came in, not yet measured.
    private var askArrived = false
    /// Outgoing message IDs handled by the experimental send flight (suppresses Arrival double-animation).
    private var flownOutgoingIDs: Set<Int> = []
    #if DEBUG
    /// After every placing and scroll: the layout probe reads where the transcript is.
    var placed: (() -> Void)?
    #endif

    init(session: SessionModel, scene: SceneModel, scroll: TranscriptScroll) {
        self.session = session
        self.scene = scene
        self.scroll = scroll
        super.init(nibName: nil, bundle: nil)
        scroll.controller = self
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    /// Runs while a push (or pop) brings this screen in. UIKit fades the soft top edge out for the
    /// push: the transcript's edge effect, made as it comes into the window mid-push, gets an
    /// opacity animation from 1 to 0 on its blur layers, scrubbed with the transition and taken
    /// off only when it ends. The words read sharp under the bar for the whole slide, and the
    /// blur cut in after it.
    private var edgeKeeper: CADisplayLink?

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        guard let coordinator = transitionCoordinator, edgeKeeper == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(keepEdges))
        link.add(to: .main, forMode: .common)
        edgeKeeper = link
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.edgeKeeper?.invalidate()
            self?.edgeKeeper = nil
        }
    }

    /// Takes the transition's fade off the edge effect's blur, each frame until the push ends (the
    /// effect is made a few frames in).
    @objc private func keepEdges() {
        guard let collectionView else { return }
        func keep(_ layer: CALayer) {
            if layer.animation(forKey: "opacity") != nil, NSStringFromClass(type(of: layer)).contains("Backdrop") {
                layer.removeAnimation(forKey: "opacity")
            }
            layer.sublayers?.forEach(keep)
        }
        for view in collectionView.subviews where !(view is UICollectionReusableView) { keep(view.layer) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let layout = TranscriptLayout()
        layout.item = { [weak self] path in self?.dataSource.itemIdentifier(for: path) }
        collectionView = TranscriptCollectionView(frame: view.bounds, collectionViewLayout: layout)
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.backgroundColor = .clear
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.alwaysBounceVertical = true
        collectionView.delegate = self
        collectionView.accessibilityIdentifier = "transcript"
        collectionView.topEdgeEffect.style = .soft
        collectionView.bottomEdgeEffect.style = .soft
        collectionView.afterLayout = { [weak self] in self?.place() }
        view.addSubview(collectionView)

        let registration = UICollectionView.CellRegistration<TranscriptCell, TranscriptItem> { [weak self] cell, _, item in
            guard let self else { return }
            cell.item = item
            // A row growing or folding in an animation is drawn inside its cell as it goes.
            cell.clipsToBounds = true
            cell.contentConfiguration = UIHostingConfiguration { self.row(item, in: cell) }.margins(.all, 0)
            cell.backgroundConfiguration = .clear()
            self.configureSwipe(on: cell, for: item)
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { collectionView, indexPath, item in
            collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: item)
        }

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        collectionView.addGestureRecognizer(tap)
        editMenu = UIEditMenuInteraction(delegate: self)
        collectionView.addInteraction(editMenu)

        if let seq = scene.scrollAnchors[session.key]?.seq {
            restoreSeq = seq
        }
    }

    /// A place to come back to, held until its row is in the transcript.
    private var restoreSeq: Int?

    /// A message's actions, shown where a brief tap on it was (`MessageActions`).
    private var editMenu: UIEditMenuInteraction!
    /// The message a tap just landed on, and the row whose menu is showing.
    private var tappedMessage: TranscriptItem?
    private var menuItem: TranscriptItem?
    /// Where the last tap was, and when one last put something away (the keyboard, the
    /// settings, selected words, a message's menu): a tap that does that does only that.
    private var tapPoint: CGPoint?
    private var dismissedAt: Date?
    private var menuScheduled = false

    // MARK: Rows

    @ViewBuilder
    private func row(_ item: TranscriptItem, in cell: TranscriptCell) -> some View {
        let arrives = arriving.contains(item)
        Group {
            switch item {
            case .older:
                Button { [weak self] in
                    self?.loadOlder()
                } label: {
                    Label(content.loadingOlder ? "Loading…" : "Earlier messages", systemImage: "arrow.up")
                        .font(.ah(.footnote))
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)
            case .block(let id):
                if let entry = blocksByID[id] {
                    let block = entry.block, index = entry.index
                    VStack(alignment: .leading, spacing: 0) {
                        BlockRow(block: block, session: session, scene: scene, stepsHidden: content.stepsHidden, isLast: index == content.blocks.count - 1)
                            .padding(.horizontal, 2)
                            .modifier(JumpHighlight(blockID: block.id, active: content.linked == block.id, nonce: content.highlightNonce, light: content.highlightLight, browsing: browsing == index))
                            .accessibilityActions {
                                if session.isLive && block.hasText {
                                    let session = self.session, scene = self.scene
                                    Button(block.isUser ? "Reuse in Composer" : "Quote in Composer") {
                                        session.composer.addSnippet(kind: block.isUser ? .reuse : .quote, body: block.text)
                                        scene.requestFocus(.composer(session.key))
                                    }
                                }
                            }
                        if let seconds = content.ends[block.id] {
                            // The line under a reply and the room over it: a tap there is on the reply.
                            TurnFooter(seconds: seconds)
                                .padding(.top, 18)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                                .onTapGesture { [weak self] in self?.messageTapped(item) }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            case .outgoing(let id):
                if let item = content.outgoing.first(where: { $0.id == id }) {
                    let suppressArrival = flownOutgoingIDs.contains(id)
                    VStack(alignment: .trailing, spacing: 6) {
                        UserBubble(text: item.text, pending: !item.waitingOn.isEmpty ? nil : item.state == .sending ? "Sending…" : "Sent")
                        if !item.waitingOn.isEmpty { UploadBar(outbox: session.outbox, item: item) }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    // Springs up out of the box it was typed in (suppressed when send-flight handles arrival).
                    .modifier(Arrival(style: .spring, active: arrives && !suppressArrival, reduceMotion: reduceMotion))
                }
            case .working:
                if let working = content.working {
                    WorkingRow(detail: working.detail, toolKind: working.toolKind, queued: working.queued, hardwareKeyboard: working.hardwareKeyboard, steps: working.steps) { [weak self, session] in
                        self?.willResize(.working)
                        withAnimation(.snappy) { session.stepsShown.toggle() }
                    }
                    // A new turn (the newest message you sent) starts the clock again.
                    .id("working-" + (content.blocks.last { if case .user = $0 { return true } else { return false } }?.id ?? ""))
                    .modifier(Arrival(style: .rise, active: arrives, reduceMotion: reduceMotion))
                }
            case .ask:
                // Follows the session itself (what it asks, what's been picked), not the content.
                AskRow(session: session, scene: scene)
                    .modifier(Arrival(style: .rise, active: arrives, reduceMotion: reduceMotion))
            }
        }
        .environment(\.theme, theme)
        .environment(\.hostFiles, hostFiles)
        .environment(\.pictureLook, content.pictureLook)
        .environment(\.rowWillResize) { [weak self] in self?.willResize(item) }
        .environment(\.messageTapped) { [weak self] in self?.messageTapped(item) }
        .environment(\.openSubagent, subagentOpener)
        .tint(theme.accent)
        .font(.ah(.body))
        // As tall as it is, whatever the cell's height: what it measures is the row's height.
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { [weak self, weak cell] height in
            // Only from the cell showing it: one reused for another row still draws this one a
            // moment, and told its height too (with a footer or without), the two took turns.
            guard cell?.item == item else { return }
            self?.measured(item, height)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // From the cell's top, under the status bar too: a row reaching under it was pushed
        // down by the safe area there, its footer drawn over the row after it.
        .ignoresSafeArea()
        .onAppear { [weak self] in
            // Arrived: drawn again later (scrolled back to), it's simply there.
            if arrives { self?.arriving.remove(item) }
        }
    }

    // MARK: Content

    func update(_ new: TranscriptContent) {
        guard new != content else { return }
        let old = content
        let oldItems = Set(dataSource.snapshot().itemIdentifiers)
        // A page going in above that carries on the turn at the top: the turn comes back keyed
        // by the page's first entry. It stays the row it was (a new one would go in at its
        // estimated height and be drawn over its neighbours until measured), and grows at its
        // top by the page's part of it.
        if new.epoch != old.epoch { aliases = [:] }
        var merged: TranscriptItem?
        if let first = old.blocks.first, case .agent = first, !new.blocks.contains(where: { $0.id == first.id }),
           let into = new.blocks.last(where: { $0.seq <= first.seq }), case .agent = into, into.id != first.id {
            aliases[into.id] = item(first.id).blockID
            merged = .block(aliases[into.id]!)
        }
        content = new
        blocksByID = Dictionary(uniqueKeysWithValues: new.blocks.enumerated().map { (item($0.element.id).blockID, ($0.element, $0.offset)) })
        // A drag down the transcript takes the keyboard with it, under the finger; the dock rides
        // its top (the keyboard layout guide follows the drag).
        collectionView.keyboardDismissMode = scene.hardwareKeyboard ? .none : .interactive
        if let index = browsing, index >= new.blocks.count { browsing = new.blocks.indices.last }

        // Reading back, the anchor is where the finger left the view (a page may go in above).
        if collectionView.isTracking || collectionView.isDecelerating { readAnchor() }
        // A page going in above as a fling bounces off the top: the bounce would carry on from
        // where the page puts the view, back down a step. There's more above now; it stops.
        let prepended = !old.blocks.isEmpty && new.blocks.first?.id != old.blocks.first?.id
        if prepended, collectionView.isDecelerating, collectionView.contentOffset.y < -collectionView.contentInset.top {
            collectionView.setContentOffset(collectionView.contentOffset, animated: false)
        }
        if let merged, case .row(merged, _) = anchor, let height = frame(of: merged)?.height {
            growing = (merged, height)
        }

        var snapshot = NSDiffableDataSourceSnapshot<Int, TranscriptItem>()
        snapshot.appendSections([0])
        snapshot.appendItems(items(new))
        // Rows whose content changed draw again where they are; the rest stay as they were.
        let oldBlocks = Dictionary(uniqueKeysWithValues: old.blocks.enumerated().map { (item($0.element.id), ($0.element, $0.offset == old.blocks.count - 1)) })
        var changed: [TranscriptItem] = []
        for (index, block) in new.blocks.enumerated() where oldItems.contains(item(block.id)) {
            let last = index == new.blocks.count - 1
            if let was = oldBlocks[item(block.id)], was.0 == block, was.1 == last, old.pictureLook == new.pictureLook, old.ends[block.id] == new.ends[block.id], (old.linked == block.id) == (new.linked == block.id), old.highlightNonce == new.highlightNonce || new.linked != block.id { continue }
            changed.append(item(block.id))
        }
        for item in new.outgoing where oldItems.contains(.outgoing(item.id)) && old.outgoing.first(where: { $0.id == item.id }) != item {
            changed.append(.outgoing(item.id))
        }
        if oldItems.contains(.working), new.working != nil, old.working != new.working || old.blocks.last?.id != new.blocks.last?.id { changed.append(.working) }
        if oldItems.contains(.older), new.hasOlder, old.loadingOlder != new.loadingOlder { changed.append(.older) }
        snapshot.reconfigureItems(changed)

        // What you send, and the agent setting to work on it, come in moving; the transcript
        // arriving (or a new copy of it) is simply there. Suppress Arrival on an eligible short text
        // send whose experimental flight arc is armed so the same row is never double-animated.
        var flightCandidate: Int?
        if let newest = new.outgoing.last, !oldItems.contains(.outgoing(newest.id)), newest.waitingOn.isEmpty, scroll.hasArmedFlight?() == true {
            flownOutgoingIDs.insert(newest.id)
            flightCandidate = newest.id
        }
        if !old.blocks.isEmpty || !old.outgoing.isEmpty || new.blocks.isEmpty {
            for item in new.outgoing where !oldItems.contains(.outgoing(item.id)) && !flownOutgoingIDs.contains(item.id) {
                arriving.insert(.outgoing(item.id))
            }
        }
        if new.working != nil, !oldItems.contains(.working), !old.outgoing.isEmpty || new.outgoing.count > old.outgoing.count { arriving.insert(.working) }
        // A question coming in rises in; once it's measured, a long one shows its top.
        if new.ask, !old.ask {
            if !old.blocks.isEmpty { arriving.insert(.ask) }
            askArrived = true
        }
        // Answered while you read it: back to the end, where the conversation goes on.
        if !new.ask, case .row(.ask, _) = anchor { anchor = .end }
        arriving.formIntersection(snapshot.itemIdentifiers)

        let more = new.items.count > old.items.count || new.blocks.last != old.blocks.last
        applying = true
        // Rows take their new content as it is, never in an animation that's under way.
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) {
            if new.epoch != old.epoch {
                dataSource.applySnapshotUsingReloadData(snapshot)
            } else {
                dataSource.apply(snapshot, animatingDifferences: false)
            }
        }
        applying = false
        // Scrolled back, more at the end is news (the transcript first arriving isn't).
        if anchor != .end, more, !old.blocks.isEmpty { scroll.unseen = true }
        // What you send is what you look at next.
        if new.outgoing.count > old.outgoing.count {
            anchor = .end
            endBrowsing()
        }
        place()
        if let id = flightCandidate, let path = dataSource.indexPath(for: .outgoing(id)) {
            collectionView.layoutIfNeeded()
            if let cell = collectionView.cellForItem(at: path),
               let frame = collectionView.layoutAttributesForItem(at: path)?.frame {
                scroll.onOutgoingPlaced?(cell, frame, collectionView)
            }
        }
    }

    /// A row about to fold or unfold in `.snappy`, and when it said so.
    private var resizing: (item: TranscriptItem, at: Date)?

    private func willResize(_ item: TranscriptItem) {
        resizing = (item, .now)
    }

    /// A row drew at a new height: laid out again at it before the frame is shown.
    private func measured(_ item: TranscriptItem, _ height: CGFloat) {
        guard let layout = collectionView.collectionViewLayout as? TranscriptLayout, layout.set(height, for: item) else { return }
        // Folding or unfolding as you asked: what's around it moves with it, in its animation.
        if let resizing, resizing.item == item {
            self.resizing = nil
            if Date.now.timeIntervalSince(resizing.at) < 0.5, !reduceMotion { collectionView.animatesNextLayout = .snappy }
        }
        // A question taller than the room, just in at the end: its first question in view, not
        // its last button.
        if item == .ask, askArrived {
            askArrived = false
            if anchor == .end, height > placement.room - Self.slack { anchor = .row(.ask, 8) }
        }
        collectionView.setNeedsLayout()
    }

    /// The row a block is drawn in: its own, or the one of the turn a page carried it on from.
    private func item(_ blockID: String) -> TranscriptItem { .block(aliases[blockID] ?? blockID) }

    private func items(_ content: TranscriptContent) -> [TranscriptItem] {
        content.items.map { if case .block(let id) = $0 { item(id) } else { $0 } }
    }

    func setInsets(top: CGFloat, bottom: CGFloat) {
        guard abs(top - self.top) > 0.5 || abs(bottom - self.bottom) > 0.5 else { return }
        self.top = top
        self.bottom = bottom
        place()
        collectionView.layoutIfNeeded()
    }

    // MARK: Placing

    private var placement: TranscriptPlacement {
        TranscriptPlacement(height: collectionView.bounds.height, top: top, bottom: bottom, content: collectionView.collectionViewLayout.collectionViewContentSize.height)
    }

    /// Where the anchor puts the view.
    private func target(_ placement: TranscriptPlacement) -> CGFloat {
        switch anchor {
        case .end:
            return placement.end
        case .row(let item, var fromTop):
            guard let frame = frame(of: item) else {
                // Gone (a new copy of the transcript without it): held where it is, never off to
                // the end while you read.
                return min(max(collectionView.contentOffset.y, placement.minOffset), placement.maxOffset)
            }
            if let growing, growing.item == item, abs(frame.height - growing.height) > 0.5 {
                fromTop -= frame.height - growing.height
                anchor = .row(item, fromTop)
                self.growing = nil
            }
            return placement.offset(rowTop: frame.minY, fromTop: fromTop)
        }
    }

    private func frame(of item: TranscriptItem) -> CGRect? {
        dataSource.indexPath(for: item).flatMap { collectionView.layoutAttributesForItem(at: $0)?.frame }
    }

    /// Puts the transcript where the anchor says, every layout. A row being read holds still even
    /// while a finger or a fling moves the view: its anchor is read again at every scroll, so
    /// what this undoes is only what the layout moved (a page going in above, rows measured
    /// again). The end waits while a finger has it, and everything waits for a scroll of ours.
    private func place(force: Bool = false) {
        guard let collectionView, !placing, collectionView.bounds.height > 0 else { return }
        placing = true
        defer { placing = false }
        restoreIfReady()
        let placement = placement
        let inset = UIEdgeInsets(top: placement.top + placement.pad, left: 0, bottom: placement.bottom, right: 0)
        if collectionView.contentInset != inset {
            collectionView.contentInset = inset
            collectionView.verticalScrollIndicatorInsets = UIEdgeInsets(top: placement.top, left: 0, bottom: placement.bottom, right: 0)
        }
        // A scroll of ours that never said it ended (taken over by another) has.
        if let since = scrolling, Date.now.timeIntervalSince(since) > 1.5 { scrolling = nil }
        if scrolling != nil, !force { return }
        if collectionView.isTracking || collectionView.isDecelerating, anchor == .end { return }
        let target = target(placement)
        if abs(collectionView.contentOffset.y - target) > 0.5 {
            collectionView.contentOffset.y = target
        }
        publish()
        // Near the top once it's placed (a short first page): the page before is read in, as it
        // would be on the way up.
        if nearTop, content.hasOlder, content.live { loadOlder() }
        #if DEBUG
        placed?()
        #endif
    }

    /// The anchor from where the view is: the end if it's within reach, else the first row whose
    /// top is in view, or the one running through the top of the view if none is. The first: a
    /// page going in above adds to the turn at the very top (and rows above get measured), and a
    /// row below them stays where it was. Never the button for earlier messages, which a page
    /// going in leaves at the top.
    private func readAnchor() {
        let placement = placement
        let offset = collectionView.contentOffset.y
        if placement.below(offset) <= Self.slack {
            anchor = .end
        } else {
            let line = offset + placement.top
            let rows = collectionView.indexPathsForVisibleItems.sorted().compactMap { path -> (TranscriptItem, CGRect)? in
                guard let item = dataSource.itemIdentifier(for: path), item != .older,
                      let frame = collectionView.layoutAttributesForItem(at: path)?.frame, frame.maxY > line else { return nil }
                return (item, frame)
            }
            if let (item, frame) = rows.first(where: { $0.1.minY >= line && $0.1.minY < line + placement.room }) ?? rows.first {
                anchor = .row(item, frame.minY - line)
            }
        }
        publish()
    }

    private func publish() {
        let atEnd = anchor == .end
        if scroll.atBottom != atEnd { scroll.atBottom = atEnd }
        if atEnd, scroll.unseen { scroll.unseen = false }
        let offscreen = isAskOffscreen()
        if scroll.askOffscreen != offscreen { scroll.askOffscreen = offscreen }
        // The restoration anchor: the block at the top of the screen, or none at the newest.
        var seq: Int?
        if case .row(.block(let id), _) = anchor { seq = blocksByID[id]?.block.seq }
        let saved = SceneSnapshot.ScrollAnchor(seq: atEnd ? nil : seq, offset: 0)
        if scene.scrollAnchors[session.key] != saved { scene.scrollAnchors[session.key] = saved }
    }

    private func restoreIfReady() {
        guard let seq = restoreSeq, !content.blocks.isEmpty else { return }
        restoreSeq = nil
        if let block = content.blocks.first(where: { $0.seq == seq }) { anchor = .row(item(block.id), 0) }
    }

    // MARK: Scrolls asked for

    /// To where the anchor now is, in a scroll of ours when there's motion to show.
    private func go(animated: Bool) {
        // Laid out first (rows just read in), without the layout jumping there itself.
        scrolling = .now
        collectionView.layoutIfNeeded()
        let target = target(placement)
        if animated, !reduceMotion, abs(collectionView.contentOffset.y - target) > 0.5 {
            collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: true)
            publish()
        } else {
            scrolling = nil
            place(force: true)
        }
    }

    func toEnd(animated: Bool) {
        anchor = .end
        scroll.unseen = false
        scroll.askOffscreen = false
        go(animated: animated)
    }

    /// True when an active Ask row exists and is scrolled out of the visible transcript viewport.
    private func isAskOffscreen() -> Bool {
        guard content.ask, anchor != .end else { return false }
        guard let askFrame = frame(of: .ask) else { return true }
        let visibleTop = collectionView.contentOffset.y + top
        let visibleBottom = visibleTop + max(0, placement.room)
        let overlap = min(askFrame.maxY, visibleBottom) - max(askFrame.minY, visibleTop)
        return overlap < 24
    }

    /// Jumps directly to the active Ask row; safely no-ops if the Ask was resolved right before tap.
    func toAsk(animated: Bool) {
        scroll.askOffscreen = false
        guard content.ask else { return }
        if let frame = frame(of: .ask), frame.height > placement.room - Self.slack {
            anchor = .row(.ask, 8)
        } else {
            anchor = .end
        }
        go(animated: animated)
    }

    /// The block holding `seq` near the top, marked with a two-beat highlight pulse when jumping to it.
    func show(seq: Int, mark: Bool, light: Bool = false) {
        guard let block = content.blocks.first(where: { $0.seq == seq }) ?? content.blocks.last(where: { $0.seq <= seq }) else { return }
        anchor = .row(item(block.id), 12)
        go(animated: true)
        guard mark else { return }
        Haptics.tap()
        scroll.highlightLight = light
        scroll.highlightNonce += 1
        scroll.linked = block.id
        let activeNonce = scroll.highlightNonce
        let hold: Double = light ? 1.05 : 1.7
        Task { [scroll] in
            try? await Task.sleep(for: .seconds(hold))
            guard scroll.highlightNonce == activeNonce else { return }
            withAnimation(.easeOut(duration: 0.35)) { scroll.linked = nil }
        }
    }

    // MARK: Reading message by message

    /// The keyboard onto the newest message, to read back from (↑↓ or k/j, c copies, r restores
    /// the code to before it, Esc goes back to the composer).
    func browse() -> Bool {
        guard !content.blocks.isEmpty else { return false }
        move(to: content.blocks.count - 1)
        return true
    }

    private func move(to index: Int) {
        let was = browsing
        browsing = index
        scroll.browsing = true
        reconfigure([was, index].compactMap { $0 })
        guard let entry = content.blocks.indices.contains(index) ? content.blocks[index] : nil,
              let path = dataSource.indexPath(for: item(entry.id)) else { return }
        // In the middle of the room, or its top in view when it's taller than that.
        collectionView.layoutIfNeeded()
        let height = collectionView.layoutAttributesForItem(at: path)?.frame.height ?? 0
        anchor = .row(item(entry.id), max(0, (placement.room - height) / 2))
        go(animated: true)
    }

    func endBrowsing() {
        guard let was = browsing else { return }
        browsing = nil
        scroll.browsing = false
        reconfigure([was])
    }

    private func reconfigure(_ indices: [Int]) {
        let items = indices.compactMap { content.blocks.indices.contains($0) ? item(content.blocks[$0].id) : nil }
        var snapshot = dataSource.snapshot()
        let present = items.filter { snapshot.indexOfItem($0) != nil }
        guard !present.isEmpty else { return }
        snapshot.reconfigureItems(present)
        applying = true
        dataSource.apply(snapshot, animatingDifferences: false)
        applying = false
    }

    /// A key while reading message by message; ignored when it isn't one of those.
    func browseKey(_ key: KeyEquivalent) -> Bool {
        guard let current = browsing, content.blocks.indices.contains(current) else { return false }
        switch key {
        case .upArrow, "k":
            move(to: max(0, current - 1))
        case .downArrow, "j":
            move(to: min(content.blocks.count - 1, current + 1))
        case "c":
            UIPasteboard.general.string = content.blocks[current].text
            scene.toast("Copied the message")
        case "r":
            session.restoreRequest = content.blocks[current].text
            session.panel = .snapshots
        case .escape:
            endBrowsing()
            scene.requestFocus(.composer(session.key))
        default:
            return false
        }
        return true
    }

    // MARK: Older pages

    private func loadOlder(run: Int = 0) {
        guard content.hasOlder, !scroll.loadingOlder else { return }
        scroll.loadingOlder = true
        Task {
            let more = await session.loadOlder()
            scroll.loadingOlder = false
            // Still near the top: a long turn's steps fold into a line, so a page may not take
            // you away from it. A few, so a page that didn't lay out can't read in everything.
            if more, nearTop, run < 3 { loadOlder(run: run + 1) }
        }
    }

    /// Within half a screen of the top: the page before is read in on the way there.
    private var nearTop: Bool {
        collectionView.contentOffset.y + collectionView.contentInset.top < collectionView.bounds.height / 2
    }

    // MARK: Scrolling

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        #if DEBUG
        placed?()
        #endif
        // Someone scrolling (a finger, a trackpad, a fling, VoiceOver's three-finger scroll):
        // the anchor is where they've taken it. Not anything else that moves the view (turning
        // the screen, a pane resized), which isn't reading anywhere.
        let someone = scrollView.isTracking || scrollView.isDecelerating || UIAccessibility.isVoiceOverRunning
        if someone, !placing, !applying, scrolling == nil, !collectionView.laying { readAnchor() }
        if nearTop, content.hasOlder, scrollView.isTracking || scrollView.isDecelerating { loadOlder() }
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        scrolling = nil
        // Back to reading: the composer's settings fold out of the way, as the keyboard does.
        if session.composer.trayOpen {
            withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { session.composer.trayOpen = false }
        }
        editMenu.dismissMenu()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settled() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settled() }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        scrolling = nil
        place(force: true)
    }

    /// Let go: the anchor is where it came to rest, and the view is put there exactly.
    private func settled() {
        readAnchor()
        place(force: true)
    }

    /// Configures swipe-left-to-quote (agent reply) or swipe-left-to-reuse (user bubble) on a cell.
    private func configureSwipe(on cell: TranscriptCell, for item: TranscriptItem) {
        guard session.isLive, case .block(let id) = item, let block = blocksByID[id]?.block, block.hasText else {
            cell.clearSwipe()
            return
        }
        let isUser = block.isUser
        let text = block.text
        let accent = theme.uiAccent
        let tile = UIColor(theme.tile)
        let ink = UIColor(theme.accentInk)
        let muted = UIColor(theme.text2)
        cell.configureSwipe(
            symbol: isUser ? "arrow.uturn.left" : "text.quote",
            armedFill: accent,
            idleFill: tile,
            armedInk: ink,
            idleInk: muted
        ) { [weak self] in
            guard let self else { return }
            session.composer.addSnippet(kind: isUser ? .reuse : .quote, body: text)
            scene.requestFocus(.composer(session.key))
            Haptics.tap()
        }
        #if DEBUG
        cell.swipeEnded = { [weak self] in self?.placed?() }
        #endif
    }

    // MARK: Taps

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        let point = tap.location(in: collectionView)
        var dismissed = false
        // A tap on the conversation folds what floats over it, as it puts the keyboard away.
        if session.composer.trayOpen {
            withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { session.composer.trayOpen = false }
            dismissed = true
        }
        // Words selected in a reply let go, as a page's do when you tap away from them.
        ProseTextView.dropped = false
        UIApplication.shared.sendAction(#selector(ProseTextView.dropSelection), to: nil, from: nil, for: nil)
        if ProseTextView.dropped { dismissed = true }
        if !scene.hardwareKeyboard, scene.composerFocused != nil {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            dismissed = true
        }
        if dismissed { dismissedAt = .now }
        tapPoint = point
        // Between messages, or under the last one: the message just above.
        if collectionView.indexPathForItem(at: point) == nil, let above = message(above: point) { messageTapped(above) }
    }

    /// What a Delegate card opens its subagent with, while its host reads them (its features are
    /// known before a session opens; the row's own counts may come later, and cells set up
    /// before them were never set up again).
    private var subagentOpener: (@MainActor @Sendable (String) -> Void)? {
        guard session.hostReadsSubagents, !session.isShell else { return nil }
        return { [weak self] callId in self?.openSubagent(callId) }
    }

    /// A Delegate card's subagent, by the call that spawned it: the tree is asked for first if
    /// it hasn't been, or doesn't have it yet (spawned a moment ago).
    private func openSubagent(_ callId: String) {
        let session = session, scene = scene
        Task { @MainActor in
            if session.subagents.tree?.nodes.contains(where: { $0.toolCallId == callId }) != true { await session.subagents.load() }
            if let node = session.subagents.tree?.nodes.first(where: { $0.toolCallId == callId }) {
                scene.openSubagent(node, from: session)
            } else {
                scene.toast("Its host doesn’t have that subagent’s conversation", error: true)
            }
        }
    }

    /// A brief tap on a message (its words, your bubble, the line under it, the room after it):
    /// its actions, where the finger was. Shown once the tap's handlers have all run (the words',
    /// the bubble's and the transcript's own come in no set order), and not for a tap that put
    /// something away.
    private func messageTapped(_ item: TranscriptItem) {
        tappedMessage = item
        guard !menuScheduled else { return }
        menuScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            menuScheduled = false
            defer { tappedMessage = nil }
            guard let item = tappedMessage, let point = tapPoint, Date.now.timeIntervalSince(dismissedAt ?? .distantPast) > 0.4 else { return }
            menuItem = item
            editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
        }
    }

    /// The message whose row ends just above a point between rows (or under the last).
    private func message(above point: CGPoint) -> TranscriptItem? {
        collectionView.indexPathsForVisibleItems
            .compactMap { path -> (item: TranscriptItem, bottom: CGFloat)? in
                guard let item = dataSource.itemIdentifier(for: path), case .block = item,
                      let frame = collectionView.layoutAttributesForItem(at: path)?.frame,
                      frame.maxY <= point.y, point.y - frame.maxY < 80 else { return nil }
                return (item, frame.maxY)
            }
            .max { $0.bottom < $1.bottom }?.item
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

// UIKit asks on the main thread; the protocol just doesn't say so.
extension TranscriptController: @preconcurrency UIEditMenuInteractionDelegate {
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard case .block(let id)? = menuItem, let block = blocksByID[id]?.block else { return nil }
        let actions = MessageActions.menu(for: block, session: session, scene: scene)
        return actions.isEmpty ? nil : UIMenu(children: actions)
    }

    /// A tap away from an open menu closes it, and that's all it does: the next tap shows one
    /// (otherwise a tap on your bubble did nothing and a tap on the words moved the menu).
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, willDismissMenuFor configuration: UIEditMenuConfiguration, animator: any UIEditMenuInteractionAnimating) {
        dismissedAt = .now
    }
}

/// A row arriving: what you sent springs up out of the composer, the working row rises in.
/// Only how it's drawn moves (scale, offset, opacity), never its size, so the rows around it
/// and the view's place stay as they are.
private struct Arrival: ViewModifier {
    enum Style { case spring, rise }
    let style: Style
    let active: Bool
    let reduceMotion: Bool
    @State private var arrived = false

    func body(content: Content) -> some View {
        let away = active && !arrived
        content
            .scaleEffect(away && style == .spring && !reduceMotion ? 0.85 : 1, anchor: .bottomTrailing)
            .offset(y: away && !reduceMotion ? (style == .spring ? 24 : 12) : 0)
            .opacity(away ? 0 : 1)
            .onAppear {
                guard active, !arrived else { return }
                withAnimation(reduceMotion ? .easeOut(duration: 0.2) : style == .spring ? .spring(duration: 0.35, bounce: 0.3) : .snappy(duration: 0.25)) { arrived = true }
            }
    }
}

/// The transcript's rows, one under another in a readable column, each as tall as it last
/// measured. Nothing here moves the view: as rows are measured (those above it too), the anchor
/// puts it back where it was in the same pass. The system's list layout moved it as well, to
/// keep what's in view still; the two together brought more unmeasured rows into view each
/// pass, measured them inside the same pass, and so on until UIKit gave up.
final class TranscriptLayout: UICollectionViewLayout {
    static let spacing: CGFloat = 18
    static let margin: CGFloat = 12
    static let estimate: CGFloat = 80

    var item: (IndexPath) -> TranscriptItem? = { _ in nil }
    private var heights: [TranscriptItem: CGFloat] = [:]
    private var rows: [UICollectionViewLayoutAttributes] = []
    private var height: CGFloat = 0
    private var width: CGFloat = 0
    /// How often each row's height changed since the run loop last turned: one that won't settle
    /// keeps the height it has.
    private var changes: [TranscriptItem: Int] = [:]

    override func prepare() {
        super.prepare()
        guard let collectionView else { return }
        width = collectionView.bounds.width
        // A readable column on a wide screen, centred; the scroll view stays full width.
        let side = (width - min(width, SessionScreen.readableWidth)) / 2 + 16
        let count = collectionView.numberOfSections > 0 ? collectionView.numberOfItems(inSection: 0) : 0
        var y = Self.margin
        rows = (0..<count).map { index in
            let path = IndexPath(item: index, section: 0)
            let row = UICollectionViewLayoutAttributes(forCellWith: path)
            let height = item(path).flatMap { heights[$0] } ?? Self.estimate
            row.frame = CGRect(x: side, y: y, width: max(0, width - 2 * side), height: height)
            y += height + Self.spacing
            return row
        }
        height = count == 0 ? 0 : y - Self.spacing + Self.margin
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 0, height: height)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        var low = 0, high = rows.count
        while low < high {
            let mid = (low + high) / 2
            if rows[mid].frame.maxY < rect.minY { low = mid + 1 } else { high = mid }
        }
        var out: [UICollectionViewLayoutAttributes] = []
        var index = low
        while index < rows.count, rows[index].frame.minY <= rect.maxY {
            out.append(rows[index])
            index += 1
        }
        return out
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        rows.indices.contains(indexPath.item) ? rows[indexPath.item] : nil
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != width
    }

    /// A row's height as it drew; true if that changes the layout (then invalidated). A row
    /// that won't settle within a turn of the run loop keeps the height it has.
    func set(_ height: CGFloat, for item: TranscriptItem) -> Bool {
        let scale = max(1, collectionView?.traitCollection.displayScale ?? 3)
        let height = (height * scale).rounded(.up) / scale
        guard abs(height - (heights[item] ?? Self.estimate)) > 0.5 else { return false }
        if changes.isEmpty {
            DispatchQueue.main.async { [weak self] in self?.changes = [:] }
        }
        changes[item, default: 0] += 1
        guard changes[item, default: 0] <= 4 else { return false }
        heights[item] = height
        invalidateLayout()
        return true
    }
}

/// Two-beat focus highlight wash + leading accent bar when jumping to a target message.
/// Fires cleanly for offscreen cells (`.onAppear`), repeated jumps (`nonce`), and reused cells (`blockID`),
/// with a static high-contrast highlight under Reduce Motion.
private struct JumpHighlight: ViewModifier {
    let blockID: String
    let active: Bool
    let nonce: Int
    let light: Bool
    let browsing: Bool
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulseTrigger = 0

    func body(content: Content) -> some View {
        if active {
            if reduceMotion {
                content
                    .background(theme.accent.opacity(light ? 0.14 : 0.2), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(alignment: .leading) {
                        Capsule().fill(theme.accent.opacity(0.85)).frame(width: 3).padding(.vertical, 4)
                    }
            } else {
                let peak = light ? 0.16 : 0.24
                content
                    .keyframeAnimator(initialValue: 0.0, trigger: pulseTrigger) { view, phase in
                        view
                            .background(theme.accent.opacity(phase), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(alignment: .leading) {
                                Capsule()
                                    .fill(theme.accent.opacity(min(0.95, phase * 5.0)))
                                    .frame(width: 3)
                                    .padding(.vertical, 4)
                            }
                    } keyframes: { _ in
                        LinearKeyframe(peak, duration: 0.18, timingCurve: .easeOut)
                        LinearKeyframe(peak * 0.35, duration: 0.24, timingCurve: .easeInOut)
                        LinearKeyframe(peak * 0.9, duration: 0.22, timingCurve: .easeInOut)
                        LinearKeyframe(0.0, duration: light ? 0.55 : 0.75, timingCurve: .easeOut)
                    }
                    .onAppear { pulseTrigger += 1 }
                    .onChange(of: nonce) { _, _ in pulseTrigger += 1 }
                    .onChange(of: blockID) { _, _ in pulseTrigger += 1 }
            }
        } else if browsing {
            content.background(theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        } else {
            content
        }
    }
}

/// A row: as tall as the layout says (what its content last measured), never sized by UIKit.
/// Measured by UIKit, a reused cell was measured before its content had caught up, and took
/// another row's height for a pass. Also hosts a swipe-left-to-quote/reuse gesture whose trailing
/// indicator stays clamped to the visible viewport on tall replies and yields to horizontal code scrollers.
final class TranscriptCell: UICollectionViewCell, UIGestureRecognizerDelegate {
    private static let triggerDistance: CGFloat = 58
    private static let disarmDistance: CGFloat = 40
    private static let linearTravel: CGFloat = 64
    private static let maxTravel: CGFloat = 110

    /// The row it shows now.
    var item: TranscriptItem?
    private var swipeAction: (() -> Void)?
    private var armedFill: UIColor = .systemPink
    private var idleFill: UIColor = .secondarySystemFill
    private var armedInk: UIColor = .white
    private var idleInk: UIColor = .secondaryLabel
    private var swipeArmed = false
    private var swipeInstalled = false
    /// Where the badge is held while a drag is under way: by the finger, and into the gap the
    /// message opens. Nil at rest.
    private var badgeTouchY: CGFloat?
    private var badgeGap: CGFloat = 0
    #if DEBUG
    /// The last swipe, for the layout probe: the most the row was drawn away from its place while
    /// the finger was down, the most the drag asked for, and how often the cell was laid out meanwhile.
    struct SwipeTrace: Equatable, Encodable {
        var shown: CGFloat = 0
        var asked: CGFloat = 0
        var layouts = 0
    }
    static var lastSwipe: SwipeTrace?
    /// Told when a swipe ends, so the probe reads `lastSwipe`.
    var swipeEnded: (() -> Void)?
    private var trace: SwipeTrace?
    private var restX: CGFloat = 0
    /// Where the row's content is drawn now (what's on screen, not what was last asked for).
    private var drawnX: CGFloat {
        let content = contentView.layer.presentation() ?? contentView.layer
        let hosted = contentView.subviews.first.map { $0.layer.presentation() ?? $0.layer }
        return content.frame.minX + (hosted?.frame.minX ?? 0)
    }
    #endif
    private let badgeIcon = UIImageView()

    private lazy var swipePan: UIPanGestureRecognizer = {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
        pan.delegate = self
        pan.cancelsTouchesInView = false
        return pan
    }()

    private lazy var badgeView: UIView = {
        let v = UIView(frame: CGRect(x: 0, y: 0, width: 32, height: 32))
        v.layer.cornerRadius = 16
        v.alpha = 0
        v.isUserInteractionEnabled = false
        badgeIcon.translatesAutoresizingMaskIntoConstraints = false
        badgeIcon.contentMode = .scaleAspectFit
        v.addSubview(badgeIcon)
        NSLayoutConstraint.activate([
            badgeIcon.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            badgeIcon.centerYAnchor.constraint(equalTo: v.centerYAnchor),
            badgeIcon.widthAnchor.constraint(equalToConstant: 15),
            badgeIcon.heightAnchor.constraint(equalToConstant: 15),
        ])
        return v
    }()

    override func prepareForReuse() {
        super.prepareForReuse()
        alpha = 1
        // A send's flight hides the row it's flying to through this; never another row after.
        contentView.alpha = 1
        contentView.transform = .identity
        badgeView.alpha = 0
        badgeView.transform = .identity
        swipeArmed = false
        badgeTouchY = nil
        badgeGap = 0
    }

    func configureSwipe(symbol: String, armedFill: UIColor, idleFill: UIColor, armedInk: UIColor, idleInk: UIColor, action: @escaping () -> Void) {
        self.swipeAction = action
        self.armedFill = armedFill
        self.idleFill = idleFill
        self.armedInk = armedInk
        self.idleInk = idleInk
        let cfg = UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        badgeIcon.image = UIImage(systemName: symbol, withConfiguration: cfg)
        badgeView.backgroundColor = idleFill
        badgeIcon.tintColor = idleInk
        if !swipeInstalled {
            swipeInstalled = true
            insertSubview(badgeView, belowSubview: contentView)
            addGestureRecognizer(swipePan)
        }
        swipePan.isEnabled = true
    }

    func clearSwipe() {
        swipeAction = nil
        if swipeInstalled { swipePan.isEnabled = false }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        #if DEBUG
        trace?.layouts += 1
        #endif
        // Each step of a drag lays the cell out again (its content's transform changed), and
        // UIKit puts the content back by its frame, which the drag's translation is part of: the
        // message stood still under the finger and only moved as it sprang back. By its center,
        // which the translation isn't, it stays where the finger has it.
        if contentView.transform != .identity {
            contentView.center = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        if swipeInstalled { positionBadge() }
    }

    /// Keeps the trailing indicator visible inside the collection view's current viewport even on
    /// multi-screen agent replies, anchored near the touch point while a drag is under way.
    private func positionBadge() {
        let touchY = badgeTouchY
        var cy = bounds.height / 2
        if let collection = superview as? UICollectionView {
            let visibleInCollection = collection.bounds.inset(by: collection.adjustedContentInset)
            let visibleInCell = convert(visibleInCollection, from: collection).intersection(bounds)
            if !visibleInCell.isNull, visibleInCell.height > 20 {
                let preferred = touchY ?? visibleInCell.midY
                cy = min(visibleInCell.maxY - 24, max(visibleInCell.minY + 24, preferred))
            }
        }
        cy = min(max(24, bounds.height - 24), max(24, cy))
        badgeView.center = CGPoint(x: bounds.width - 22 - badgeGap, y: cy)
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === swipePan else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
        guard swipeAction != nil else { return false }
        let v = swipePan.velocity(in: self)
        guard v.x < 0, abs(v.x) > abs(v.y) * 1.5 else { return false }
        // Yield when touching inside a horizontal code/diff/table scroller OR an active text
        // selection inside a UITextView so swiping never conflicts with prose selection handles.
        let point = swipePan.location(in: self)
        if var hit = hitTest(point, with: nil) {
            while hit !== self, let parent = hit.superview {
                if let textView = hit as? UITextView, textView.selectedRange.length > 0 || textView.isFirstResponder {
                    return false
                }
                if let scroll = hit as? UIScrollView, scroll.contentSize.width > scroll.bounds.width + 1 {
                    return false
                }
                hit = parent
            }
        }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        false
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        // Never delay long-press text selection or context menus on the message.
        false
    }

    @objc private func handleSwipe(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            swipeArmed = false
            badgeTouchY = pan.location(in: self).y
            badgeGap = 0
            positionBadge()
            #if DEBUG
            restX = drawnX
            trace = SwipeTrace()
            #endif
        case .changed:
            let raw = max(0, -pan.translation(in: self).x)
            #if DEBUG
            if let shown = trace?.shown { trace?.shown = max(shown, restX - drawnX) }
            #endif
            let offset: CGFloat
            if raw <= Self.linearTravel {
                offset = -raw
            } else {
                offset = -(Self.linearTravel + 34 * log(1 + (raw - Self.linearTravel) / 34))
            }
            let clamped = max(-Self.maxTravel, offset)
            contentView.transform = CGAffineTransform(translationX: clamped, y: 0)
            #if DEBUG
            if let asked = trace?.asked { trace?.asked = max(asked, -clamped) }
            #endif

            let progress = min(1, max(0, (raw - 8) / (Self.triggerDistance - 8)))
            badgeView.alpha = progress
            // Track the trailing badge into the gap opened behind the dragged message.
            badgeGap = max(0, -clamped - 24) * 0.25
            positionBadge()

            if !swipeArmed && raw >= Self.triggerDistance {
                swipeArmed = true
                Haptics.threshold()
                UIView.animate(withDuration: 0.16) {
                    self.badgeView.backgroundColor = self.armedFill
                    self.badgeIcon.tintColor = self.armedInk
                }
                if !UIAccessibility.isReduceMotionEnabled {
                    UIView.animate(springDuration: 0.30, bounce: 0.48) {
                        self.badgeView.transform = CGAffineTransform(scaleX: 1.22, y: 1.22)
                    } completion: { _ in
                        UIView.animate(springDuration: 0.22, bounce: 0.22) {
                            self.badgeView.transform = .identity
                        }
                    }
                }
            } else if swipeArmed && raw < Self.disarmDistance {
                swipeArmed = false
                Haptics.selection()
                UIView.animate(withDuration: 0.14) {
                    self.badgeView.backgroundColor = self.idleFill
                    self.badgeIcon.tintColor = self.idleInk
                }
            } else if !swipeArmed {
                let scale = 0.45 + 0.55 * progress
                badgeView.transform = CGAffineTransform(scaleX: scale, y: scale)
            }
        case .ended, .cancelled, .failed:
            let commit = pan.state == .ended && swipeArmed
            swipeArmed = false
            badgeTouchY = nil
            badgeGap = 0
            #if DEBUG
            Self.lastSwipe = trace
            trace = nil
            swipeEnded?()
            #endif
            let reset = {
                self.contentView.transform = .identity
                self.badgeView.alpha = 0
                self.badgeView.transform = CGAffineTransform(scaleX: 0.45, y: 0.45)
                self.badgeView.center.x = self.bounds.width - 22
                self.badgeView.backgroundColor = self.idleFill
                self.badgeIcon.tintColor = self.idleInk
            }
            if UIAccessibility.isReduceMotionEnabled {
                UIView.animate(withDuration: 0.18, animations: reset)
            } else {
                // Pronounced spring snap-back on the dragged message itself.
                UIView.animate(springDuration: 0.46, bounce: 0.36, animations: reset)
            }
            if commit { swipeAction?() }
        default:
            break
        }
    }

    /// No safe area above or below a row: the transcript places its rows itself, from the
    /// insets the conversation hands it. The cell's SwiftUI was laid out in the part of the
    /// cell outside the safe area, which reaches up to the top of the dock (the queue, the
    /// box): a row sliding under the dock had its content ride up (110 points above the row's
    /// top under a queue of three), held still while the row moved on and cut off at its top
    /// edge, so the row above seemed to slide over it. The row's own `ignoresSafeArea` doesn't
    /// reach past the hosting configuration, and the transcript's controller can't take the
    /// insets back (UIKit doesn't go below its parent's). Sideways insets stay: a phone on its
    /// side keeps the rows off the notch.
    override var safeAreaInsets: UIEdgeInsets {
        let insets = super.safeAreaInsets
        return UIEdgeInsets(top: 0, left: insets.left, bottom: 0, right: insets.right)
    }

    override func preferredLayoutAttributesFitting(_ attributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        attributes
    }
}

#if DEBUG
extension TranscriptController {
    /// Where the transcript is, for the layout probe (`LayoutProbe`): sizes and its anchor, no text.
    struct Diagnostics: Equatable, Encodable {
        var offset: CGFloat
        var contentHeight: CGFloat
        var viewHeight: CGFloat
        var insetTop: CGFloat
        var insetBottom: CGFloat
        /// "end", or the row being read and how far below the top bar it's held.
        var anchor: String
        var rows: Int
        var visibleRows: Int
        /// The last swipe to quote or reuse a message (`TranscriptCell.SwipeTrace`).
        var swipe: TranscriptCell.SwipeTrace?
    }

    var diagnostics: Diagnostics? {
        guard let collectionView else { return nil }
        let anchor: String
        switch self.anchor {
        case .end: anchor = "end"
        case .row(let item, let fromTop): anchor = "row \(String(describing: item).prefix(24)) at \(Int(fromTop))"
        }
        return Diagnostics(
            offset: collectionView.contentOffset.y.rounded(),
            contentHeight: collectionView.contentSize.height.rounded(),
            viewHeight: collectionView.bounds.height.rounded(),
            insetTop: collectionView.contentInset.top.rounded(),
            insetBottom: collectionView.contentInset.bottom.rounded(),
            anchor: anchor,
            rows: dataSource.snapshot().numberOfItems,
            visibleRows: collectionView.indexPathsForVisibleItems.count,
            swipe: TranscriptCell.lastSwipe)
    }
}
#endif
