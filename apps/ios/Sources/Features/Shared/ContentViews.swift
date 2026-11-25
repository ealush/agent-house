import ImageIO
import SwiftUI
import UIKit

/// Loads a file from the host through the authenticated file API (images in messages and
/// widgets, previews). Absent outside a signed-in session.
struct HostFiles: Sendable {
    let load: @Sendable (String) async -> Data?
    /// Opens a host path (a link to a file, an attachment) or a picture that came inline: Quick
    /// Look in the app, once it's here. None where nothing opens (a review's pictures).
    var open: (@MainActor @Sendable (String) async -> Void)?
    /// Opens a message's pictures and videos together in Quick Look, at the one tapped (its
    /// place among them), to swipe from one to the next. None where they open one at a time.
    var browse: (@MainActor @Sendable ([String], Int) async -> Void)? = nil
    /// The session's copies of its attachments (their tiles' thumbnails, what Quick Look opens);
    /// none where nothing is kept (a review's pictures).
    var kept: HostFileStore? = nil
    /// Where "@path" in a message is looked up, so one naming a file there opens it.
    var mentions: MentionLookup? = nil
    /// Live sessions (`uid → display label`) for clickable session name chips (`#<uid>`, `<uid>`, URLs).
    var sessions: (@MainActor @Sendable () -> [String: String])? = nil
    /// Opens a referenced session by uid.
    var openSession: (@MainActor @Sendable (String) -> Void)? = nil
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

/// Run in Terminal: types a snippet into a shell in the session's folder and presses Return
/// (`SceneModel.runInShell`). Set on a live session's agent messages, so their code blocks
/// offer it; absent elsewhere.
struct SnippetRun: Sendable {
    /// Where it runs, for the menu: the project, and the branch when there is one.
    let place: String
    let run: @MainActor @Sendable (String) -> Void
    /// Types it at the prompt without pressing Return, to look at or change first; nil where
    /// the host can't (attachedTerminal 1).
    var type: (@MainActor @Sendable (String) -> Void)? = nil
}

private struct SnippetRunKey: EnvironmentKey {
    static let defaultValue: SnippetRun? = nil
}

extension EnvironmentValues {
    var snippetRun: SnippetRun? {
        get { self[SnippetRunKey.self] }
        set { self[SnippetRunKey.self] = newValue }
    }
}

/// Parsed GFM drawn natively. Links go through `LinkPolicy`: web links open in the browser,
/// host paths open through the file API, anything else is refused.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    var compact = false
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles
    @Environment(\.textMenu) private var textMenu

    /// Your attachments where you put them: token → its path on the host, or a picture's
    /// place in `gallery` (`Attachment.placed`).
    var uploads: [String: String] = [:]
    /// The message's pictures and films, in order: a picture's chip opens it among them.
    var gallery: [String] = []

    /// `keepingLineBreaks`: each new line in the text is one (your own words), not a space.
    init(_ text: String, compact: Bool = false, keepingLineBreaks: Bool = false, uploads: [String: String] = [:], gallery: [String] = []) {
        blocks = Markdown.remembered(text, keepingLineBreaks: keepingLineBreaks)
        self.compact = compact
        self.uploads = uploads
        self.gallery = gallery
    }

    init(blocks: [MarkdownBlock], compact: Bool = false) {
        self.blocks = blocks
        self.compact = compact
    }

