import SwiftUI
import UIKit

/// Loads a file from the host through the authenticated file API (images in messages and
/// widgets, previews). Absent outside a signed-in session.
struct HostFiles: Sendable {
    let load: @Sendable (String) async -> Data?
    /// Opens a host path (a link to a file): Quick Look in the app.
    let open: @MainActor @Sendable (String) -> Void
}

private struct HostFilesKey: EnvironmentKey {
    static let defaultValue: HostFiles? = nil
}

extension EnvironmentValues {
    var hostFiles: HostFiles? {
        get { self[HostFilesKey.self] }
        set { self[HostFilesKey.self] = newValue }
    }
}

/// Parsed GFM drawn natively. Links go through `LinkPolicy`: web links open in the browser,
/// host paths open through the file API, anything else is refused.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    var compact = false
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles

    init(_ text: String, compact: Bool = false) {
        blocks = Markdown.parse(text)
        self.compact = compact
    }

    init(blocks: [MarkdownBlock], compact: Bool = false) {
        self.blocks = blocks
        self.compact = compact
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            switch LinkPolicy.classify(url.absoluteString.removingPercentEncoding ?? url.absoluteString) {
            case .external: return .systemAction
            case .hostFile(let path):
                hostFiles?.open(path)
                return .handled
            case .refused: return .discarded
            }
        })
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    @Environment(\.theme) private var theme

    var body: some View {
        switch block {
        case .heading(let level, let inlines):
            Text(InlineText.attributed(inlines, theme: theme))
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .foregroundStyle(theme.text)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 4)
        case .paragraph(let inlines):
            ParagraphView(inlines: inlines)
        case .code(let language, let text):
            CodeBlockView(code: text, language: language)
        case .quote(let blocks):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(theme.accent.opacity(0.5)).frame(width: 3)
                MarkdownView(blocks: blocks, compact: true).foregroundStyle(theme.muted)
            }
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let task = item.task {
                            Image(systemName: task ? "checkmark.square.fill" : "square")
                                .foregroundStyle(task ? theme.done : theme.muted)
                                .accessibilityLabel(task ? "Done" : "To do")
                        } else {
                            Text(ordered ? "\(start + index)." : "•").foregroundStyle(theme.muted).monospacedDigit()
                        }
                        MarkdownView(blocks: item.blocks, compact: true)
                    }
                }
            }
        case .table(let header, let alignments, let rows):
            TableBlock(header: header, alignments: alignments, rows: rows)
        case .rule:
            Divider()
        case .html(let raw):
            Text(raw).font(theme.mono).foregroundStyle(theme.muted).textSelection(.enabled)
        }
    }
}

/// Paragraph text; images inside it are drawn after the text.
private struct ParagraphView: View {
    let inlines: [MarkdownInline]
    @Environment(\.theme) private var theme

    var body: some View {
        let images = inlines.compactMap { inline -> (String, String)? in
            if case .image(let alt, let src) = inline { return (alt, src) }
            return nil
        }
        VStack(alignment: .leading, spacing: 8) {
            Text(InlineText.attributed(inlines, theme: theme))
                .foregroundStyle(theme.text2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(images.enumerated()), id: \.offset) { _, image in
                HostImage(source: image.1, alt: image.0)
            }
        }
    }
}

enum InlineText {
    /// Inline runs as one attributed string: links tappable, code monospaced.
    static func attributed(_ inlines: [MarkdownInline], theme: Theme) -> AttributedString {
        var out = AttributedString()
        for inline in inlines { out += attributed(inline, theme: theme) }
        return out
    }

    static func attributed(_ inline: MarkdownInline, theme: Theme) -> AttributedString {
        switch inline {
        case .text(let s):
            return AttributedString(s.replacingOccurrences(of: "\n", with: " "))
        case .code(let s):
            var a = AttributedString(s)
            a.font = .system(.body, design: .monospaced)
            a.backgroundColor = theme.raised
            return a
        case .emphasis(let children):
            var a = attributed(children, theme: theme)
            a.inlinePresentationIntent = .emphasized
            return a
        case .strong(let children):
            var a = attributed(children, theme: theme)
            a.inlinePresentationIntent = .stronglyEmphasized
            return a
        case .strike(let children):
            var a = attributed(children, theme: theme)
            a.strikethroughStyle = .single
            return a
        case .link(let text, let url):
            var a = attributed(text, theme: theme)
            if let target = URL(string: url) ?? URL(string: url.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "") {
                a.link = target
                a.foregroundColor = theme.accent
            }
            return a
        case .image:
            // Drawn under the paragraph by ParagraphView.
            return AttributedString()
        case .lineBreak:
            return AttributedString("\n")
        }
    }
}

