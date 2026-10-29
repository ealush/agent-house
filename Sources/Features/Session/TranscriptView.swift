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
    @FocusState private var browseFocused: Bool

    private var stepsHidden: Bool { scene.app.preferences.stepsHidden }

    /// Where each finished turn ends (the block before your next message, or the last one
    /// once the agent is done), with how long it took.
    static func turnEnds(_ blocks: [FeedBlock], durations: [String: Double], working: Bool) -> [String: Double] {
        var out: [String: Double] = [:]
        var start: String?
        for (index, block) in blocks.enumerated() {
            if block.isUser { start = nil; continue }
            if block.isAgent && start == nil { start = block.id }
            let next = index + 1 < blocks.count ? blocks[index + 1] : nil
            let ends = next.map(\.isUser) ?? !working
            if ends, let start, let seconds = durations[start] { out[block.id] = seconds }
        }
        return out
    }

    var body: some View {
        let blocks = session.blocks
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if session.feed.hasOlder {
                        Button {
                            Task {
                                loadingOlder = true
                                await session.loadOlder()
                                loadingOlder = false
                            }
                        } label: {
                            Label(loadingOlder ? "Loading…" : "Earlier messages", systemImage: "arrow.up")
                                .font(.ah(.footnote))
                        }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                        .onAppear {
                            guard !loadingOlder else { return }
                            Task {
                                loadingOlder = true
                                await session.loadOlder()
                                loadingOlder = false
                            }
                        }
                    }
                    let ends = Self.turnEnds(blocks, durations: FeedProjection.turnDurations(session.feed.entries), working: session.working)
                    ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                        BlockRow(block: block, session: session, stepsHidden: stepsHidden, isLast: index == blocks.count - 1)
                            .id(block.id)
                            .padding(.horizontal, 2)
                            .background(browsing == index || linked == block.id ? theme.accent.opacity(linked == block.id ? 0.14 : 0.08) : .clear, in: RoundedRectangle(cornerRadius: 12))
                        if let seconds = ends[block.id] {
                            TurnFooter(seconds: seconds)
                        }
                    }
                    ForEach(session.outgoing) { item in
                        UserBubble(text: item.text, pending: item.state == .sending ? "Sending…" : "Sent")
                            .id("out-\(item.id)")
                            // Springs up out of the box it was typed in.
                            .transition(reduceMotion ? .opacity : .asymmetric(insertion: .scale(scale: 0.85, anchor: .bottomTrailing).combined(with: .opacity).combined(with: .offset(y: 24)), removal: .opacity))
                    }
                    if session.working {
                        // A new turn (the newest message you sent) starts the clock again.
                        WorkingRow(detail: session.row?.dto.detail, queued: session.queue.items.count, hardwareKeyboard: scene.hardwareKeyboard)
                            .id(blocks.last { if case .user = $0 { return true } else { return false } }?.id ?? "working")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                // A readable column on a wide screen, centered; the scroll view stays full width.
                .frame(maxWidth: SessionScreen.readableWidth)
                .frame(maxWidth: .infinity)
                .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.3), value: session.outgoing.map(\.id))
                .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: session.working)
                .scrollTargetLayout()
            }
            .scrollPosition(id: $topID, anchor: .top)
            .defaultScrollAnchor(.bottom)
            // A fresh scroll view when the transcript arrives in an empty view (or the host
            // sends a new copy): the bottom anchor only holds for content there from the start,
            // and a long transcript poured into an empty lazy list was laid out but not drawn.
            .id(blocks.isEmpty ? -1 : session.feed.epoch)
            // …and once it has settled, onto the newest message again: with a long transcript
            // the first layout's guesses move it, and what's drawn can sit apart from it.
            .task(id: blocks.isEmpty ? -1 : session.feed.epoch) {
                guard !blocks.isEmpty, scene.scrollAnchors[session.key]?.seq == nil else { return }
                for delay in [150, 600] {
                    try? await Task.sleep(for: .milliseconds(delay))
                    // A link to a message holds the transcript there instead.
                    guard session.pendingMessage == nil, linked == nil else { return }
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
                let all = session.blocks
                guard let block = all.first(where: { $0.seq == seq }) ?? all.last(where: { $0.seq <= seq }) else { return }
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
            .simultaneousGesture(TapGesture().onEnded {
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
                // The restoration anchor: the block at the top of the screen.
                let seq = id.flatMap { key in blocks.first { $0.id == key }?.seq }
                scene.scrollAnchors[session.key] = SceneSnapshot.ScrollAnchor(seq: seq, offset: 0)
            }
            .onAppear {
                if let seq = scene.scrollAnchors[session.key]?.seq, let block = blocks.first(where: { $0.seq == seq }) {
                    reader.scrollTo(block.id, anchor: .top)
                }
            }
            .onChange(of: scene.focusRequest) { _, request in
                guard let request else { return }
                switch request.target {
                case .latest(let key) where key == session.key:
                    withAnimation(.snappy) { reader.scrollTo("bottom", anchor: .bottom) }
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
                        if let block = session.blocks.first(where: { $0.seq == seq }) {
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
                if let index = browsing { withAnimation(.snappy) { reader.scrollTo(blocks[index].id, anchor: .center) } }
                return .handled
            }
            .overlay(alignment: .leading) {
                let items = session.railItems
                if items.count > 2 {
                    let top = scene.scrollAnchors[session.key]?.seq
                    MessageRail(items: items, active: FeedProjection.activeRail(items, topSeq: top, atLatest: top == nil) ?? items.count - 1) { item in
                        guard let seq = item.seq else {
                            withAnimation(.snappy) { reader.scrollTo("bottom", anchor: .bottom) }
                            return
                        }
                        Task {
                            guard await session.reveal(seq: seq) else { return }
                            await Task.yield()
                            if let block = session.blocks.first(where: { $0.seq == seq }) {
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

/// The conversation's outline (`web/gui/MessageRail.tsx`): one tick per message you sent on
/// the transcript's leading edge; the bright one is the turn in view. Tap a tick, or press
/// and slide like an iPhone's section index, to go there. Past fifteen it's a window that
/// follows the reading, faded where more lie beyond.
private struct MessageRail: View {
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

private struct BlockRow: View {
    let block: FeedBlock
    let session: SessionModel
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
                        PartView(part: part, session: session, stepsHidden: stepsHidden, answered: !isLast)
                    case .tools(_, let calls):
                        ToolGroupView(calls: calls, session: session, stepsHidden: stepsHidden)
                    }
                }
            }
            .contextMenu {
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = block.text }
                if session.isLive && !block.text.isEmpty {
                    Button("Quote in Reply", systemImage: "text.quote") {
                        let quoted = block.text.split(separator: "\n", omittingEmptySubsequences: false).prefix(12).map { "> \($0)" }.joined(separator: "\n")
                        session.composer.compose(quoted + "\n\n")
                        Haptics.tap()
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
                MarkdownView(split.rest, compact: true)
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

    var body: some View {
        let summary = ToolGroupSummary(calls: calls, results: session.feed.results, awaitingCall: session.awaitingCall, turnLive: session.turnLive)
        VStack(alignment: .leading, spacing: 6) {
            if stepsHidden && !summary.asking {
                Button {
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
                    Button("\(hidden) earlier step\(hidden == 1 ? "" : "s")") { withAnimation(.snappy) { showAll = true } }
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
        ForEach(calls) { call in
            ToolRowView(view: ToolPresentation(call: call, result: session.feed.results[call.id], awaiting: session.awaitingCall == call.id, turnLive: session.turnLive))
        }
    }
}

/// One tool call: what the agent did, its one-line summary, status, and the details on tap.
struct ToolRowView: View {
    let view: ToolPresentation
    @State private var open: Bool
    @Environment(\.theme) private var theme

    init(view: ToolPresentation) {
        self.view = view
        _open = State(initialValue: (view.kind.opensByDefault && !(view.kind.foldsWhenDone && view.status == .done)) || (view.status == .awaiting && view.kind != .shell))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    statusMark
                    Text(view.label).font(.ah(.footnote).weight(.semibold)).foregroundStyle(theme.text)
                    Text(view.summary).font(.ahMono(.footnote)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    if view.status == .running || view.status == .awaiting || view.status == .stopped {
                        Text(view.status == .awaiting ? "Waiting for you" : view.status == .stopped ? "No result" : "Running…")
                            .font(.ah(.caption2))
                            .foregroundStyle(view.status == .awaiting ? theme.brand : theme.faint)
                    }
                    if view.truncated { Text("trimmed").font(.ah(.caption2)).foregroundStyle(theme.faint) }
                    Image(systemName: "chevron.right").font(.ah(.caption2)).foregroundStyle(theme.faint).rotationEffect(.degrees(open ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            .accessibilityLabel("\(view.label) \(view.summary), \(view.status.accessibilityLabel)")
            .accessibilityHint(open ? "Collapses the details" : "Shows the details")
            if open {
                ToolBodyView(body: view.body)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(10)
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
private struct TurnFooter: View {
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
private struct WorkingRow: View {
    let detail: String?
    let queued: Int
    let hardwareKeyboard: Bool
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var since = Date()

    var body: some View {
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

/// A light band that sweeps across text now and then: something is happening.
private struct Shimmer: ViewModifier {
    let active: Bool
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        if active {
            content
                .overlay {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, .white.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: proxy.size.width * 0.5)
                            .offset(x: phase * proxy.size.width * 1.5)
                            .blendMode(.plusLighter)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
                .onAppear {
                    withAnimation(.easeInOut(duration: 1.6).delay(0.4).repeatForever(autoreverses: false)) { phase = 1 }
                }
        } else {
            content
        }
    }
}

/// A fresh conversation: who's ready and where, a few ways to start, and this project's
/// recent conversations to pick up instead (`Blank` in `../ah/web/gui/GuiSurface.tsx`).
private struct StartConversation: View {
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
        return [row.dto.project, row.dto.branch, launch.modelLabel, launch.effort?.capitalized].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 12) {
                    AgentMark(agent: session.row?.dto.agent, size: 58)
                        .scaleEffect(appeared || reduceMotion ? 1 : 0.85)
                    Text("\(session.launch.preset?.name ?? "The agent") is ready")
                        .font(.ah(.title2).weight(.semibold))
                    Text(place).font(.ah(.callout)).foregroundStyle(theme.muted).multilineTextAlignment(.center)
                }
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
                                        Text(Date(timeIntervalSince1970: item.dto.at / (item.dto.at > 1e11 ? 1000 : 1)).formatted(.relative(presentation: .named))).font(.ah(.caption)).foregroundStyle(theme.faint)
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
}

private struct UnavailableFeed: View {
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
