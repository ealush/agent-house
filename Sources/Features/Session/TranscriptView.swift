import SwiftUI
import UIKit

/// The GUI view of a session: the agent's structured transcript (never its terminal screen),
/// your optimistic messages until the transcript has them, and live state at the bottom.
struct TranscriptView: View {
    @Bindable var session: SessionModel
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var topID: String?
    @State private var browsing: Int?
    /// The message a link opened, marked for a moment.
    @State private var linked: String?
    @State private var loadingOlder = false
    /// Within half a screen of the top: the page before is read in on the way there. Read from
    /// where the view is scrolled to, which a page held in place moves too; the button's own
    /// visibility followed only your scrolling, so after a page went in it still read as on
    /// screen, and scrolling back up to it read in nothing more.
    @State private var nearTop = false
    /// The row at the top as an older page was asked for: it stays there as the page goes in
    /// above it. Held by the end, the view went to the new page's top, your place lost.
    @State private var holdAt: String?
    /// Older pages are going in above: the end holds still, so what you read does too.
    @State private var prepending = false
    /// At the newest message (within a few points of the end): new content keeps it in view,
    /// and coming back opens there rather than where the top of the screen was.
    @State private var atBottom = true
    /// The agent wrote more while you were scrolled back: the way down says so.
    @State private var unseen = false
    /// What the scroll is doing: only a finger (or a scroll it started) leaves the end.
    @State private var phase: ScrollPhase = .idle
    /// How far the end lies below what's in view, as of the last layout.
    @State private var belowEnd: CGFloat = 0
    /// The room the conversation had at the last layout (the keyboard and bar take from it).
    @State private var room: CGFloat = 0
    /// All of the conversation fits in its room, and the scroll view itself sits it down by the
    /// composer. A scroll to the end then took it past there, off the screen, and the scroll
    /// view's anchor and the follow threw it back and forth between the two on every frame
    /// after (your first message vanishing as the transcript came in), so it isn't scrolled.
    @State private var fits = true
    /// How far a drag has taken the conversation back from the end.
    @State private var awayBy: CGFloat = 0
    @State private var resizedInDrag = false
    @State private var following = TranscriptEnd.Follow()
    @FocusState private var browseFocused: Bool

    private var stepsHidden: Bool { scene.app.preferences.stepsHidden }
    /// Focus mode, the steps not asked for: only what's said shows.
    private var focused: Bool { scene.app.preferences.focusMode && !session.stepsShown }
    /// What the transcript shows: every block, or in focus mode those with something said.
    private var shownBlocks: [FeedBlock] { focused ? session.focusedBlocks : session.blocks }

    /// What only the newest end changes: its last block, what that holds, a turn starting or
    /// ending. Older pages loading above (a scroll back reads them in) leave it as it was.
    static func endKey(_ blocks: [FeedBlock], session: SessionModel) -> String {
        let tail = blocks.last
        var items = 0
        if case .agent(_, _, _, let parts) = tail { items = parts.count }
        return "\(tail?.id ?? "")|\(items)|\(tail?.text.count ?? 0)|\(session.working)"
    }

    /// Reads in the page before the oldest, holding the end still meanwhile (and a moment
    /// after, while the page lays out) so what's in view stays put.
    ///
    /// Still near the top once it's in, the next: a long turn's steps fold into a line, so a
    /// page of them may not take you away from it. A few (`run`), so a page that didn't lay
    /// out as it should can't read in the whole transcript.
    private func loadOlder(run: Int = 0) {
        // Not while the last is going in: it shows the new page's top until it's held in place.
        guard !loadingOlder, !prepending else { return }
        holdAt = topID
        loadingOlder = true
        prepending = true
        Task {
            let more = await session.loadOlder()
            loadingOlder = false
            try? await Task.sleep(for: .milliseconds(400))
            prepending = false
            holdAt = nil
            if more, nearTop, run < 3 { loadOlder(run: run + 1) }
        }
    }

    /// Off to somewhere earlier in the conversation, by a link, the rail or the keyboard: no
    /// longer at the end, so what the agent writes meanwhile leaves you there.
    private func leaveEnd() {
        atBottom = false
    }

    /// Back to the newest message, and staying there.
    private func toEnd(_ reader: ScrollViewProxy, animated: Bool = true) {
        atBottom = true
        unseen = false
        guard !fits else { return }
        // Smooth, not snappy: a scroll that overshot and settled back read as one more jolt.
        withAnimation(animated && !reduceMotion ? .smooth(duration: 0.35) : nil) { reader.scrollTo("bottom", anchor: .bottom) }
    }

    /// Where the end is now, and what that means: in view is at the end; out of view leaves
    /// it only by a scroll. Anything else that moved it (the bar or keyboard rising, a row
    /// growing, a menu's lift) is put right in the same pass, before it's drawn.
    private func endMoved(_ reading: TranscriptEnd.Reading, _ reader: ScrollViewProxy) {
        let below = reading.below
        // The room for the conversation changed (the keyboard going away as a drag began, the
        // bar growing): that moved the end, but nobody scrolled.
        let resized = abs(reading.room - room) > 0.5
        room = reading.room
        if fits != reading.fits { fits = reading.fits }
        // How far the finger has taken the conversation back from the end in this drag: what
        // the end's distance grew by, over layouts where the room stayed the same. A resize
        // moves it, and so does the scroll view holding the end to the bottom after one (the
        // offset shifting a keyboard's height); neither is anyone scrolling, and holding the
        // end leaves its distance as it was.
        if !resized { awayBy += below - belowEnd }
        belowEnd = below
        if below <= TranscriptEnd.slack {
            if !atBottom { atBottom = true }
            if unseen { unseen = false }
            if scene.scrollAnchors[session.key] != SceneSnapshot.ScrollAnchor(seq: nil, offset: 0) {
                scene.scrollAnchors[session.key] = SceneSnapshot.ScrollAnchor(seq: nil, offset: 0)
            }
        }
        if phase == .interacting || phase == .decelerating {
            // Only a scroll leaves the end. Counted as one, a drag that put the keyboard away
            // (the room growing a keyboard's height under the finger) left it, and the
            // conversation, held by its top from then on, was thrown far back from the end.
            // A drag that put the keyboard away (the room growing under the finger) is taken for
            // that unless it goes on well past it: a short one to put the keyboard away isn't
            // reading back, a long one is.
            if resized { resizedInDrag = true }
            let away = resizedInDrag ? TranscriptEnd.slack * 3 : TranscriptEnd.slack
            if atBottom, awayBy > away, below > TranscriptEnd.slack { atBottom = false }
            return
        }
        if atBottom, phase == .idle, below > 1, session.pendingMessage == nil, linked == nil, browsing == nil {
            following.correct { reader.scrollTo("bottom", anchor: .bottom) }
        }
        // Past the end: the conversation got shorter under the view (a reconnect's copy without
        // the older pages read in, rows measured again smaller), and what's in view is the
        // empty space below it. Back to the end, or the screen stayed blank until a drag.
        if phase == .idle, below < -1, session.pendingMessage == nil, linked == nil {
            following.correct { reader.scrollTo("bottom", anchor: .bottom) }
        }
    }