private struct TableBlock: View {
    let header: [[MarkdownInline]]
    let alignments: [MarkdownBlock.Alignment]
    let rows: [[[MarkdownInline]]]
    @Environment(\.theme) private var theme

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    ForEach(header.indices, id: \.self) { i in
                        Text(InlineText.attributed(header[i], theme: theme)).font(.callout.weight(.semibold)).gridColumnAlignment(alignment(i))
                    }
                }
                Divider()
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r].indices, id: \.self) { i in
                            Text(InlineText.attributed(rows[r][i], theme: theme)).font(.callout).foregroundStyle(theme.text2)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(theme.sunken.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func alignment(_ i: Int) -> HorizontalAlignment {
        guard alignments.indices.contains(i) else { return .leading }
        switch alignments[i] {
        case .center: return .center
        case .trailing: return .trailing
        default: return .leading
        }
    }
}

/// A code block: scrolls sideways rather than wrapping, selectable, one-tap copy.
struct CodeBlockView: View {
    let code: String
    var language: String?
    var tone: Tone = .plain
    @Environment(\.theme) private var theme
    @State private var copied = false

    enum Tone { case plain, command, error }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if let language, !language.isEmpty {
                    Text(language).font(.caption2.monospaced()).foregroundStyle(theme.faint)
                }
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Haptics.tap()
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .labelStyle(.iconOnly)
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(theme.mono)
                    .foregroundStyle(tone == .error ? theme.danger : theme.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                    .padding(.top, 2)
            }
        }
        .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .leading) {
            if tone == .command { RoundedRectangle(cornerRadius: 1.5).fill(theme.run.opacity(0.6)).frame(width: 3) }
        }
    }
}

/// Numbered diff lines: additions and removals tinted, long lines scroll sideways together.
struct DiffLinesView: View {
    let lines: [DiffLine]
    var maxLines: Int? = nil
    /// Tap a line to act on it (comment, attach to the reviewer).
    var onLine: ((DiffLine) -> Void)? = nil
    var selected: Set<Int> = []
    /// The keyboard cursor's line, outlined.
    var cursor: Int? = nil
    /// Gives each line a scroll id "<prefix>:<index>" so the cursor can be kept in view.
    var idPrefix: String? = nil
    @Environment(\.theme) private var theme
    @State private var showAll = false

    var body: some View {
        let shown = (showAll || maxLines == nil) ? lines : Array(lines.prefix(maxLines!))
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { index, line in
                        DiffLineRow(line: line, selected: selected.contains(index))
                            .overlay { if cursor == index { Rectangle().strokeBorder(theme.accentStrong, lineWidth: 1.5) } }
                            .contentShape(Rectangle())
                            .onTapGesture { onLine?(line) }
                            .id(idPrefix.map { "\($0):\(index)" } ?? "\(index)")
                    }
                }
            }
            if let maxLines, lines.count > maxLines, !showAll {
                Button("Show all \(lines.count) lines") { showAll = true }
                    .font(.caption)
                    .padding(8)
            }
        }
        .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct DiffLineRow: View {
    let line: DiffLine
    var selected = false
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            Text(line.number.map(String.init) ?? "")
                .frame(width: 44, alignment: .trailing)
                .foregroundStyle(theme.faint)
                .padding(.trailing, 6)
            Text(sign)
                .frame(width: 14)
                .foregroundStyle(signColor)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .hunk || line.kind == .file ? theme.muted : theme.text)
                .fontWeight(line.kind == .file ? .semibold : .regular)
                .padding(.trailing, 12)
        }
        .font(.system(.footnote, design: .monospaced))
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }

    private var sign: String {
        switch line.kind {
        case .add: return "+"
        case .del: return "−"
        default: return ""
        }
    }

    private var signColor: Color { line.kind == .add ? theme.done : theme.danger }

    private var background: Color {
        if selected { return theme.accent.opacity(0.22) }
        switch line.kind {
        case .add: return theme.done.opacity(0.12)
        case .del: return theme.danger.opacity(0.12)
        case .hunk, .file: return theme.raised.opacity(0.6)
        case .ctx: return .clear
        }
    }

    private var accessibility: String {
        let kind = line.kind == .add ? "Added" : line.kind == .del ? "Removed" : line.kind == .file ? "File" : ""
        let number = line.number.map { "line \($0), " } ?? ""
        return "\(kind) \(number)\(line.text)"
    }
}

/// An image from the host (authenticated) or inline data; never a remote URL.
struct HostImage: View {
    let source: String
    var alt = ""
    @Environment(\.hostFiles) private var hostFiles
    @Environment(\.theme) private var theme
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 360)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel(alt.isEmpty ? "Image" : alt)
            } else if failed {
                Label(alt.isEmpty ? "Image not available" : alt, systemImage: "photo").font(.caption).foregroundStyle(theme.muted)
            } else {
                ProgressView().frame(height: 60)
            }
        }
        .task(id: source) { await load() }
    }

    private func load() async {
        switch WidgetModel.imageSource(source) {
        case .inline(let data):
            image = UIImage(data: data)
        case .hostFile(let path):
            if let data = await hostFiles?.load(path) { image = UIImage(data: data) }
        case .unavailable:
            break
        }
        failed = image == nil
    }
}

/// A list's empty state: what's missing and what to do.
struct EmptyState: View {
    let symbol: String
    let title: String
    let message: String
    var action: (title: String, run: () -> Void)? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            if let action {
                Button(action.title, action: action.run).buttonStyle(.borderedProminent).tint(theme.accentStrong)
            }
        }
    }
}

/// A search snippet with its matched words picked out (the host marks them \u{1}…\u{2}).
struct HighlightedSnippet: View {
    let snippet: String
    var lines = 2
    @Environment(\.theme) private var theme

    var body: some View {
        SwitcherSearch.highlights(snippet).reduce(Text("")) { text, run in
            text + (run.marked ? Text(run.text).bold().foregroundColor(theme.accent) : Text(run.text))
        }
        .font(.caption)
        .foregroundStyle(theme.text2)
        .lineLimit(lines)
    }
}

