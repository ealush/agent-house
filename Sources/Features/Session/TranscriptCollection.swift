import SwiftUI
import UIKit

// The transcript on a UIKit collection view (Settings → Appearance → New transcript). The rows
// are the same SwiftUI views as `TranscriptView`'s, each in a cell; what's new is who decides
// where the transcript sits. One anchor does, the end or a row you're reading, and every layout
// puts the view there before it's drawn: no scroll view guessing at a lazy stack's heights, no
// follow scrolling a frame later, nothing pulling against anything else.

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
    /// A new copy from the host (or a rotated transcript): laid out afresh, held where it was.
    var epoch = 0
    var linked: String?
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
    var loadingOlder = false
    /// Reading message by message from the keyboard: the transcript holds its focus.
    var browsing = false
    /// The message a link opened, marked for a moment.
    var linked: String?
    @ObservationIgnored weak var controller: TranscriptController?
}

struct TranscriptCollection: View {
    @Bindable var session: SessionModel
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scroll = TranscriptScroll()
    /// The whole screen the transcript goes under, and the part of it the bars (the navigation
    /// bar, the composer, the keyboard) leave clear: the collection view keeps its rows inside it.
    @State private var whole = CGRect.zero
    @State private var clear = CGRect.zero
    @FocusState private var browseFocused: Bool
    private var insets: EdgeInsets {
        guard !whole.isEmpty, !clear.isEmpty else { return EdgeInsets() }
        return EdgeInsets(top: max(0, clear.minY - whole.minY), leading: 0, bottom: max(0, whole.maxY - clear.maxY), trailing: 0)
    }

    private var focused: Bool { scene.app.preferences.focusMode && !session.stepsShown }
    private var shownBlocks: [FeedBlock] { focused ? session.focusedBlocks : session.blocks }