    var body: some View {
        let blocks = shownBlocks
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if session.feed.hasOlder {
                        Button {
                            loadOlder()
                        } label: {
                            Label(loadingOlder ? "Loading…" : "Earlier messages", systemImage: "arrow.up")
                                .font(.ah(.footnote))
                        }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                        // Not read while the stream caught up: once it has, if the top is still
                        // near after the copy it sent is laid out (it often pushes this far up).
                        .onChange(of: session.feed.status == .live) { _, live in
                            guard live else { return }
                            Task {
                                try? await Task.sleep(for: .milliseconds(300))
                                if nearTop { loadOlder() }
                            }
                        }
                    }
                    let ends = session.turnEnds
                    ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                        BlockRow(block: block, session: session, scene: scene, stepsHidden: stepsHidden, isLast: index == blocks.count - 1)
                            .id(block.id)
                            .padding(.horizontal, 2)
                            .background(browsing == index || linked == block.id ? theme.accent.opacity(linked == block.id ? 0.14 : 0.08) : .clear, in: RoundedRectangle(cornerRadius: 12))
                        if let seconds = ends[block.id] {
                            TurnFooter(seconds: seconds)
                        }
                    }
                    ForEach(session.outgoing) { item in
                        VStack(alignment: .trailing, spacing: 6) {
                            UserBubble(text: item.text, pending: !item.waitingOn.isEmpty ? nil : item.state == .sending ? "Sending…" : "Sent")
                            // Sent before its attachments were up: it goes once they are.
                            if !item.waitingOn.isEmpty { UploadBar(outbox: session.outbox, item: item) }
                        }
                            .id("out-\(item.id)")
                            // Springs up out of the box it was typed in.
                            .transition(reduceMotion ? .opacity : .asymmetric(insertion: .scale(scale: 0.85, anchor: .bottomTrailing).combined(with: .opacity).combined(with: .offset(y: 24)), removal: .opacity))
                    }
                    if session.working {
                        // A new turn (the newest message you sent) starts the clock again.
                        WorkingRow(detail: session.row?.dto.detail, queued: session.queue.items.count, hardwareKeyboard: scene.hardwareKeyboard,
                                   steps: scene.app.preferences.focusMode ? session.stepsShown : nil) {
                            withAnimation(.snappy) { session.stepsShown.toggle() }
                        }
                            .id("working-" + (blocks.last { if case .user = $0 { return true } else { return false } }?.id ?? ""))
                    }
                    // What it asks you, last, just above the composer: part of the page.
                    if AskRow.shows(session) {
                        AskRow(session: session, scene: scene)
                            .id("ask")
                            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    }
                    // The very end, margin and all: scrolled to, nothing is left below it.
                    Color.clear.frame(height: 1).padding(.bottom, 11).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                // A readable column on a wide screen, centered; the scroll view stays full width.
                .frame(maxWidth: SessionScreen.readableWidth)
                .frame(maxWidth: .infinity)
                .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.3), value: session.outgoing.map(\.id))
                .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: session.working)
                .animation(reduceMotion ? nil : .snappy(duration: 0.32), value: AskRow.shows(session))
                .scrollTargetLayout()
            }
            // A question coming in at the end: its top in view (a long form starts at its first
            // question; a short one is simply the end).
            .onChange(of: AskRow.shows(session)) { _, shows in
                guard shows, atBottom else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    withAnimation(reduceMotion ? nil : .snappy) { reader.scrollTo("ask", anchor: .top) }
                }
            }
            // One rule for where the transcript sits, so nothing fights over it: it opens at the
            // newest message, a short one sits down by the composer, and when anything changes
            // size (a step arriving, a row opening, the composer or keyboard rising, a menu's
            // lift) the end stays put while you're at it — and what you're reading stays put
            // while you're not (older pages going in above hold the end too, so it doesn't
            // move either). Bound to the top row as well, the scroll view held that row still
            // as the end was being followed, and the two shook the transcript between them.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .defaultScrollAnchor(atBottom || prepending ? .bottom : .top, for: .sizeChanges)
            // The row at the top, for coming back to it (read, never steered).
            .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.01) { ids in
                let top = ids.first { id in blocks.contains { $0.id == id } }
                if top != topID { topID = top }
            }
            // A fresh scroll view when the transcript arrives in an empty view (or the host
            // sends a new copy): the bottom anchor only holds for content there from the start,
            // and a long transcript poured into an empty lazy list was laid out but not drawn.
            .id(blocks.isEmpty ? -1 : session.feed.epoch)
            // …and once it has settled, onto the newest message again: with a long transcript
            // the first layout's guesses move it, and what's drawn can sit apart from it.
            // Every snapshot, a reconnect's too: the transcript is replaced under the same scroll
            // view (from the page this device kept to the host's longer copy, on coming back),
            // and a long one poured in above was laid out but not drawn, with nothing after it.
            .task(id: blocks.isEmpty ? "-" : "\(session.feed.epoch)/\(session.feed.snapshots)") {
                // A place to come back to holds the transcript there, if it's in this transcript.
                let anchored = scene.scrollAnchors[session.key]?.seq.map { seq in blocks.contains { $0.seq == seq } } ?? false
                guard !blocks.isEmpty, !anchored else { return }
                for delay in [150, 600] {
                    try? await Task.sleep(for: .milliseconds(delay))
                    // A link to a message holds the transcript there instead, as a scroll back does.
                    guard atBottom, !fits, session.pendingMessage == nil, linked == nil else { return }
                    reader.scrollTo("bottom", anchor: .bottom)
                }
            }
            // A link to a message: once the transcript is here, page back to it, bring it to the
            // top and mark it a moment (the block that holds it, when it's inside a turn).
            .task(id: "\(session.pendingMessage ?? -1)/\(blocks.isEmpty)") {
                guard let seq = session.pendingMessage, !blocks.isEmpty else { return }
                defer { session.pendingMessage = nil }
                guard await session.reveal(seq: seq) else {
                    scene.toast("That message isn’t in this transcript any more")
                    return
                }
                await Task.yield()
                let all = shownBlocks
                guard let block = all.first(where: { $0.seq == seq }) ?? all.last(where: { $0.seq <= seq }) else { return }
                leaveEnd()
                withAnimation(reduceMotion ? nil : .snappy) { reader.scrollTo(block.id, anchor: .top) }
                linked = block.id
                try? await Task.sleep(for: .seconds(2))
                withAnimation(.easeOut(duration: 0.6)) { linked = nil }
            }
            // The composer isn't the keyboard's accessory (as Messages' field is), so an
            // interactive dismissal only began once a drag crossed the whole composer into the
            // keyboard: in practice the keyboard couldn't be put away. Scrolling the transcript or
            // tapping it puts it away, as in chat apps. A hardware keyboard keeps the composer's
            // focus: there's nothing on screen to put away.
            .scrollDismissesKeyboard(scene.hardwareKeyboard ? .never : .immediately)
            // Back to reading: the composer's settings fold out of the way, as the keyboard does.
            .onScrollPhaseChange { old, new in
                phase = new
                if new == .interacting, old == .idle {
                    awayBy = 0
                    resizedInDrag = false
                    // Pulling at the top for more: a few pages of a long turn's steps fold into
                    // a line, and the top never stopped being near for the next to be read.
                    if nearTop, session.feed.hasOlder { loadOlder() }
                }
                // Let go at the end with the end moved meanwhile (the keyboard going away under
                // the finger): back to it, as nothing scrolled it away.
                if new == .idle, atBottom, belowEnd > 1, session.pendingMessage == nil, linked == nil, browsing == nil {
                    following.correct { reader.scrollTo("bottom", anchor: .bottom) }
                }
                guard new == .interacting, session.composer.trayOpen else { return }
                withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { session.composer.trayOpen = false }
            }
            .simultaneousGesture(TapGesture().onEnded {
                // A tap on the conversation folds what floats over it, as it puts the keyboard away.
                if session.composer.trayOpen {
                    withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { session.composer.trayOpen = false }
                }
                // Words selected in a reply let go, as a page's do when you tap away from them.
                UIApplication.shared.sendAction(#selector(ProseTextView.dropSelection), to: nil, from: nil, for: nil)
                guard !scene.hardwareKeyboard, scene.composerFocused != nil else { return }
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            })
            .overlay {
                // A live agent that hasn't written anything yet is a fresh conversation, not a
                // missing GUI: say what's ready and offer a start.
                let fresh = session.isLive && !session.isShell && session.outgoing.isEmpty && blocks.isEmpty
                switch session.feed.status {
                case .unavailable where session.isLive && !session.isShell && session.feed.reason == "no-transcript":
                    // Once you've sent something, your message and the working row say what's
                    // happening: the transcript is on its way, nothing is missing.
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
            .onChange(of: topID) { _, id in
                // The restoration anchor: the block at the top of the screen, or none at the
                // newest message, so coming back there shows what came since.
                // Written only when it moves: every write told every transcript on screen to draw.
                let seq = atBottom ? nil : id.flatMap { key in blocks.first { $0.id == key }?.seq }
                let anchor = SceneSnapshot.ScrollAnchor(seq: seq, offset: 0)
                if scene.scrollAnchors[session.key] != anchor { scene.scrollAnchors[session.key] = anchor }
            }
            // Nearing the top, not merely made: a lazy list makes rows a screen or so ahead, and a
            // short first page made the button at the top on opening, which read in a page
            // nobody scrolled back for.
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top < geometry.containerSize.height / 2
            } action: { _, near in
                nearTop = near
                if near, session.feed.hasOlder { loadOlder() }
            }
            // Following the conversation: at the newest message, what the agent writes (and
            // what you send) stays in view, as in any chat; scrolled back to read, it leaves you
            // where you are.
            .onScrollGeometryChange(for: TranscriptEnd.Reading.self) { geometry in
                TranscriptEnd.Reading(geometry)
            } action: { _, reading in
                endMoved(reading, reader)
            }
            // An older page went in above: what was at the top stays there, in the same pass.
            .onChange(of: blocks.first?.id) { _, _ in
                guard let id = holdAt else { return }
                holdAt = nil
                reader.scrollTo(id, anchor: .top)
                // …and again once the lazy list has laid the page out: the first went before
                // it had, and its layout left the view at the new page's top.
                DispatchQueue.main.async { reader.scrollTo(id, anchor: .top) }
            }
            // What you send is what you look at next.
            .onChange(of: session.outgoing.map(\.id)) { old, new in
                guard new.count > old.count else { return }
                toEnd(reader)
            }
            // Scrolled back, more at the end is news (the transcript first arriving isn't).
            .onChange(of: Self.endKey(blocks, session: session)) { old, _ in
                if !atBottom, !old.hasPrefix("|") { unseen = true }
            }
            .onAppear {
                if let seq = scene.scrollAnchors[session.key]?.seq, let block = blocks.first(where: { $0.seq == seq }) {
                    leaveEnd()
                    reader.scrollTo(block.id, anchor: .top)
                }
            }
            .onChange(of: scene.focusRequest) { _, request in
                guard let request else { return }
                switch request.target {
                case .latest(let key) where key == session.key:
                    toEnd(reader)
                case .messages(let key) where key == session.key:
                    browsing = blocks.indices.last
                    browseFocused = true
                case .turn(let key, let seq) where key == session.key:
                    Task {
                        guard await session.reveal(seq: seq) else {
                            scene.toast("That turn isn’t in this transcript any more")
                            return
                        }
                        // Let the newly loaded pages lay out, then bring the turn to the top.
                        await Task.yield()
                        if let block = shownBlocks.first(where: { $0.seq == seq }) {
                            leaveEnd()
                            withAnimation(.snappy) { reader.scrollTo(block.id, anchor: .top) }
                        }
                    }
                default:
                    break
                }
            }
            .focusable(browsing != nil)
            .focused($browseFocused)
            .onKeyPress(phases: .down) { press in
                guard let current = browsing else { return .ignored }
                switch press.key {
                case .upArrow, KeyEquivalent("k"):
                    browsing = max(0, current - 1)
                case .downArrow, KeyEquivalent("j"):
                    browsing = min(blocks.count - 1, current + 1)
                case KeyEquivalent("c"):
                    UIPasteboard.general.string = blocks[current].text
                    scene.toast("Copied the message")
                case KeyEquivalent("r"):
                    session.restoreRequest = blocks[current].text
                    session.panel = .snapshots
                case .escape:
                    browsing = nil
                    scene.requestFocus(.composer(session.key))
                    return .handled
                default:
                    return .ignored
                }
                if let index = browsing {
                    leaveEnd()
                    withAnimation(.snappy) { reader.scrollTo(blocks[index].id, anchor: .center) }
                }
                return .handled
            }
            // Read back up the conversation, the way to its newest message floats over the
            // composer: a glass ↓, there only while you're away from the end.
            .overlay(alignment: .bottom) {
                // Not while something floats there from the composer: they'd sit on each other.
                if !atBottom && !blocks.isEmpty && !session.composer.floats {
                    Button {
                        Haptics.selection()
                        toEnd(reader)
                    } label: {
                        // Pink while there's more you haven't seen, as the rest of what's new is.
                        Image(systemName: "arrow.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(unseen ? .white : theme.text2)
                            .frame(width: 40, height: 40)
                            .glassEffect(unseen ? .regular.tint(theme.accentStrong).interactive() : .regular.interactive(), in: Circle())
                            .touchTarget()
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 10)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                    .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: unseen)
                    .accessibilityLabel(unseen ? "Jump to the newest message, new output" : "Jump to the newest message")
                }
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: atBottom)
            // What's shown is this device's copy (or the newest few entries) while the host's
            // catches up: say so, or it read as all there was.
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
                            toEnd(reader)
                            return
                        }
                        Task {
                            guard await session.reveal(seq: seq) else { return }
                            await Task.yield()
                            if let block = shownBlocks.first(where: { $0.seq == seq }) {
                                leaveEnd()
                                withAnimation(.snappy) { reader.scrollTo(block.id, anchor: .top) }
                            }
                        }
                    }
                }
            }
        }
        .background(theme.surface)
    }
}