    var body: some View {
        let blocks = linkingSessions(linkingMentions(self.blocks))
        VStack(alignment: .leading, spacing: compact ? 6 : 10) {
            if let textMenu {
                // Selectable: prose that follows on is one text view, so a drag selects across it.
                ForEach(Array(Markdown.runs(blocks).enumerated()), id: \.offset) { _, run in
                    switch run {
                    case .prose(let prose): SelectableProse(blocks: prose, compact: compact, menu: textMenu)
                    case .block(let block): BlockView(block: block)
                    }
                }
            } else {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    BlockView(block: block)
                }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let uid = SessionMentions.uid(fromLink: url.absoluteString) {
                hostFiles?.openSession?(uid)
                return .handled
            }
            // An @file's link: the file, in the session's folder.
            if let path = Mentions.path(fromLink: url.absoluteString) {
                // A picture's chip: that picture, with the message's others a swipe away.
                if let place = Attachment.place(fromMark: path) {
                    guard gallery.indices.contains(place) else { return .discarded }
                    if gallery.count > 1, let browse = hostFiles?.browse {
                        Task { await browse(gallery, place) }
                    } else {
                        Task { await hostFiles?.open?(gallery[place]) }
                    }
                    return .handled
                }
                Task { await hostFiles?.open?(path) }
                return .handled
            }
            switch LinkPolicy.classify(url.absoluteString.removingPercentEncoding ?? url.absoluteString) {
            case .external: return .systemAction
            case .hostFile(let path):
                Task { await hostFiles?.open?(path) }
                return .handled
            case .refused: return .discarded
            }
        })
    }
}

extension MarkdownView {
    /// "@path" naming a file that's there: a link that opens it (looked up as it's drawn, drawn
    /// again once known).
    private func linkingMentions(_ blocks: [MarkdownBlock]) -> [MarkdownBlock] {
        let paths = Markdown.mentionPaths(blocks)
        guard !paths.isEmpty else { return blocks }
        var files = uploads
        if let lookup = hostFiles?.mentions, let cwd = lookup.cwd() {
            for path in paths where files[path] == nil {
                let target = Mentions.resolve(path, in: cwd)
                if lookup.files.exists(target) == true { files[path] = target }
            }
        }
        return Markdown.linkingMentions(blocks, files: files.filter { paths.contains($0.key) })
    }

