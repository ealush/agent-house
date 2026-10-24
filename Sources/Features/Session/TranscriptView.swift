import SwiftUI
import UIKit

/// The GUI view of a session: the agent's structured transcript (never its terminal screen),
/// your optimistic messages until the transcript has them, and live state at the bottom.
struct TranscriptView: View {
    @Bindable var session: SessionModel
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var topID: String?
    @State private var browsing: Int?
    @State private var loadingOlder = false
    @FocusState private var browseFocused: Bool

    private var stepsHidden: Bool { scene.app.preferences.stepsHidden }

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
                                .font(.footnote)
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
                    ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                        BlockRow(block: block, session: session, stepsHidden: stepsHidden, isLast: index == blocks.count - 1)
                            .id(block.id)
                            .padding(.horizontal, 2)
                            .background(browsing == index ? theme.accent.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 12))
                    }
                    ForEach(session.outgoing) { item in
                        UserBubble(text: item.text, pending: item.state == .sending ? "Sending…" : "Typed in · waiting for the transcript")
                            .id("out-\(item.id)")
                    }
                    if session.working {
                        WorkingRow(detail: session.row?.dto.detail)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .scrollTargetLayout()
            }
            .scrollPosition(id: $topID, anchor: .top)
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                switch session.feed.status {
                case .unavailable:
                    UnavailableFeed(reason: session.feed.reason) { scene.setSurface(.terminal, for: session.key) }
                case .connecting where blocks.isEmpty:
                    ProgressView("Connecting to the transcript…")
                default:
                    if blocks.isEmpty && session.feed.status == .live && session.outgoing.isEmpty {
                        EmptyState(symbol: "text.bubble", title: "Nothing here yet", message: "Send the first message below.")
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
                    scene.toast("Open Snapshots to restore the files to before this message")
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
        }
        .background(theme.background)
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
            UserBubble(text: parts.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined(separator: "\n"), at: at, media: parts)
        case .agent(_, _, _, let items):
            VStack(alignment: .leading, spacing: 12) {
                ForEach(items) { item in
                    switch item {
                    case .part(_, let part):
                        PartView(part: part, session: session, stepsHidden: stepsHidden)
                    case .tools(_, let calls):
                        ToolGroupView(calls: calls, session: session, stepsHidden: stepsHidden)
                    }
                }
            }
            .contextMenu {
                Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = block.text }
            }
        case .notice(_, _, _, let kind, let text):
            HStack(spacing: 8) {
                Image(systemName: kind == .compacted ? "arrow.down.right.and.arrow.up.left" : kind == .interrupted ? "stop.circle" : "info.circle")
                Text(text)
            }
            .font(.footnote)
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
                            Label(upload.name, systemImage: "doc").font(.caption).padding(8).background(theme.raised, in: Capsule())
                        }
                    }
                }
            }
            if !split.rest.isEmpty {
                MarkdownView(split.rest, compact: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(theme.accentStrong.opacity(0.16), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            if let pending {
                Text(pending).font(.caption2).foregroundStyle(theme.faint)
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
    @Environment(\.theme) private var theme
    @State private var showReasoning = false

    var body: some View {
        switch part {
        case .text(let text):
            MarkdownView(text)
        case .reasoning(let text):
            if !stepsHidden {
                DisclosureGroup(isExpanded: $showReasoning) {
                    MarkdownView(text, compact: true).foregroundStyle(theme.muted)
                } label: {
                    Label("Thinking", systemImage: "brain").font(.footnote).foregroundStyle(theme.muted)
                }
            }
        case .media(_, let src, let alt):
            HostImage(source: src, alt: alt ?? "")
        case .widget(let widget):
            WidgetView(model: WidgetModel(widget), reply: { text in Task { await session.reply(text) } })
        case .notice(_, let text):
            Text(text).font(.footnote).foregroundStyle(theme.muted)
        case .toolCall, .toolResult:
            EmptyView()
        case .unknown(let type):
            Text("Unsupported content (\(type))").font(.caption).foregroundStyle(theme.faint)
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
                    .font(.footnote)
                    .foregroundStyle(summary.failed > 0 ? theme.danger : theme.muted)
                }
                .buttonStyle(.plain)
                if unfolded { rows(calls) }
            } else {
                let hidden = ToolGroupSummary.hiddenCount(total: calls.count, showAll: showAll)
                if hidden > 0 {
                    Button("\(hidden) earlier step\(hidden == 1 ? "" : "s")") { withAnimation(.snappy) { showAll = true } }
                        .font(.footnote)
                        .buttonStyle(.plain)
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
                    Text(view.label).font(.footnote.weight(.semibold)).foregroundStyle(theme.text)
                    Text(view.summary).font(.footnote.monospaced()).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    if view.status == .running || view.status == .awaiting || view.status == .stopped {
                        Text(view.status == .awaiting ? "Waiting for you" : view.status == .stopped ? "No result" : "Running…")
                            .font(.caption2)
                            .foregroundStyle(view.status == .awaiting ? theme.brand : theme.faint)
                    }
                    if view.truncated { Text("trimmed").font(.caption2).foregroundStyle(theme.faint) }
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(theme.faint).rotationEffect(.degrees(open ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(view.label) \(view.summary), \(view.status.accessibilityLabel)")
            .accessibilityHint(open ? "Collapses the details" : "Shows the details")
            if open {
                ToolBodyView(body: view.body)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(10)
        .background(theme.raised.opacity(view.status == .awaiting ? 1 : 0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(view.status == .awaiting ? theme.brand.opacity(0.6) : .clear, lineWidth: 1.5))
    }

    @ViewBuilder
    private var statusMark: some View {
        switch view.status {
        case .running: ProgressView().controlSize(.mini)
        case .awaiting: Image(systemName: "hand.raised.fill").foregroundStyle(theme.brand).font(.caption)
        case .stopped: Image(systemName: "minus.circle").foregroundStyle(theme.faint).font(.caption)
        case .error: Image(systemName: "xmark.circle.fill").foregroundStyle(theme.danger).font(.caption)
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.done).font(.caption)
        }
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
            if let description { Text(description).font(.caption).foregroundStyle(theme.muted) }
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
            if let scope { Text("in \(scope)").font(.caption).foregroundStyle(theme.muted) }
            OutputView(result: output, empty: "No matches")
        case .web(let url, let prompt, let output):
            if let url { MarkdownView("<\(url)>", compact: true) }
            if let prompt { Text(prompt).font(.caption).foregroundStyle(theme.muted) }
            OutputView(result: output)
        case .checklist(let items):
            ChecklistView(title: nil, items: items)
        case .questions(let questions, let waiting):
            if waiting {
                Text("Waiting for your answer below.").font(.caption).foregroundStyle(theme.muted)
            } else {
                ForEach(questions, id: \.question) { q in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(q.question).font(.callout.weight(.semibold))
                        ForEach(Array(q.choices.enumerated()), id: \.offset) { i, choice in
                            HStack {
                                Image(systemName: q.picked(choice) ? "checkmark.circle.fill" : "circle").foregroundStyle(q.picked(choice) ? theme.done : theme.faint)
                                Text(choice)
                                if let d = q.descriptions[i] { Text("— \(d)").foregroundStyle(theme.muted) }
                            }
                            .font(.caption)
                        }
                        if let answer = q.answer { Text("Answer: \(answer)").font(.caption) }
                    }
                }
            }
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
                Label(path, systemImage: "doc.text").font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
            }
            .buttonStyle(.plain)
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
                    Text(empty).font(.caption).foregroundStyle(theme.faint)
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
            if let title, !title.isEmpty { Text(title).font(.subheadline.weight(.semibold)) }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: item.state == .done ? "checkmark.circle.fill" : item.state == .active ? "circle.dotted.circle" : "circle")
                        .foregroundStyle(item.state == .done ? theme.done : item.state == .active ? theme.run : theme.faint)
                    Text(item.text)
                        .strikethrough(item.state == .done, color: theme.faint)
                        .foregroundStyle(item.state == .done ? theme.muted : theme.text)
                        .fontWeight(item.state == .active ? .semibold : .regular)
                }
                .font(.callout)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(item.state == .done ? "Done" : item.state == .active ? "In progress" : "To do"): \(item.text)")
            }
        }
    }
}

private struct WorkingRow: View {
    let detail: String?
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(detail ?? "Working…").font(.footnote).foregroundStyle(theme.muted).lineLimit(1)
        }
        .accessibilityLabel("The agent is working. \(detail ?? "")")
    }
}

private struct UnavailableFeed: View {
    let reason: String?
    let useTerminal: () -> Void

    var body: some View {
        let message: String = switch reason {
        case "no-adapter": "This agent has no structured transcript, so it’s terminal-only."
        case "no-transcript": "The agent hasn’t written its transcript yet."
        default: "There’s no transcript for this session."
        }
        EmptyState(symbol: "terminal", title: "No GUI for this session", message: message, action: ("Use the terminal", useTerminal))
    }
}