/// A glass pill at the top of the transcript while the host's copy is on its way, there once
/// the wait is long enough to notice (a quick link never shows it).
struct CatchingUp: View {
    @State private var shown = false
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Catching up").font(.ah(.footnote)).foregroundStyle(theme.text2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: Capsule())
        .opacity(shown ? 1 : 0)
        .scaleEffect(shown || reduceMotion ? 1 : 0.9)
        .accessibilityElement(children: .combine)
        .accessibilityHidden(!shown)
        .task {
            try? await Task.sleep(for: .milliseconds(800))
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { shown = true }
        }
    }
}

/// The conversation's outline (`web/gui/MessageRail.tsx`): one tick per message you sent on
/// the transcript's leading edge; the bright one is the turn in view. Tap a tick, or press
/// and slide like an iPhone's section index, to go there. Past fifteen it's a window that
/// follows the reading, faded where more lie beyond.
struct MessageRail: View {
    let items: [RailItem]
    let active: Int
    let jump: (RailItem) -> Void
    @State private var hover: Int?
    @State private var scrub: Int?
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let pitch: CGFloat = 12

    var body: some View {
        let range = FeedProjection.railRange(count: items.count, lead: scrub ?? active)
        let tip = scrub ?? hover
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(range), id: \.self) { i in
                Capsule()
                    .fill(i == active ? theme.accent : theme.faint.opacity(i == tip ? 0.95 : 0.55))
                    .frame(width: i == active || i == tip ? 14 : 8, height: 2.5)
                    .frame(width: 26, height: pitch, alignment: .leading)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { hover = i } else if hover == i { hover = nil }
                    }
                    .accessibilityElement()
                    .accessibilityLabel("Message \(i + 1) of \(items.count): \(String(items[i].text.prefix(120)))")
                    .accessibilityAddTraits(i == active ? [.isButton, .isSelected] : .isButton)
                    .accessibilityAction { jump(items[i]) }
            }
        }
        .padding(.vertical, 4)
        .mask {
            LinearGradient(stops: [
                .init(color: range.lowerBound > 0 ? .clear : .black, location: 0),
                .init(color: .black, location: 0.12),
                .init(color: .black, location: 0.88),
                .init(color: range.upperBound < items.count ? .clear : .black, location: 1),
            ], startPoint: .top, endPoint: .bottom)
        }
        .overlay(alignment: .topLeading) {
            if let tip, range.contains(tip) {
                Text(preview(items[tip].text))
                    .font(.ah(.caption))
                    .lineLimit(2)
                    .frame(maxWidth: 260, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(theme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
                    .offset(x: 30, y: 4 + CGFloat(tip - range.lowerBound) * pitch - 10)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
            let i = range.lowerBound + Int((value.location.y - 4) / pitch)
            scrub = min(items.count - 1, max(0, i))
        }.onEnded { _ in
            if let scrub { jump(items[scrub]) }
            scrub = nil
        })
        .animation(reduceMotion ? nil : .snappy(duration: 0.15), value: active)
        .padding(.leading, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your messages")
    }

    private func preview(_ text: String) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.isEmpty ? "Attachment" : flat
    }
}