    private func linkingSessions(_ blocks: [MarkdownBlock]) -> [MarkdownBlock] {
        guard let map = hostFiles?.sessions?(), !map.isEmpty else { return blocks }
        return Markdown.linkingSessions(blocks, sessions: map)
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    @Environment(\.theme) private var theme

    var body: some View {
        switch block {
        case .heading(let level, let inlines):
            let style: Font.TextStyle = level == 1 ? .title2 : level == 2 ? .title3 : .headline
            Text(InlineText.attributed(inlines, theme: theme, style: style))
                .font(level <= 2 ? .ah(style).bold() : .ah(style))
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
    @Environment(\.textMenu) private var textMenu

    var body: some View {
        let images = inlines.compactMap { inline -> (String, String)? in
            if case .image(let alt, let src) = inline { return (alt, src) }
            return nil
        }
        VStack(alignment: .leading, spacing: 8) {
            if let textMenu {
                let words = inlines.filter { if case .image = $0 { false } else { true } }
                if !words.isEmpty { SelectableProse(blocks: [.paragraph(words)], menu: textMenu) }
            } else {
                InlineText.text(inlines, theme: theme)
                    .foregroundStyle(theme.text2)
                    .textRenderer(MentionChipRenderer(font: AhType.uiFont(.body), tint: theme.accent))
                    // Room between its lines for the chips on them, as SelectableProse has.
                    .lineSpacing(MentionChip.leading(AhType.uiFont(.body)))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(images.enumerated()), id: \.offset) { _, image in
                HostImage(source: image.1, alt: image.0)
            }
        }
    }
}

enum InlineText {
    /// Inline runs as one `Text`, its @files marked for `MentionChipRenderer` to draw their
    /// chips (a mark a `Text` carries, not an attributed string).
    static func text(_ inlines: [MarkdownInline], theme: Theme, style: Font.TextStyle = .body) -> Text {
        guard inlines.contains(where: mentions) else { return Text(attributed(inlines, theme: theme, style: style)) }
        enum Part {
            case words(AttributedString)
            case chip(AttributedString)
            case text(Text)
        }
        var parts: [Part] = []
        for inline in inlines {
            switch inline {
            case .link(_, let url) where url.hasPrefix(Mentions.scheme) || url.hasPrefix(SessionMentions.scheme):
                // Its chip in place of the band an attributed background draws.
                var words = attributed(inline, theme: theme, style: style)
                words.backgroundColor = nil
                parts.append(.chip(words))
            case .emphasis(let children) where children.contains(where: mentions):
                parts.append(.text(text(children, theme: theme, style: style).italic()))
            case .strong(let children) where children.contains(where: mentions):
                parts.append(.text(text(children, theme: theme, style: style).bold()))
            case .strike(let children) where children.contains(where: mentions):
                parts.append(.text(text(children, theme: theme, style: style).strikethrough()))
            default:
                if case .words(let before) = parts.last {
                    parts[parts.count - 1] = .words(before + attributed(inline, theme: theme, style: style))
                } else {
                    parts.append(.words(attributed(inline, theme: theme, style: style)))
                }
            }
        }
        // A chip reaches into the spaces beside it: they're kerned wider by as much (a space
        // between two chips for both).
        let reach = MentionChip.reach(AhType.uiFont(style).pointSize)
        for i in parts.indices {
            guard case .chip = parts[i] else { continue }
            if i > 0, case .words(var before) = parts[i - 1], !before.characters.isEmpty {
                // Through `.kern`: the attribute's key type spelled out crashed Swift 6.4's type
                // checker (constraints.size() == 1 in bindOverloadType), so the app didn't build.
                let last = before.characters.index(before: before.endIndex)
                before[last..<before.endIndex].kern = (before[last..<before.endIndex].kern ?? 0) + reach
                parts[i - 1] = .words(before)
            }
            if i + 1 < parts.count, case .words(var after) = parts[i + 1], !after.characters.isEmpty {
                let first = after.characters.index(after: after.startIndex)
                after[after.startIndex..<first].kern = reach
                parts[i + 1] = .words(after)
            }
        }
        var out = Text(verbatim: "")
        for part in parts {
            let piece: Text
            switch part {
            case .words(let words): piece = Text(words)
            case .chip(let words): piece = Text(words).customAttribute(MentionChipAttribute())
            case .text(let text): piece = text
            }
            out = Text("\(out)\(piece)")
        }
        return out
    }

    /// Whether an @file or #session chip link is in it, at any depth.
    private static func mentions(_ inline: MarkdownInline) -> Bool {
        switch inline {
        case .link(_, let url): url.hasPrefix(Mentions.scheme) || url.hasPrefix(SessionMentions.scheme)
        case .emphasis(let children), .strong(let children), .strike(let children): children.contains(where: mentions)
        default: false
        }
    }

    /// Inline runs as one attributed string: links tappable, code monospaced. `style` is the
    /// text style the run is drawn in, so code sits at the size of the words around it.
    static func attributed(_ inlines: [MarkdownInline], theme: Theme, style: Font.TextStyle = .body) -> AttributedString {
        var out = AttributedString()
        for inline in inlines { out += attributed(inline, theme: theme, style: style) }
        return out
    }

    static func attributed(_ inline: MarkdownInline, theme: Theme, style: Font.TextStyle = .body) -> AttributedString {
        switch inline {
        case .text(let s):
            return AttributedString(s.replacingOccurrences(of: "\n", with: " "))
        case .code(let s):
            // ah's mono a point under the text (it runs wider than Rubik), brighter than the
            // prose around it: SF Mono at body size stood a size above the sentence.
            var a = AttributedString(s)
            a.font = .ahMono(style)
            a.foregroundColor = theme.text
            a.backgroundColor = theme.raised
            return a
        case .emphasis(let children):
            var a = attributed(children, theme: theme, style: style)
            a.inlinePresentationIntent = .emphasized
            return a
        case .strong(let children):
            var a = attributed(children, theme: theme, style: style)
            a.inlinePresentationIntent = .stronglyEmphasized
            return a
        case .strike(let children):
            var a = attributed(children, theme: theme, style: style)
            a.strikethroughStyle = .single
            return a
        case .link(let text, let url):
            var a = attributed(text, theme: theme, style: style)
            if let target = URL(string: url) ?? URL(string: url.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "") {
                a.link = target
                a.foregroundColor = theme.accent
                // An @file or #session chip reads as a chip.
                if url.hasPrefix(Mentions.scheme) || url.hasPrefix(SessionMentions.scheme) { a.backgroundColor = theme.accent.opacity(0.12) }
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
                        cell(header[i]).font(.ah(.callout).weight(.semibold)).gridColumnAlignment(alignment(i))
                    }
                }
                Divider()
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r].indices, id: \.self) { i in
                            cell(rows[r][i]).font(.ah(.callout)).foregroundStyle(theme.text2)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(theme.sunken.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    /// A cell's words, and under them its pictures (a table of screenshots, side by side).
    @ViewBuilder private func cell(_ inlines: [MarkdownInline]) -> some View {
        let pictures = inlines.compactMap { inline -> (alt: String, src: String)? in
            if case .image(let alt, let src) = inline { return (alt, src) }
            return nil
        }
        if pictures.isEmpty {
            Text(InlineText.attributed(inlines, theme: theme, style: .callout))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                let words = inlines.filter { if case .image = $0 { false } else { true } }
                if words.contains(where: { !$0.plain.trimmingCharacters(in: .whitespaces).isEmpty }) {
                    Text(InlineText.attributed(words, theme: theme, style: .callout))
                }
                ForEach(Array(pictures.enumerated()), id: \.offset) { _, picture in
                    // Two side by side on a phone, as a before and after is read.
                    HostImage(source: picture.src, alt: picture.alt, maxHeight: 300, maxWidth: 170).frame(maxWidth: 170, alignment: .leading)
                }
            }
        }
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

/// A code block: scrolls sideways rather than wrapping, selectable, one-tap copy, and in a
/// live session's messages, Run in Terminal.
struct CodeBlockView: View {
    let code: String
    var language: String?
    var tone: Tone = .plain
    /// What Run types when the block shows more than the command: a tool's, under its `$ `.
    var command: String?
    @Environment(\.theme) private var theme
    @Environment(\.snippetRun) private var snippetRun
    @State private var copied = false

    enum Tone { case plain, command, error }

    /// What Run in Terminal would type: a shell's code, not Swift or JSON, and never an error.
    private var runs: String? {
        guard snippetRun != nil, tone != .error else { return nil }
        if let command { return command }
        return ShellRun.runs(language: language) ? code : nil
    }

    var body: some View {
        // The buttons sit beside the first line rather than on a row of their own, so a
        // one-line command is evenly padded, not a blank strip over it. A language names
        // the block above the code.
        VStack(alignment: .leading, spacing: 2) {
            if let language, !language.isEmpty {
                Text(language).font(.ahMono(.caption2)).foregroundStyle(theme.faint)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }
            HStack(alignment: .top, spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(theme.mono)
                        .foregroundStyle(tone == .error ? theme.danger : theme.text)
                        .textSelection(.enabled)
                        .padding(.leading, 12)
                        .padding(.trailing, 4)
                        .padding(.vertical, 11)
                }
                if let runs, let snippetRun {
                    Button {
                        Haptics.tap()
                        snippetRun.run(runs)
                    } label: {
                        glyph("terminal", tint: theme.muted)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Send to terminal")
                    .accessibilityHint("Runs in this session’s attached shell in \(snippetRun.place)")
                    .modifier(SnippetTypeMenu(snippet: runs, run: snippetRun))
                }
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Haptics.tap()
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    glyph(copied ? "checkmark" : "doc.on.doc", tint: copied ? theme.done : theme.muted)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
        }
        .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .leading) {
            if tone == .command { RoundedRectangle(cornerRadius: 1.5).fill(theme.run.opacity(0.6)).frame(width: 3) }
        }
    }

    private func glyph(_ name: String, tint: Color) -> some View {
        Image(systemName: name)
            .font(.ah(.footnote).weight(.medium))
            .contentTransition(.symbolEffect(.replace))
            .foregroundStyle(tint)
            // Grows with the glyph: at the largest text sizes a fixed 40 points let it spill
            // over the code beside it.
            .padding(.horizontal, 8)
            .frame(minWidth: 40, minHeight: 40)
            .contentShape(Rectangle())
    }
}

/// Held, a snippet's terminal button runs it or only types it there, to look at or change
/// before Return. Only where the host can type without running.
private struct SnippetTypeMenu: ViewModifier {
    let snippet: String
    let run: SnippetRun

    func body(content: Content) -> some View {
        if let type = run.type {
            content
                .contextMenu {
                    Button("Run in Terminal", systemImage: "play") {
                        Haptics.tap()
                        run.run(snippet)
                    }
                    Button("Type in Terminal Without Running", systemImage: "keyboard") {
                        Haptics.tap()
                        type(snippet)
                    }
                }
                .accessibilityAction(named: "Type in Terminal Without Running") { type(snippet) }
        } else {
            content
        }
    }
}

/// Numbered diff lines: additions and removals tinted, long lines scroll sideways together.
struct DiffLinesView: View {
    let lines: [DiffLine]
    var maxLines: Int? = nil
    /// Tap a line to act on it (comment, attach to the reviewer).
    var onLine: ((DiffLine) -> Void)? = nil
    /// The same, with the line's place among `lines` (what `selected` counts in).
    var onLineAt: ((Int, DiffLine) -> Void)? = nil
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
            // Long lines wrap under their own text (numbers and signs stay put): a side panel
            // or a phone is narrow, and sideways scrolling hides half of every change.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, line in
                    DiffLineRow(line: line, selected: selected.contains(index))
                        .overlay { if cursor == index { Rectangle().strokeBorder(theme.accentStrong, lineWidth: 1.5) } }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            onLine?(line)
                            onLineAt?(index, line)
                        }
                        .id(idPrefix.map { "\($0):\(index)" } ?? "\(index)")
                }
            }
            if let maxLines, lines.count > maxLines, !showAll {
                Button("Show all \(lines.count) lines") { showAll = true }
                    .font(.ah(.caption))
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
    /// Room for a four-digit line number at any text size.
    @ScaledMetric(relativeTo: .footnote) private var numberWidth: CGFloat = 38

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(line.number.map(String.init) ?? "")
                .frame(width: numberWidth, alignment: .trailing)
                .foregroundStyle(theme.faint)
                .padding(.trailing, 6)
            Text(sign)
                .frame(width: 14)
                .foregroundStyle(signColor)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .hunk || line.kind == .file ? theme.muted : theme.text)
                .fontWeight(line.kind == .file ? .semibold : .regular)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 10)
        }
        .font(.ahMono(.footnote))
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

/// An image from the host (authenticated) or inline data at once; one from the web (https)
/// only once it's tapped, since an agent's URL can carry what it read to whoever serves it.
struct HostImage: View {
    let source: String
    var alt = ""
    var maxHeight: CGFloat = 360
    /// Given, the picture is drawn at its own shape within this width and `maxHeight`, no
    /// taller (a table's cell, whose row took the whole of `maxHeight` around a wide picture).
    var maxWidth: CGFloat?
    @Environment(\.hostFiles) private var hostFiles
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    @State private var image: UIImage?
    @State private var failed = false
    /// A remote picture the person asked for: fetched, and kept asked while the app runs.
    @State private var asked = false