    var body: some View {
        let blocks = shownBlocks
        let content = TranscriptContent(
            blocks: blocks,
            ends: session.turnEnds,
            outgoing: session.outgoing,
            working: session.working ? .init(detail: session.row?.dto.detail, queued: session.queue.items.count, hardwareKeyboard: scene.hardwareKeyboard, steps: scene.app.preferences.focusMode ? session.stepsShown : nil) : nil,
            hasOlder: session.feed.hasOlder,
            loadingOlder: scroll.loadingOlder,
            stepsHidden: scene.app.preferences.stepsHidden,
            epoch: session.feed.epoch,
            linked: scroll.linked,
            live: session.feed.status == .live,
            ask: AskRow.shows(session)
        )
        ZStack {
            TranscriptCollectionHost(session: session, scene: scene, scroll: scroll, content: content, insets: insets, theme: theme, hostFiles: hostFiles)
                // Measured inside: what's measured outside is the frame the bars leave clear.
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { whole = $0 }
                .ignoresSafeArea()
            Color.clear
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { clear = $0 }
        }
            .overlay { status(blocks) }
            .overlay(alignment: .bottom) {
                // Animated here alone: on the whole transcript, leaving the end handed the
                // animation to every row that changed with it (a page going in), and they grew
                // into their new heights frame by frame, each frame measured again.
                ZStack {
                if !scroll.atBottom && !blocks.isEmpty && !session.composer.floats {
                    Button {
                        Haptics.selection()
                        scroll.controller?.toEnd(animated: true)
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(scroll.unseen ? .white : theme.text2)
                            .frame(width: 40, height: 40)
                            .glassEffect(scroll.unseen ? .regular.tint(theme.accentStrong).interactive() : .regular.interactive(), in: Circle())
                            .touchTarget()
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 10)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel(scroll.unseen ? "Jump to the newest message, new output" : "Jump to the newest message")
                }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: scroll.atBottom)
            }
            .overlay(alignment: .top) {
                if session.feed.status == .connecting, !blocks.isEmpty {
                    CatchingUp().padding(.top, 8)
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
                            scroll.controller?.show(seq: seq, mark: false)
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
                        scroll.controller?.show(seq: seq, mark: false)
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

    /// A fresh conversation, a transcript on its way or none to show (as `TranscriptView` says).
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
    let insets: EdgeInsets
    let theme: Theme
    let hostFiles: HostFiles?

    func makeUIViewController(context: Context) -> TranscriptController {
        TranscriptController(session: session, scene: scene, scroll: scroll)
    }

    func updateUIViewController(_ controller: TranscriptController, context: Context) {
        controller.theme = theme
        controller.hostFiles = hostFiles
        controller.reduceMotion = context.environment.accessibilityReduceMotion
        // The keyboard and the composer move in SwiftUI's animation; the rows follow in it.
        context.animate {
            controller.setInsets(top: insets.top, bottom: insets.bottom)
        }
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

    init(session: SessionModel, scene: SceneModel, scroll: TranscriptScroll) {
        self.session = session
        self.scene = scene
        self.scroll = scroll
        super.init(nibName: nil, bundle: nil)
        scroll.controller = self
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

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
        }
        dataSource = UICollectionViewDiffableDataSource(collectionView: collectionView) { collectionView, indexPath, item in
            collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: item)
        }

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        collectionView.addGestureRecognizer(tap)

        if let seq = scene.scrollAnchors[session.key]?.seq {
            restoreSeq = seq
        }
    }

    /// A place to come back to, held until its row is in the transcript.
    private var restoreSeq: Int?

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
                    let marked = content.linked == block.id ? 0.14 : browsing == index ? 0.08 : 0
                    VStack(alignment: .leading, spacing: 18) {
                        BlockRow(block: block, session: session, scene: scene, stepsHidden: content.stepsHidden, isLast: index == content.blocks.count - 1)
                            .padding(.horizontal, 2)
                            .background(marked > 0 ? theme.accent.opacity(marked) : .clear, in: RoundedRectangle(cornerRadius: 12))
                        if let seconds = content.ends[block.id] {
                            TurnFooter(seconds: seconds)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            case .outgoing(let id):
                if let item = content.outgoing.first(where: { $0.id == id }) {
                    VStack(alignment: .trailing, spacing: 6) {
                        UserBubble(text: item.text, pending: !item.waitingOn.isEmpty ? nil : item.state == .sending ? "Sending…" : "Sent")
                        if !item.waitingOn.isEmpty { UploadBar(outbox: session.outbox, item: item) }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    // Springs up out of the box it was typed in.
                    .modifier(Arrival(style: .spring, active: arrives, reduceMotion: reduceMotion))
                }
            case .working:
                if let working = content.working {
                    WorkingRow(detail: working.detail, queued: working.queued, hardwareKeyboard: working.hardwareKeyboard, steps: working.steps) { [weak self, session] in
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
        .environment(\.rowWillResize) { [weak self] in self?.willResize(item) }
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
        collectionView.keyboardDismissMode = scene.hardwareKeyboard ? .none : .onDrag
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
            if let was = oldBlocks[item(block.id)], was.0 == block, was.1 == last, old.ends[block.id] == new.ends[block.id], (old.linked == block.id) == (new.linked == block.id) { continue }
            changed.append(item(block.id))
        }
        for item in new.outgoing where oldItems.contains(.outgoing(item.id)) && old.outgoing.first(where: { $0.id == item.id }) != item {
            changed.append(.outgoing(item.id))
        }
        if oldItems.contains(.working), new.working != nil, old.working != new.working || old.blocks.last?.id != new.blocks.last?.id { changed.append(.working) }
        if oldItems.contains(.older), new.hasOlder, old.loadingOlder != new.loadingOlder { changed.append(.older) }
        snapshot.reconfigureItems(changed)

        // What you send, and the agent setting to work on it, come in moving; the transcript
        // arriving (or a new copy of it) is simply there.
        if !old.blocks.isEmpty || !old.outgoing.isEmpty || new.blocks.isEmpty {
            for item in new.outgoing where !oldItems.contains(.outgoing(item.id)) { arriving.insert(.outgoing(item.id)) }
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
        go(animated: animated)
    }

    /// The block holding `seq` at the top, marked a moment if a link opened it.
    func show(seq: Int, mark: Bool) {
        guard let block = content.blocks.first(where: { $0.seq == seq }) ?? content.blocks.last(where: { $0.seq <= seq }) else { return }
        anchor = .row(item(block.id), 0)
        go(animated: !mark)
        guard mark else { return }
        scroll.linked = block.id
        Task { [scroll] in
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.easeOut(duration: 0.6)) { scroll.linked = nil }
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

    // MARK: Taps

    @objc private func tapped() {
        // A tap on the conversation folds what floats over it, as it puts the keyboard away.
        if session.composer.trayOpen {
            withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { session.composer.trayOpen = false }
        }
        // Words selected in a reply let go, as a page's do when you tap away from them.
        UIApplication.shared.sendAction(#selector(ProseTextView.dropSelection), to: nil, from: nil, for: nil)
        guard !scene.hardwareKeyboard, scene.composerFocused != nil else { return }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
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

/// A row: as tall as the layout says (what its content last measured), never sized by UIKit.
/// Measured by UIKit, a reused cell was measured before its content had caught up, and took
/// another row's height for a pass.
final class TranscriptCell: UICollectionViewCell {
    /// The row it shows now.
    var item: TranscriptItem?

    override func preferredLayoutAttributesFitting(_ attributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
        attributes
    }
}