struct BlockRow: View {
    let block: FeedBlock
    let session: SessionModel
    let scene: SceneModel
    let stepsHidden: Bool
    let isLast: Bool
    @Environment(\.theme) private var theme

    var body: some View {
        switch block {
        case .user(_, _, let at, let parts):
            let text = parts.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined(separator: "\n")
            UserBubble(text: text, at: at, media: parts)
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                    LinkButtons(place: messagePlace, scene: scene)
                    if session.isLive {
                        Button("Edit & Send Again", systemImage: "pencil") {
                            session.composer.compose(text)
                            Haptics.tap()
                        }
                        Button("Send Again", systemImage: "arrow.clockwise") {
                            session.composer.compose(text)
                            session.composer.submit(working: session.working)
                            Haptics.tap()
                        }
                        if !session.isShell {
                            Divider()
                            Button("Restore Files from Before This…", systemImage: "clock.arrow.circlepath") {
                                session.restoreRequest = text
                                session.panel = .snapshots
                            }
                        }
                    }
                }
        case .agent(_, _, _, let items):
            VStack(alignment: .leading, spacing: 12) {
                ForEach(items) { item in
                    switch item {
                    case .part(_, let part):
                        if part.isWords {
                            // The reply's words select under a finger (press, hold, drag); the
                            // message's actions join their edit menu instead of a context menu,
                            // which would take the press first. VoiceOver keeps them as actions.
                            PartView(part: part, session: session, stepsHidden: stepsHidden, answered: !isLast)
                                .environment(\.textMenu, wordsMenu)
                                .accessibilityActions { agentMenu }
                        } else {
                            PartView(part: part, session: session, stepsHidden: stepsHidden, answered: !isLast)
                                .contextMenu { agentMenu }
                        }
                    case .tools(_, let calls):
                        ToolGroupView(calls: calls, session: session, stepsHidden: stepsHidden)
                            .contextMenu { agentMenu }
                    }
                }
            }
        case .notice(_, _, _, let kind, let text):
            HStack(spacing: 8) {
                Image(systemName: kind == .compacted ? "arrow.down.right.and.arrow.up.left" : kind == .interrupted ? "stop.circle" : "info.circle")
                Text(text)
            }
            .font(.ah(.footnote))
            .foregroundStyle(theme.muted)
            .frame(maxWidth: .infinity)
        }
    }
}