    /// Drawn again (a row laid out anew), it starts as it last ended: the picture, or the line
    /// saying it isn't there. Started over as loading, its row changed height and back.
    init(source: String, alt: String = "", maxHeight: CGFloat = 360, maxWidth: CGFloat? = nil) {
        self.source = source
        self.alt = alt
        self.maxHeight = maxHeight
        self.maxWidth = maxWidth
        _image = State(initialValue: Self.shown.object(forKey: source as NSString))
        _failed = State(initialValue: Self.missedLately(source))
        _asked = State(initialValue: Self.askedFor.contains(source))
    }

    /// The web address of a remote picture (read without decoding an inline one's data).
    private var remote: URL? {
        guard source.prefix(8).lowercased() == "https://", case .remote(let url) = WidgetModel.imageSource(source) else { return nil }
        return url
    }

    var body: some View {
        Group {
            if let image {
                // Tapped, in full (Quick Look: zoom, share, save); one from the web in the browser.
                Button {
                    Haptics.tap()
                    if let remote { openURL(remote); return }
                    guard let open = hostFiles?.open else { return }
                    Task { await open(source) }
                } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: fitted(image)?.width, height: fitted(image)?.height)
                        .frame(maxHeight: maxHeight)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .hoverEffect(.lift)
                }
                .buttonStyle(TilePress())
                .disabled(remote == nil && hostFiles?.open == nil)
                .accessibilityLabel(alt.isEmpty ? "Image" : alt)
                .accessibilityHint(remote == nil && hostFiles?.open == nil ? "" : "Opens it")
            } else if let remote, !asked {
                // Named, not fetched: a tap asks for it.
                Button {
                    Haptics.tap()
                    Self.askedFor.insert(source)
                    asked = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "photo").font(.ah(.title3)).foregroundStyle(theme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(alt.isEmpty ? "Load Image" : alt).font(.ah(.subheadline).weight(.semibold)).foregroundStyle(theme.text).lineLimit(2)
                            Text(remote.host() ?? remote.absoluteString).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    .frame(maxWidth: 360, alignment: .leading)
                    .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(TilePress())
                .hoverEffect(.highlight)
                .accessibilityLabel("\(alt.isEmpty ? "Image" : alt), from \(remote.host() ?? "the web")")
                .accessibilityHint("Loads it")
                .accessibilityIdentifier("remote-image")
            } else if failed {
                Label(alt.isEmpty ? "Image not available" : alt, systemImage: "photo").font(.ah(.caption)).foregroundStyle(theme.muted)
            } else {
                ProgressView().frame(height: 60)
            }
        }
        .task(id: asked ? "asked \(source)" : source) { await load() }
    }

