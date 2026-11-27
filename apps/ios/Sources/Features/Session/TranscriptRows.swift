import SwiftUI
import UIKit

// The transcript's rows: what `TranscriptController` (TranscriptCollection.swift) lays out, one
// cell each, and the pieces around them (the rail, the catching-up pill, the empty states).

/// A glass pill at the top of the transcript while the host's copy is on its way, there once
/// the wait is long enough to notice (a quick link never shows it).
struct CatchingUp: View {
    let scene: SceneModel
    let key: String
    @Environment(\.theme) private var theme

    var body: some View {
        // Not while the host isn't answering: the bar says Offline, and a spinner here said it
        // was on its way. Asked here, not in the transcript's body, so the host's state ticking
        // draws this pill again and not the whole transcript.
        if scene.connectionNote(key) == nil {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Catching up").font(.ah(.footnote)).foregroundStyle(theme.text2)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .glassEffect(.regular, in: Capsule())
            .accessibilityElement(children: .combine)
            .afterABeat()
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
                let isScrubbed = i == scrub
                Capsule()
                    .fill(i == active || isScrubbed ? theme.accent : theme.faint.opacity(i == tip ? 0.95 : 0.55))
                    .frame(width: isScrubbed ? 18 : (i == active || i == tip ? 14 : 8), height: isScrubbed ? 3.5 : 2.5)
                    .frame(width: 26, height: pitch, alignment: .leading)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { hover = i } else if hover == i { hover = nil }
                    }
                    .accessibilityElement()
                    // Its attachments as the bubble says them ("1 image · …"), not their paths.
                    .accessibilityLabel("Message \(i + 1) of \(items.count): \(FeedProjection.railPreview(items[i].text).prefix(120))")
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
        // A finger covers what's beside it, so a press shows the bubble above it (its bottom
        // edge on the rail's, moved up); a pointer's hover, beside the tick (centre on centre).
        .overlay(alignment: scrub != nil ? .bottomLeading : .leading) {
            if let tip, range.contains(tip) {
                let height = 8 + CGFloat(range.count) * pitch
                let tick = 4 + (CGFloat(tip - range.lowerBound) + 0.5) * pitch
                RailBubble(text: FeedProjection.railPreview(items[tip].text))
                    // Its own width: an overlay is offered the rail's 28 points, and the words
                    // wrapped there a letter to a line.
                    .frame(width: 280, alignment: .leading)
                    .offset(x: scrub != nil ? 12 : 30, y: scrub != nil ? tick - height - 28 : tick - height / 2)
                    .animation(reduceMotion ? nil : .interactiveSpring(response: 0.22, dampingFraction: 0.85), value: tip)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
            if scrub == nil { Haptics.prepare(.light) }
            let i = range.lowerBound + Int((value.location.y - 4) / pitch)
            let clamped = min(items.count - 1, max(0, i))
            if scrub != clamped {
                scrub = clamped
                Haptics.tick()
            }
        }.onEnded { _ in
            if let scrub {
                Haptics.tap()
                jump(items[scrub])
            }
            scrub = nil
        })
        .animation(reduceMotion ? nil : .spring(duration: 0.2, bounce: 0.3), value: scrub)
        .animation(reduceMotion ? nil : .snappy(duration: 0.15), value: active)
        .padding(.leading, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your messages")
    }
}

/// A tick's message as a small copy of its bubble in the conversation: your words on ah's
/// raised card with a hairline, two lines at most, then an ellipsis.
private struct RailBubble: View {
    let text: String
    @Environment(\.theme) private var theme