extension BlockRow {
    /// This message, as a link names it: the session's GUI at the block's first entry.
    fileprivate var messagePlace: Place { Place(.session(session.key), message: block.seq) }

    /// The agent's message, on a long press of its steps, pictures and widgets.
    @ViewBuilder fileprivate var agentMenu: some View {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = block.text }
        LinkButtons(place: messagePlace, scene: scene)
        if session.isLive && block.hasText {
            Button("Quote in Reply", systemImage: "text.quote") {
                session.composer.compose(Markdown.quote(block.text, limit: 12))
                Haptics.tap()
            }
        }
    }

    /// After Copy in the edit menu of words selected in the agent's message: quoting just
    /// those words, and the message's own actions folded under one item.
    fileprivate var wordsMenu: TextMenu {
        // The message's text is joined up when an item is picked, not each time the row draws.
        let (session, scene, block, place) = (session, scene, block, messagePlace)
        return TextMenu { selected in
            var items: [UIMenuElement] = []
            if session.isLive {
                items.append(UIAction(title: "Quote in Reply", image: UIImage(systemName: "text.quote")) { _ in
                    session.composer.compose(Markdown.quote(Markdown.source(ofSelected: selected)))
                    Haptics.tap()
                })
            }
            items.append(UIMenu(title: "Message", image: UIImage(systemName: "text.bubble"), children: [
                UIAction(title: "Copy Message", image: UIImage(systemName: "doc.on.doc")) { _ in UIPasteboard.general.string = block.text },
                UIAction(title: "Copy Link", image: UIImage(systemName: "link")) { _ in scene.copyLink(to: place) },
                UIAction(title: "Share Link…", image: UIImage(systemName: "square.and.arrow.up")) { _ in scene.shareLink(to: place) },
            ]))
            return items
        }
    }
}

/// Copy Link and Share Link for a place, in a context menu.
struct LinkButtons: View {
    let place: Place
    let scene: SceneModel

    var body: some View {
        Button("Copy Link", systemImage: "link") { scene.copyLink(to: place) }
        Button("Share Link…", systemImage: "square.and.arrow.up") { scene.shareLink(to: place) }
    }
}

/// A message sent before its attachments were up, under its bubble: how far they've got. It
/// goes once they're all there; meanwhile you can go anywhere, even put the app away.
struct UploadBar: View {
    let outbox: Outbox
    let item: Outbox.Item
    @Environment(\.theme) private var theme

    var body: some View {
        let fraction = outbox.progress(item) ?? 1
        let count = item.waitingOn.count
        VStack(alignment: .trailing, spacing: 4) {
            ProgressView(value: fraction)
                .tint(theme.accentStrong)
                .frame(width: 160)
            // Every byte out, the host's answer still to come: it isn't stuck at 100%.
            Text(fraction >= 0.995 ? "Finishing the upload" : "Uploading \(count == 1 ? "the attachment" : "\(count) attachments") · \(Int((fraction * 100).rounded()))%")
                .font(.ah(.caption2))
                .monospacedDigit()
                .foregroundStyle(theme.faint)
                .contentTransition(.numericText())
        }
        .animation(.spring(duration: 0.35, bounce: 0), value: fraction)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Uploading, \(Int((fraction * 100).rounded())) percent")
    }
}

/// Your message: right-aligned, with what you attached drawn as attachments.
struct UserBubble: View {
    let text: String
    var at: Double? = nil
    var pending: String? = nil
    var media: [FeedPart] = []
    @Environment(\.theme) private var theme