    /// The picture's size within `maxWidth` and `maxHeight`, when there's a width to keep to.
    private func fitted(_ image: UIImage) -> CGSize? {
        guard let maxWidth, image.size.width > 0, image.size.height > 0 else { return nil }
        let scale = min(maxWidth / image.size.width, maxHeight / image.size.height)
        return CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
    }

    /// Remote pictures asked for while the app runs: scrolled back to, they load again unasked.
    @MainActor private static var askedFor: Set<String> = []

    /// Pictures already shown: a row scrolled back into view had fetched and decoded its
    /// picture again each time. Held to a size, not only a count: a session of screenshots
    /// held sixty of up to 20 MB each.
    private static let shown: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 60
        cache.totalCostLimit = 120 << 20
        return cache
    }()

    /// Pictures that weren't there, and when: asked for again only after a while (a host that
    /// was out of reach may be back).
    @MainActor private static var missing: [String: Date] = [:]

    @MainActor private static func missedLately(_ source: String) -> Bool {
        missing[source].map { Date.now.timeIntervalSince($0) < 60 } ?? false
    }

    private func load() async {
        if let seen = Self.shown.object(forKey: source as NSString) {
            image = seen
            return
        }
        guard !Self.missedLately(source), remote == nil || asked else { return }
        // A picture the agent drew comes inline, megabytes of base64: read off the main thread.
        let found = await Task.detached(priority: .userInitiated) { [source] in WidgetModel.imageSource(source) }.value
        let data: Data? = switch found {
        case .inline(let data): data
        case .hostFile(let path): await hostFiles?.load(path)
        case .remote(let url): await Self.fetch(url)
        case .unavailable: nil
        }
        if let data, let decoded = await Self.decode(data) {
            let bytes = decoded.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            Self.shown.setObject(decoded, forKey: source as NSString, cost: bytes)
            image = decoded
        }
        failed = image == nil
        if failed { Self.missing[source] = .now }
    }

    /// A remote picture, asked for: no cookies, cache or credentials go with it, and no more
    /// than 20 MB comes back.
    private nonisolated static func fetch(_ url: URL) async -> Data? {
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpShouldHandleCookies = false
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count <= 20 << 20 else { return nil }
        return data
    }

    /// Decoded off the main thread, at no more pixels than it's ever drawn at (a screenshot
    /// came in at full size, to be shown 360 points tall: a little over 1,000 pixels on a
    /// phone, and a reading column's width on an iPad).
    private nonisolated static func decode(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: 1440] as CFDictionary
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return UIImage(data: data) }
            return UIImage(cgImage: image)
        }.value
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
            if !message.isEmpty { Text(message) }
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
        .font(.ah(.caption))
        .foregroundStyle(theme.text2)
        .lineLimit(lines)
    }
}