    var body: some View {
        Text(text)
            .font(.ah(.subheadline))
            .foregroundStyle(theme.text)
            .lineLimit(2)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(theme.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(theme.line, lineWidth: 1))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
            // Both its lines, however short the rail it hangs from.
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct BlockRow: View {
    let block: FeedBlock
    let session: SessionModel
    let scene: SceneModel
    let stepsHidden: Bool
    let isLast: Bool
    @Environment(\.theme) private var theme
    @Environment(\.messageTapped) private var messageTapped

    var body: some View {
        switch block {
        case .user(_, _, let at, let parts):
            let text = parts.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined(separator: "\n")
            UserBubble(text: text, at: at, media: parts)
                // A brief tap: the message's actions where the finger was (`MessageActions`).
                .onTapGesture { messageTapped?() }
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") { scene.copy(text, say: "the message") }
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
            .environment(\.snippetRun, snippetRun)
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
        Button("Copy", systemImage: "doc.on.doc") { scene.copy(block.text, say: "the message") }
        LinkButtons(place: messagePlace, scene: scene)
        if session.isLive && block.hasText {
            Button("Quote in Reply", systemImage: "text.quote") {
                session.composer.compose(Markdown.quote(block.text, limit: 12))
                Haptics.tap()
            }
        }
    }

    /// Run in Terminal on the code in the agent's message, in a shell in the session's folder.
    fileprivate var snippetRun: SnippetRun? {
        guard session.isLive, !session.isShell, scene.attachedTerminal(session), let row = session.row else { return nil }
        let (session, scene) = (session, scene)
        let place = [row.dto.project, row.dto.branch ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        let run: @MainActor @Sendable (String) -> Void = { code in
            Task { await scene.runInShell(code, from: session) }
        }
        var type: (@MainActor @Sendable (String) -> Void)?
        if scene.terminalChat(session) {
            type = { code in Task { await scene.runInShell(code, from: session, run: false) } }
        }
        return SnippetRun(place: place.isEmpty ? "its folder" : place, run: run, type: type)
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
            if session.isLive && !session.isShell && scene.attachedTerminal(session) {
                items.append(UIAction(title: "Send to terminal", image: UIImage(systemName: "terminal")) { _ in
                    Haptics.tap()
                    Task { await scene.runInShell(selected, from: session) }
                })
                if scene.terminalChat(session) {
                    items.append(UIAction(title: "Type in terminal", image: UIImage(systemName: "keyboard")) { _ in
                        Haptics.tap()
                        Task { await scene.runInShell(selected, from: session, run: false) }
                    })
                }
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

/// A message sent before its attachments were up, under its bubble: how far they've got, with a
/// determinate radial transfer ring beside the live percentage. It goes once they're all there;
/// meanwhile you can go anywhere, even put the app away.
struct UploadBar: View {
    let outbox: Outbox
    let item: Outbox.Item
    @Environment(\.theme) private var theme

    var body: some View {
        let fraction = outbox.progress(item) ?? 1
        let percent = Int((fraction * 100).rounded())
        let count = item.waitingOn.count
        HStack(spacing: 8) {
            // Every byte out, the host's answer still to come: it isn't stuck at 100%.
            Text(fraction >= 0.995 ? "Finishing the upload" : "Uploading \(count == 1 ? "the attachment" : "\(count) attachments") · \(percent)%")
                .font(.ah(.caption2))
                .monospacedDigit()
                .foregroundStyle(theme.faint)
                .contentTransition(.numericText())
            RadialTransferRing(fraction: fraction)
        }
        .animation(.spring(duration: 0.35, bounce: 0), value: fraction)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(fraction >= 0.995 ? "Finishing upload" : "Uploading \(count == 1 ? "attachment" : "\(count) attachments")")
        .accessibilityValue("\(percent) percent")
    }
}

/// Compact rotating radial transfer ring whose arc fills smoothly around a morphing center glyph.
/// Stops spinning under Reduce Motion while keeping determinate progress and completion morph.
struct RadialTransferRing: View {
    let fraction: Double
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let done = fraction >= 0.995
        ZStack {
            Circle()
                .fill(theme.accentTint)
            TimelineView(.animation(minimumInterval: 1 / 60, paused: reduceMotion || done)) { context in
                let spin = reduceMotion || done ? 0 : (context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6) * 360
                ZStack {
                    Circle()
                        .stroke(theme.accent.opacity(0.22), lineWidth: 2)
                    Circle()
                        .trim(from: 0, to: CGFloat(done ? 1 : max(0.08, fraction)))
                        .stroke(done ? theme.accent : theme.accentStrong, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .rotationEffect(.degrees(-90 + spin))
                }
            }
            Image(systemName: done ? "checkmark" : "arrow.up")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(done ? theme.accent : theme.accentStrong)
                .contentTransition(.symbolEffect(.replace))
        }
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
    }
}

/// Your message: right-aligned, what you attached over your words as tiles that open (a
/// picture pasted into the agent's own terminal among them).
struct UserBubble: View {
    let text: String
    var at: Double? = nil
    var pending: String? = nil
    /// The message's parts: its pictures are drawn with what you attached.
    var media: [FeedPart] = []
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles

    var body: some View {
        // What you attached: tiles above, and chips where you put them in the words.
        let split = Attachment.placed(text, media: media)
        VStack(alignment: .trailing, spacing: 6) {
            if !split.attachments.isEmpty {
                AttachmentStrip(attachments: split.attachments, alignment: .trailing)
            }
            if !split.rest.isEmpty {
                // Your line breaks as you typed them: a new line in the box is one here too.
                MarkdownView(split.rest, compact: true, keepingLineBreaks: true, uploads: split.uploads, gallery: split.attachments.filter { $0.look != .file }.map(\.source))
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
        // One element a message, as the agent's are; what it carries opens from its actions.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(Uploads.summary(images: split.attachments.count { $0.look == .picture }, files: split.attachments.count { $0.look != .picture }, words: split.rest))\(pending.map { ". \($0)" } ?? "")")
        .accessibilityActions {
            if let open = hostFiles?.open {
                ForEach(Array(split.attachments.enumerated()), id: \.offset) { _, attachment in
                    Button("Open \(attachment.name)") { Task { await open(attachment.source) } }
                }
            }
        }
    }
}

private struct PartView: View {
    let part: FeedPart
    let session: SessionModel
    let stepsHidden: Bool
    /// A turn the conversation has moved past: its choices are history, not buttons.
    var answered = false
    @Environment(\.theme) private var theme
    @Environment(\.rowWillResize) private var rowWillResize
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
                        // As a step's fold does: the list moves with the row as it grows,
                        // instead of the rows under it jumping to the new height at once.
                        rowWillResize?()
                        withAnimation(.snappy) { showReasoning.toggle() }
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
            AttachmentStrip(attachments: [.picture(src, alt: alt)])
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

/// A run of tool calls: its last few, or one line with steps hidden (never while one asks you;
/// a question you answered stays out of the line, with your answers).
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
                let said = calls.filter { ToolKind(name: $0.name) == .question }
                let steps = calls.filter { ToolKind(name: $0.name) != .question }
                let folded = ToolGroupSummary(calls: steps, results: session.feed.results, awaitingCall: session.awaitingCall, turnLive: session.turnLive)
                if !steps.isEmpty {
                    Button {
                        rowWillResize?()
                        withAnimation(.snappy) { unfolded.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            if folded.running { ProgressView().controlSize(.mini) }
                            Text(folded.foldedLabel)
                            Image(systemName: "chevron.right").rotationEffect(.degrees(unfolded ? 90 : 0))
                        }
                        .font(.ah(.footnote))
                        .foregroundStyle(folded.failed > 0 ? theme.danger : theme.muted)
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    if unfolded { rows(steps) }
                }
                rows(said)
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
    @Environment(\.openSubagent) private var openSubagent

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
                            .foregroundStyle(view.status == .awaiting ? theme.accent : theme.faint)
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
            // A delegated task is a session of its own: its whole conversation, one tap away.
            if view.kind == .agent, let openSubagent {
                Button {
                    openSubagent(view.callId)
                } label: {
                    Label("Open Subagent", systemImage: "arrow.up.right")
                        .font(.ah(.caption).weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.bottom, 8)
                        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.accent)
                .hoverEffect(.highlight)
                .accessibilityHint("Opens the conversation of the agent this spawned")
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
            // Failed has a shape of its own: red against green is the pair color blindness
            // takes away.
            case .error: Image(systemName: "xmark").font(.system(size: 7, weight: .black)).foregroundStyle(theme.danger).frame(width: 8, height: 8)
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
            CodeBlockView(code: "$ \(command)", tone: .command, command: command)
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
                Task { await hostFiles?.open?(path) }
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
                    // What a command printed isn't one to run.
                    CodeBlockView(code: text, tone: result.isError ? .error : .plain)
                        .environment(\.snippetRun, nil)
                }
                // What a tool saw (a screenshot it took): thumbnails that open.
                if let images = result.images, !images.isEmpty {
                    AttachmentStrip(attachments: images.map { .picture($0) })
                }
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
    var toolKind: ToolKind? = nil
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
            ActivityGlyph(kind: ActivityKind.resolve(toolKind: toolKind, detail: detail), color: theme.accent)
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
/// recent conversations to pick up instead (`Blank` in `apps/server/web/gui/GuiSurface.tsx`).
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
                    Text("\(session.launch.preset?.name ?? "The agent") is ready")
                        .font(.ah(.title2).weight(.semibold))
                    Text(place).font(.ah(.callout)).foregroundStyle(theme.muted).multilineTextAlignment(.center)
                }
                startingPoints
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
                        // The whole row resumes it, not only its words.
                        .contentShape(Rectangle())
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
        EmptyState(symbol: "terminal", title: "No GUI for This Session", message: message, action: ("Use the Terminal", useTerminal))
    }
}

extension EnvironmentValues {
    /// Set by the UIKit transcript for each row: one about to fold or unfold (in `.snappy`) says
    /// so, and the rows around it and the view's place move in the same animation. Otherwise
    /// the row's new height arrived at once and everything around it jumped while it was still
    /// folding.
    @Entry var rowWillResize: (@MainActor @Sendable () -> Void)? = nil
    /// Set by the UIKit transcript for each row: a brief tap on the message (its words, your
    /// bubble, the line under it) says so, and the transcript shows its actions there.
    @Entry var messageTapped: (@MainActor @Sendable () -> Void)? = nil
    /// Set by the UIKit transcript when its session's host reads subagents: a Delegate card opens
    /// the subagent its call spawned, by the call's id.
    @Entry var openSubagent: (@MainActor @Sendable (String) -> Void)? = nil
}

/// What a brief tap on a message offers, in UIKit's edit menu where the finger was
/// (`TranscriptController`): all of it copied, quoted in your reply, a link to it. The same
/// actions as a long press, without the press.
enum MessageActions {
    @MainActor
    static func menu(for block: FeedBlock, session: SessionModel, scene: SceneModel) -> [UIMenuElement] {
        guard block.isUser || block.isAgent else { return [] }
        let place = Place(.session(session.key), message: block.seq)
        var items: [UIMenuElement] = []
        if block.hasText {
            items.append(UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { _ in
                scene.copy(block.text, say: "the message")
            })
        }
        if session.isLive, block.hasText {
            if block.isAgent {
                items.append(UIAction(title: "Quote in Reply", image: UIImage(systemName: "text.quote")) { _ in
                    session.composer.compose(Markdown.quote(block.text, limit: 12))
                    Haptics.tap()
                })
            } else {
                items.append(UIAction(title: "Edit & Send Again", image: UIImage(systemName: "pencil")) { _ in
                    session.composer.compose(block.text)
                    Haptics.tap()
                })
            }
        }
        items.append(UIAction(title: "Copy Link", image: UIImage(systemName: "link")) { _ in scene.copyLink(to: place) })
        items.append(UIAction(title: "Share Link…", image: UIImage(systemName: "square.and.arrow.up")) { _ in scene.shareLink(to: place) })
        return items
    }
}