    var body: some View {
        let split = Uploads.split(text)
        VStack(alignment: .trailing, spacing: 6) {
            if !split.uploads.isEmpty {
                HStack {
                    ForEach(split.uploads, id: \.path) { upload in
                        if upload.image {
                            HostImage(source: upload.path, alt: upload.name).frame(maxWidth: 160)
                        } else {
                            Label(upload.name, systemImage: "doc").font(.ah(.caption)).padding(8).background(theme.raised, in: Capsule())
                        }
                    }
                }
            }
            if !split.rest.isEmpty {
                // Your line breaks as you typed them: a new line in the box is one here too.
                MarkdownView(split.rest, compact: true, keepingLineBreaks: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    // ah's Message: your words on a raised card with a hairline.
                    .background(theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(theme.line, lineWidth: 1))
            }
            if let pending {
                Text(pending).font(.ah(.caption2)).foregroundStyle(theme.faint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
        .opacity(pending != nil ? 0.75 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(Uploads.summary(text))\(pending.map { ". \($0)" } ?? "")")
    }
}

private struct PartView: View {
    let part: FeedPart
    let session: SessionModel
    let stepsHidden: Bool
    /// A turn the conversation has moved past: its choices are history, not buttons.
    var answered = false
    @Environment(\.theme) private var theme
    @State private var showReasoning = false

    var body: some View {
        switch part {
        case .text(let text):
            MarkdownView(text)
        case .reasoning(let text):
            if !stepsHidden {
                // Folded like a tool step: what it thought about, a line of it, and the same
                // small chevron.
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { showReasoning.toggle() }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "brain").foregroundStyle(theme.faint)
                            Text("Thinking").foregroundStyle(theme.muted)
                            if !showReasoning {
                                Text(text.split(whereSeparator: \.isWhitespace).joined(separator: " "))
                                    .foregroundStyle(theme.faint)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.ah(.caption2)).foregroundStyle(theme.faint).rotationEffect(.degrees(showReasoning ? 90 : 0))
                        }
                        .font(.ah(.footnote))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .accessibilityLabel(showReasoning ? "Hide thinking" : "Show thinking")
                    if showReasoning {
                        MarkdownView(text, compact: true).foregroundStyle(theme.muted)
                            .padding(.leading, 12)
                            .overlay(alignment: .leading) { Rectangle().fill(theme.faint.opacity(0.3)).frame(width: 2) }
                            .transition(.opacity)
                    }
                }
            }
        case .media(_, let src, let alt):
            HostImage(source: src, alt: alt ?? "")
        case .widget(let widget):
            WidgetView(model: WidgetModel(widget), answered: answered, reply: { text in Task { await session.reply(text) } })
        case .notice(_, let text):
            Text(text).font(.ah(.footnote)).foregroundStyle(theme.muted)
        case .toolCall, .toolResult:
            EmptyView()
        case .unknown(let type):
            Text("Unsupported content (\(type))").font(.ah(.caption)).foregroundStyle(theme.faint)
        }
    }
}

/// A run of tool calls: its last few, or one line with steps hidden (never while one asks you).
private struct ToolGroupView: View {
    let calls: [ToolCall]
    let session: SessionModel
    let stepsHidden: Bool
    @State private var showAll = false
    @State private var unfolded = false
    @Environment(\.theme) private var theme
    @Environment(\.rowWillResize) private var rowWillResize

    var body: some View {
        let summary = ToolGroupSummary(calls: calls, results: session.feed.results, awaitingCall: session.awaitingCall, turnLive: session.turnLive)
        VStack(alignment: .leading, spacing: 6) {
            if stepsHidden && !summary.asking {
                Button {
                    rowWillResize?()
                    withAnimation(.snappy) { unfolded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        if summary.running { ProgressView().controlSize(.mini) }
                        Text(summary.foldedLabel)
                        Image(systemName: "chevron.right").rotationEffect(.degrees(unfolded ? 90 : 0))
                    }
                    .font(.ah(.footnote))
                    .foregroundStyle(summary.failed > 0 ? theme.danger : theme.muted)
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                if unfolded { rows(calls) }
            } else {
                let hidden = ToolGroupSummary.hiddenCount(total: calls.count, showAll: showAll)
                if hidden > 0 {
                    Button("\(hidden) earlier step\(hidden == 1 ? "" : "s")") {
                        rowWillResize?()
                        withAnimation(.snappy) { showAll = true }
                    }
                        .font(.ah(.footnote))
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .foregroundStyle(theme.muted)
                }
                rows(Array(calls.suffix(calls.count - hidden)))
            }
        }
    }

    @ViewBuilder
    private func rows(_ calls: [ToolCall]) -> some View {
        // Looked up once for the lot, not once a row: finding the call a prompt waits on reads
        // the whole feed.
        let awaiting = session.awaitingCall, turnLive = session.turnLive, results = session.feed.results
        ForEach(calls) { call in
            ToolRowView(view: ToolPresentation(call: call, result: results[call.id], awaiting: awaiting == call.id, turnLive: turnLive))
        }
    }
}

/// One tool call: what the agent did, its one-line summary, status, and the details on tap.
struct ToolRowView: View {
    let view: ToolPresentation
    @State private var open: Bool
    @Environment(\.theme) private var theme
    @Environment(\.rowWillResize) private var rowWillResize

    init(view: ToolPresentation) {
        self.view = view
        _open = State(initialValue: (view.kind.opensByDefault && !(view.kind.foldsWhenDone && view.status == .done)) || (view.status == .awaiting && view.kind != .shell))
    }

    var body: some View {
        // The whole card's top is the button (its padding in the label): a tap on the card's
        // edge, beside the 16-point line of text, used to miss.
        VStack(alignment: .leading, spacing: 0) {
            Button {
                rowWillResize?()
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    statusMark
                    Text(view.label).font(.ah(.footnote).weight(.semibold)).foregroundStyle(theme.text)
                    Text(view.summary).font(.ahMono(.footnote)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(view.kind.summaryIsPath ? .middle : .tail)
                    Spacer(minLength: 0)
                    if view.status == .running || view.status == .awaiting || view.status == .stopped {
                        Text(view.status == .awaiting ? "Waiting for you" : view.status == .stopped ? "No result" : "Running…")
                            .font(.ah(.caption2))
                            .foregroundStyle(view.status == .awaiting ? theme.brand : theme.faint)
                    }
                    if view.truncated { Text("trimmed").font(.ah(.caption2)).foregroundStyle(theme.faint) }
                    Image(systemName: "chevron.right").font(.ah(.caption2)).foregroundStyle(theme.faint).rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            .accessibilityLabel("\(view.label) \(view.summary), \(view.status.accessibilityLabel)")
            .accessibilityHint(open ? "Collapses the details" : "Shows the details")
            if open {
                ToolBodyView(body: view.body)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        // The details fold up inside the card: unclipped, they slid up over its header and out
        // past its edge as it closed.
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        // ah's ToolRow: a raised card with a hairline; what waits on you is pink-edged.
        .background(view.status == .awaiting ? theme.accentTint : theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(view.status == .awaiting ? theme.accentLine : theme.line, lineWidth: 1))
    }

    /// The row's state as ah's dot: green done, a cyan ring running, pink waiting on you, red
    /// failed, an empty ring when it ended without a result.
    @ViewBuilder
    private var statusMark: some View {
        Group {
            switch view.status {
            case .running: Circle().strokeBorder(theme.run, lineWidth: 2).overlay { PulseRing(color: theme.run) }
            case .awaiting: Circle().fill(theme.brand)
            case .stopped: Circle().strokeBorder(theme.faint, lineWidth: 1.5)
            case .error: Circle().fill(theme.danger)
            case .done: Circle().fill(theme.done)
            }
        }
        .frame(width: 8, height: 8)
        .frame(width: 14)
    }
}

private struct ToolBodyView: View {
    let body_: ToolBody
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles

    init(body: ToolBody) { body_ = body }

    var body: some View {
        switch body_ {
        case .shell(let command, let description, let output):
            if let description { Text(description).font(.ah(.caption)).foregroundStyle(theme.muted) }
            CodeBlockView(code: "$ \(command)", tone: .command)
            OutputView(result: output)
        case .fileDiff(let path, let lines, let error):
            FileLink(path: path)
            DiffLinesView(lines: lines, maxLines: 80)
            OutputView(result: error)
        case .patch(let lines, let error):
            DiffLinesView(lines: lines, maxLines: 120)
            OutputView(result: error)
        case .file(let path, let output):
            FileLink(path: path)
            OutputView(result: output)
        case .search(let scope, let output):
            if let scope { Text("in \(scope)").font(.ah(.caption)).foregroundStyle(theme.muted) }
            OutputView(result: output, empty: "No matches")
        case .web(let url, let prompt, let output):
            if let url { MarkdownView("<\(url)>", compact: true) }
            if let prompt { Text(prompt).font(.ah(.caption)).foregroundStyle(theme.muted) }
            OutputView(result: output)
        case .checklist(let items):
            ChecklistView(title: nil, items: items)
        case .questions(let questions, let waiting):
            if waiting {
                Text("Waiting for your answer below.").font(.ah(.caption)).foregroundStyle(theme.muted)
            } else {
                ForEach(questions, id: \.question) { q in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(q.question).font(.ah(.callout).weight(.semibold))
                        ForEach(Array(q.choices.enumerated()), id: \.offset) { i, choice in
                            HStack {
                                Image(systemName: q.picked(choice) ? "checkmark.circle.fill" : "circle").foregroundStyle(q.picked(choice) ? theme.done : theme.faint)
                                Text(choice)
                                if let d = q.descriptions[i] { Text("— \(d)").foregroundStyle(theme.muted) }
                            }
                            .font(.ah(.caption))
                        }
                        if let answer = q.answer { Text("Answer: \(answer)").font(.ah(.caption)) }
                    }
                }
            }
        case .plan(let plan):
            MarkdownView(plan, compact: true)
        case .delegated(let prompt, let result):
            if let prompt { MarkdownView(prompt, compact: true) }
            if let result { MarkdownView(result, compact: true) }
        case .generic(let arguments, let output):
            if let arguments { CodeBlockView(code: arguments, language: "json") }
            OutputView(result: output)
        }
    }

    private struct FileLink: View {
        let path: String
        @Environment(\.hostFiles) private var hostFiles
        @Environment(\.theme) private var theme
        var body: some View {
            Button {
                hostFiles?.open(path)
            } label: {
                Label(path, systemImage: "doc.text").font(.ahMono(.caption)).lineLimit(1).truncationMode(.head)
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            .foregroundStyle(theme.accent)
        }
    }

    private struct OutputView: View {
        let result: ToolResult?
        var empty = "No output"
        @Environment(\.theme) private var theme
        var body: some View {
            if let result {
                let text = result.text.replacingOccurrences(of: "\n+$", with: "", options: .regularExpression)
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(empty).font(.ah(.caption)).foregroundStyle(theme.faint)
                } else {
                    CodeBlockView(code: text, tone: result.isError ? .error : .plain)
                }
                ForEach(result.images ?? [], id: \.self) { src in HostImage(source: src) }
            }
        }
    }
}

struct ChecklistView: View {
    let title: String?
    let items: [ChecklistItem]
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title, !title.isEmpty { Text(title).font(.ah(.subheadline).weight(.semibold)) }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: item.state == .done ? "checkmark.circle.fill" : item.state == .active ? "circle.dotted.circle" : "circle")
                        .foregroundStyle(item.state == .done ? theme.done : item.state == .active ? theme.run : theme.faint)
                    Text(item.text)
                        .strikethrough(item.state == .done, color: theme.faint)
                        .foregroundStyle(item.state == .done ? theme.muted : theme.text)
                        .fontWeight(item.state == .active ? .semibold : .regular)
                }
                .font(.ah(.callout))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(item.state == .done ? "Done" : item.state == .active ? "In progress" : "To do"): \(item.text)")
            }
        }
    }
}

/// The end of an answered turn: how long the agent took.
struct TurnFooter: View {
    let seconds: Double
    @Environment(\.theme) private var theme

    var body: some View {
        Label("Done in \(WorkingRow.elapsed(seconds))", systemImage: "checkmark.circle")
            .font(.ah(.caption2))
            .foregroundStyle(theme.faint)
            .padding(.leading, 4)
            .accessibilityLabel("The agent took \(WorkingRow.elapsed(seconds))")
    }
}

/// The agent at work: what it says it's doing (with a slow shimmer), how long it's been at
/// it, and how to stop or steer from the keyboard. Still under Reduce Motion.
struct WorkingRow: View {
    let detail: String?
    let queued: Int
    let hardwareKeyboard: Bool
    /// In focus mode, whether the steps it's taking show (a tap shows or hides them); nil
    /// otherwise, where it's only a line.
    var steps: Bool? = nil
    var toggleSteps: () -> Void = {}
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var since = Date()

    var body: some View {
        if let steps {
            Button(action: toggleSteps) { line.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .accessibilityHint(steps ? "Hides its steps" : "Shows its steps")
        } else {
            line
        }
    }

    private var line: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkle")
                .font(.ah(.footnote).weight(.semibold))
                .foregroundStyle(theme.accent)
                .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
            Text(detail.flatMap { $0.isEmpty ? nil : $0 } ?? "Working")
                .font(.ah(.footnote).weight(.medium))
                .foregroundStyle(theme.text2)
                .lineLimit(1)
                .modifier(Shimmer(active: !reduceMotion))
            TimelineView(.periodic(from: since, by: 1)) { context in
                Text(Self.elapsed(context.date.timeIntervalSince(since)))
                    .font(.ah(.footnote).monospacedDigit())
                    .foregroundStyle(theme.faint)
            }
            Spacer(minLength: 8)
            if let steps {
                // What a tap does: the steps it's taking, out or away again.
                Image(systemName: steps ? "eye.slash" : "eye")
                    .font(.ah(.caption))
                    .foregroundStyle(theme.faint)
            }
            if hardwareKeyboard {
                HStack(spacing: 4) {
                    Keycaps(parts: ["esc"])
                    Text("stop").font(.ah(.caption2)).foregroundStyle(theme.faint)
                    if queued > 0 {
                        Keycaps(parts: ["↵"]).padding(.leading, 6)
                        Text("steer next").font(.ah(.caption2)).foregroundStyle(theme.faint)
                    }
                }
            }
        }
        // A quiet line in the agent's column, not a card: the pulse and the clock say enough.
        .padding(.vertical, 6)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("The agent is working. \(detail ?? "")")
    }

    static func elapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
    }
}

/// A light band that sweeps across text now and then: something is happening. Its own
/// keyframes (see `PulseRing`): begun as a repeating animation, it took the transcript's
/// layout in the same update along with it, again and again.
private struct Shimmer: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content
                .overlay {
                    KeyframeAnimator(initialValue: -1.0, repeating: true) { phase in
                        GeometryReader { proxy in
                            LinearGradient(colors: [.clear, .white.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                                .frame(width: proxy.size.width * 0.5)
                                .offset(x: phase * proxy.size.width * 1.5)
                                .blendMode(.plusLighter)
                        }
                    } keyframes: { _ in
                        LinearKeyframe(-1, duration: 0.4)
                        LinearKeyframe(1, duration: 1.6, timingCurve: .easeInOut)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
        } else {
            content
        }
    }
}

/// A fresh conversation: who's ready and where, a few ways to start, and this project's
/// recent conversations to pick up instead (`Blank` in `../ah/web/gui/GuiSurface.tsx`).
struct StartConversation: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    private static let starters: [(symbol: String, text: String)] = [
        ("sparkles", "Explain how this project fits together"),
        ("checklist", "Run the tests and fix what fails"),
        ("magnifyingglass", "Find TODOs worth doing next"),
    ]

    private var recent: [HistoryRow] {
        guard let row = session.row else { return [] }
        return session.hub.history
            .filter { $0.dto.project == row.dto.project && $0.dto.harness == (row.dto.agent ?? "") }
            .sorted { $0.dto.at > $1.dto.at }
            .prefix(3)
            .map { $0 }
    }

    private var place: String {
        guard let row = session.row else { return "" }
        let launch = session.launch
        return [row.dto.project, row.dto.branch, launch.modelLabel, launch.effort.map(LaunchState.effortName)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 12) {
                    AgentMark(agent: session.row?.dto.agent, size: 58)
                        .scaleEffect(appeared || reduceMotion ? 1 : 0.85)
                    Text(session.awaitingTrust ? "Trust this folder?" : "\(session.launch.preset?.name ?? "The agent") is ready")
                        .font(.ah(.title2).weight(.semibold))
                    Text(place).font(.ah(.callout)).foregroundStyle(theme.muted).multilineTextAlignment(.center)
                }
                if session.awaitingTrust {
                    TrustQuestion(agent: session.launch.preset?.name ?? "The agent")
                } else {
                    startingPoints
                }
            }
            .frame(maxWidth: 460)
            .padding(.horizontal, 24)
            .padding(.vertical, 40)
            .frame(maxWidth: .infinity)
            .opacity(appeared ? 1 : 0)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onAppear {
            if reduceMotion { appeared = true } else { withAnimation(.spring(duration: 0.5, bounce: 0.3)) { appeared = true } }
        }
    }

    /// What to start with, and earlier conversations here to pick up.
    @ViewBuilder private var startingPoints: some View {
        VStack(spacing: 8) {
            ForEach(Self.starters, id: \.text) { starter in
                Button {
                    session.composer.compose(starter.text)
                    scene.requestFocus(.composer(session.key))
                    Haptics.tap()
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: starter.symbol).foregroundStyle(theme.accent).frame(width: 22)
                        Text(starter.text).foregroundStyle(theme.text)
                        Spacer()
                        Image(systemName: "arrow.up.left").font(.ah(.caption)).foregroundStyle(theme.faint)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(theme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
            }
        }
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Or pick up where you left off").font(.ah(.footnote).weight(.semibold)).foregroundStyle(theme.muted)
                ForEach(recent, id: \.id) { item in
                    Button {
                        Task { await scene.resume(item) }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "clock.arrow.circlepath").foregroundStyle(theme.faint).frame(width: 22)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.dto.title).foregroundStyle(theme.text).lineLimit(1)
                                Text(ElapsedWords.date(epoch: item.dto.at).formatted(.relative(presentation: .named))).font(.ah(.caption)).foregroundStyle(theme.faint)
                            }
                            Spacer()
                            Text("Resume").font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.accent)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                }
            }
        }
    }
}

/// The agent's folder-trust prompt on the first screen: its question and choices sit above
/// the composer, and a message sent meanwhile waits in Up next.
private struct TrustQuestion: View {
    let agent: String
    @Environment(\.theme) private var theme

    var body: some View {
        Text("\(agent) asks before it works in a folder it hasn’t opened before. Anything you send waits until you answer below.")
            .font(.ah(.callout))
            .foregroundStyle(theme.muted)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct UnavailableFeed: View {
    let reason: String?
    let useTerminal: () -> Void

    var body: some View {
        let message: String = switch reason {
        case "no-adapter": "This agent has no structured transcript, so it’s terminal-only."
        case "no-transcript": "The agent hasn’t written its transcript yet."
        case "unreadable": "Its transcript couldn’t be read here. The terminal shows everything."
        default: "There’s no transcript for this session."
        }
        EmptyState(symbol: "terminal", title: "No GUI for this session", message: message, action: ("Use the terminal", useTerminal))
    }
}

/// The transcript's height and what's left to show it in: when either changes at the end,
/// the end is brought back into view.
enum TranscriptEnd {
    /// The last this many points in view is at the end (a line half under the bar is still there).
    static let slack: CGFloat = 48

    /// Putting the end back in view, in the same pass that moved it, so it's never drawn
    /// out of place. A scroll can move it again (rows of a long transcript measured as they
    /// come into view), and that one is put right too, but only a few times a turn of the
    /// run loop: the rest wait for the next, so the main thread is never caught going round.
    @MainActor
    final class Follow {
        static let perTurn = 3
        private var spent = 0
        private var waiting = false

        func correct(_ scroll: @escaping @MainActor () -> Void) {
            if spent == 0 { DispatchQueue.main.async { [weak self] in self?.spent = 0 } }
            spent += 1
            if spent <= Self.perTurn { return scroll() }
            guard !waiting else { return }
            waiting = true
            DispatchQueue.main.async { [weak self] in
                self?.waiting = false
                scroll()
            }
        }
    }

    /// Where the end is and how much room there is to show it, at a layout.
    struct Reading: Equatable {
        var below: CGFloat
        var room: CGFloat
        var offset: CGFloat
        /// Shorter than its room: all of it is in view, wherever it sits.
        var fits: Bool

        init(below: CGFloat, room: CGFloat, offset: CGFloat = 0, fits: Bool = false) {
            self.below = below
            self.room = room
            self.offset = offset
            self.fits = fits
        }

        init(_ geometry: ScrollGeometry) {
            below = TranscriptEnd.below(geometry)
            room = geometry.containerSize.height.rounded()
            offset = geometry.contentOffset.y.rounded()
            fits = geometry.contentSize.height <= geometry.containerSize.height
        }
    }

    /// How far the end of the conversation lies below the bottom of what's in view (above
    /// the composer and the keyboard, which are the bottom inset); at or under zero, the end
    /// is in view.
    static func below(_ geometry: ScrollGeometry) -> CGFloat {
        below(contentHeight: geometry.contentSize.height, offset: geometry.contentOffset.y, room: geometry.containerSize.height, insets: geometry.contentInsets)
    }

    /// `room` is the scroll view's container, which is what's left between the insets (the
    /// bar above, the composer and keyboard below), not the whole frame. Taken for the frame,
    /// the end read as the two bars' height away while it was in view, so the follow scrolled
    /// to it on every layout and fought whatever else moved the view, a frame at a time.
    static func below(contentHeight: CGFloat, offset: CGFloat, room: CGFloat, insets: EdgeInsets) -> CGFloat {
        // Shorter than the room it has, it's all in view wherever it sits.
        let maxOffset = max(contentHeight - room - insets.top, -insets.top)
        return (maxOffset - offset).rounded()
    }
}

extension EnvironmentValues {
    /// Set by the UIKit transcript for each row: one about to fold or unfold (in `.snappy`) says
    /// so, and the rows around it and the view's place move in the same animation. Otherwise
    /// the row's new height arrived at once and everything around it jumped while it was still
    /// folding.
    @Entry var rowWillResize: (@MainActor @Sendable () -> Void)? = nil
}
