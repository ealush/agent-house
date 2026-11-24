import SwiftUI
import UIKit

/// What selected words add to their edit menu, after Copy: the message's own actions, given
/// the words.
struct TextMenu: Sendable {
    let items: @MainActor @Sendable (_ selected: String) -> [UIMenuElement]
}

private struct TextMenuKey: EnvironmentKey {
    static let defaultValue: TextMenu? = nil
}

extension EnvironmentValues {
    /// Set, Markdown's prose is UIKit text you can select: press and hold picks a word,
    /// dragging on picks what the finger passes, and letting go shows the edit menu with
    /// these items after the system's.
    var textMenu: TextMenu? {
        get { self[TextMenuKey.self] }
        set { self[TextMenuKey.self] = newValue }
    }
}

/// A run of paragraphs, headings and lists (`Markdown.runs`) as one text view, so a selection
/// can cross them, drawn in the faces, colors and spacing of MarkdownView's SwiftUI text.
struct SelectableProse: UIViewRepresentable {
    let blocks: [MarkdownBlock]
    var compact = false
    let menu: TextMenu
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.messageTapped) private var messageTapped

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        // TextKit 2, as a nil container gives it: `init(usingTextLayoutManager:)` makes the view
        // without running a subclass's own initializers, so its chips' list was never there.
        let view = ProseTextView(frame: .zero, textContainer: nil)
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.dataDetectorTypes = []
        // Each link run carries the accent itself.
        view.linkTextAttributes = [:]
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.delegate = context.coordinator
        // A brief tap on the words, off a link: the message's actions (`\.messageTapped`).
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.menu = menu
        context.coordinator.openURL = openURL
        context.coordinator.messageTapped = messageTapped
        // Only new words or a new look replace the text: replacing it drops a selection.
        let look = Look(theme: theme, compact: compact, scheme: scheme, typeSize: typeSize)
        guard context.coordinator.shown?.blocks != blocks || context.coordinator.shown?.look != look else { return }
        context.coordinator.shown = (blocks, look)
        view.attributedText = ProseText(theme: theme, compact: compact).text(blocks)
        view.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else {
            return uiView.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        }
        let fit = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(fit.height))
    }

    struct Look: Equatable {
        let theme: Theme
        let compact: Bool
        let scheme: ColorScheme
        let typeSize: DynamicTypeSize
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var menu: TextMenu?
        var openURL: OpenURLAction?
        var messageTapped: (@MainActor @Sendable () -> Void)?
        var shown: (blocks: [MarkdownBlock], look: Look)?

        @objc func tapped(_ tap: UITapGestureRecognizer) {
            guard let messageTapped, let view = tap.view as? ProseTextView, let text = view.attributedText else { return }
            // A tap that lets go of a selection, or opens a link, does only that.
            guard !view.selectedAtTouch else { return }
            if let position = view.closestPosition(to: tap.location(in: view)) {
                let index = view.offset(from: view.beginningOfDocument, to: position)
                for i in [index, index - 1] where i >= 0 && i < text.length {
                    if text.attribute(.link, at: i, effectiveRange: nil) != nil { return }
                }
            }
            messageTapped()
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            let selected = (textView.attributedText.string as NSString).substring(with: range)
            // Right after the system's Copy, ahead of Look Up, Translate and Share.
            return UIMenu(children: suggestedActions.prefix(1) + (menu?.items(selected) ?? []) + suggestedActions.dropFirst())
        }

        // Links open the way MarkdownView's SwiftUI links do (LinkPolicy), not straight to the
        // system: a host path opens through the file API, a refused scheme not at all.
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [openURL] _ in openURL?(url) }
        }

        func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? {
            guard case .link(let url) = textItem.content else { return .init(menu: defaultMenu) }
            let raw = url.absoluteString.removingPercentEncoding ?? url.absoluteString
            if let uid = SessionMentions.uid(fromLink: raw) {
                let ref = "#\(uid)"
                return .init(menu: UIMenu(title: ref, children: [
                    UIAction(title: "Open Session", image: UIImage(systemName: "arrow.up.forward.square")) { [openURL] _ in openURL?(url) },
                    UIAction(title: "Copy Reference", image: UIImage(systemName: "doc.on.doc")) { _ in UIPasteboard.general.string = ref },
                ]))
            }
            return .init(menu: UIMenu(title: raw, children: [
                UIAction(title: "Open", image: UIImage(systemName: "arrow.up.forward.square")) { [openURL] _ in openURL?(url) },
                UIAction(title: "Copy Address", image: UIImage(systemName: "doc.on.doc")) { _ in UIPasteboard.general.string = raw },
            ]))
        }
    }
}

/// The prose's text view: what it has selected goes once it stops being the first responder,
/// and a tap anywhere in the transcript lets the selection go (`dropSelection`).
final class ProseTextView: UITextView {
    /// Words were selected when this touch began: a tap then only lets them go.
    private(set) var selectedAtTouch = false
    /// Whether the last `dropSelection` let words go. A tap on the words makes their view the
    /// first responder with nothing selected, so its answering says nothing by itself.
    static var dropped = false

    /// The chips behind its @files (`MentionChip`), and the text they were laid out for.
    private var chips: [UIView] = []
    private var chipsFor: (text: NSAttributedString, width: CGFloat)?

    override var attributedText: NSAttributedString! {
        didSet { setNeedsLayout() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutChips()
    }

    private func layoutChips() {
        let text = attributedText ?? NSAttributedString()
        if let done = chipsFor, done.width == bounds.width, done.text.isEqual(to: text) { return }
        chips.forEach { $0.removeFromSuperview() }
        chips = []
        guard bounds.width > 0 else { return }
        // TextKit 2 lays text out as it's shown: a reopened conversation's words may not be yet,
        // and their rects then are nothing.
        if let layout = textLayoutManager { layout.ensureLayout(for: layout.documentRange) }
        var measured = true
        text.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let url = value as? URL,
                  url.absoluteString.hasPrefix(Mentions.scheme) || url.absoluteString.hasPrefix(SessionMentions.scheme),
                  let font = text.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont else { return }
            let tint = text.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor ?? .tintColor
            let bearing = MentionChip.bearing(font.pointSize)
            let lines = chipLines(range)
            if lines.isEmpty { measured = false }
            for (i, line) in lines.enumerated() {
                let left = i == 0 ? line.minX + bearing : line.minX
                let right = i == lines.count - 1 ? line.maxX - bearing : line.maxX
                let chip = MentionChip.view(MentionChip.box(baseline: MentionChip.baseline(line, font: font), left: left, right: right, font: font), tint: tint)
                insertSubview(chip, at: 0)
                chips.append(chip)
            }
        }
        // Done for these words at this width once every chip found its place.
        chipsFor = measured ? (text, bounds.width) : nil
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        selectedAtTouch = selectedRange.length > 0
        super.touchesBegan(touches, with: event)
    }

    /// Sent up the responder chain (to nil): a selection in the transcript ends, if there's one.
    @objc func dropSelection() {
        Self.dropped = selectedAtTouch || selectedRange.length > 0
        selectedAtTouch = false
        _ = resignFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        guard super.resignFirstResponder() else { return false }
        selectedRange = NSRange(location: 0, length: 0)
        return true
    }
}

/// Markdown prose as an attributed string for UIKit: what BlockView, ParagraphView and
/// InlineText draw in SwiftUI, block for block.
@MainActor
struct ProseText {
    let theme: Theme
    let compact: Bool

    /// Between list items and between an item's own paragraphs (MarkdownView's compact gap).
    private let itemGap: CGFloat = 6
    /// Between a list marker and its text (BlockView's HStack spacing).
    private let markerGap: CGFloat = 8

    func text(_ blocks: [MarkdownBlock]) -> NSAttributedString {
        var lines: [NSAttributedString] = []
        for (i, block) in blocks.enumerated() {
            append(block, to: &lines, before: i == 0 ? 0 : (compact ? 6 : 10), indent: 0)
        }
        // One paragraph per line: each ends in a newline that keeps its own paragraph's style.
        let out = NSMutableAttributedString()
        for (i, line) in lines.enumerated() {
            out.append(line)
            if i < lines.count - 1 {
                out.append(NSAttributedString(string: "\n", attributes: line.attributes(at: max(0, line.length - 1), effectiveRange: nil)))
            }
        }
        // Each @file's chip reaches into the spaces beside it: they're kerned wider by as much (a
        // space between two chips for both).
        var room: [Int: CGFloat] = [:]
        out.enumerateAttribute(.link, in: NSRange(location: 0, length: out.length)) { value, range, _ in
            guard let url = value as? URL,
                  url.absoluteString.hasPrefix(Mentions.scheme) || url.absoluteString.hasPrefix(SessionMentions.scheme),
                  let font = out.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont else { return }
            for i in [range.location - 1, NSMaxRange(range)] where i >= 0 && i < out.length {
                room[i, default: 0] += MentionChip.reach(font.pointSize)
            }
        }
        for (i, kern) in room { out.addAttribute(.kern, value: kern, range: NSRange(location: i, length: 1)) }
        return out
    }

    private func append(_ block: MarkdownBlock, to lines: inout [NSAttributedString], before: CGFloat, indent: CGFloat) {
        switch block {
        case .heading(let level, let inlines):
            let style: Font.TextStyle = level == 1 ? .title2 : level == 2 ? .title3 : .headline
            let line = inline(inlines, style: style, weight: level <= 2 ? .bold : nil, color: UIColor(theme.text))
            // BlockView pads a heading 4 points above.
            lines.append(paragraph(line, before: before + 4, first: indent, rest: indent))
        case .paragraph(let inlines):
            lines.append(paragraph(inline(inlines, style: .body, color: UIColor(theme.text2)), before: before, first: indent, rest: indent))
        case .list(let ordered, let start, let items):
            let font = AhType.uiFont(.body)
            for (index, item) in items.enumerated() {
                let marker: NSAttributedString
                if let task = item.task {
                    let symbol = UIImage(systemName: task ? "checkmark.square.fill" : "square", withConfiguration: UIImage.SymbolConfiguration(font: font))?
                        .withTintColor(UIColor(task ? theme.done : theme.muted), renderingMode: .alwaysOriginal)
                    marker = symbol.map { NSAttributedString(attachment: NSTextAttachment(image: $0)) } ?? NSAttributedString()
                } else {
                    marker = NSAttributedString(string: ordered ? "\(start + index)." : "•", attributes: [.font: font, .foregroundColor: UIColor(theme.muted)])
                }
                // The text starts a gap after this item's own marker, as BlockView's HStack has it.
                let textIndent = indent + ceil(marker.size().width) + markerGap
                let itemBefore = index == 0 ? before : itemGap
                var first = true
                for inner in item.blocks.isEmpty ? [.paragraph([])] : item.blocks {
                    if first, case .paragraph(let inlines) = inner {
                        let line = NSMutableAttributedString(attributedString: marker)
                        line.append(NSAttributedString(string: "\t", attributes: [.font: font]))
                        line.append(inline(inlines, style: .body, color: UIColor(theme.text2)))
                        lines.append(paragraph(line, before: itemBefore, first: indent, rest: textIndent, tab: textIndent))
                    } else {
                        append(inner, to: &lines, before: first ? itemBefore : itemGap, indent: textIndent)
                    }
                    first = false
                }
            }
        default:
            // Markdown.runs keeps everything else out of a run of prose.
            break
        }
    }

    private func paragraph(_ text: NSAttributedString, before: CGFloat, first: CGFloat, rest: CGFloat, tab: CGFloat? = nil) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.paragraphSpacingBefore = before
        style.firstLineHeadIndent = first
        style.headIndent = rest
        style.tabStops = tab.map { [NSTextTab(textAlignment: .natural, location: $0)] } ?? []
        let out = NSMutableAttributedString(attributedString: text)
        out.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: out.length))
        if out.length == 0 {
            // An empty paragraph still needs its face, or its line takes the system's height.
            out.append(NSAttributedString(string: "\u{200B}", attributes: [.font: AhType.uiFont(.body), .paragraphStyle: style]))
        }
        return out
    }

    private struct Face {
        var bold = false
        var italic = false
        var mono = false
    }

    private func inline(_ inlines: [MarkdownInline], style: Font.TextStyle, weight: UIFont.Weight? = nil, color: UIColor, face: Face = Face()) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        for run in inlines {
            switch run {
            case .text(let s):
                out.append(NSAttributedString(string: s.replacingOccurrences(of: "\n", with: " "), attributes: [.font: font(style, weight: weight, face), .foregroundColor: color]))
            case .code(let s):
                var code = face
                code.mono = true
                out.append(NSAttributedString(string: s, attributes: [.font: font(style, weight: weight, code), .foregroundColor: UIColor(theme.text), .backgroundColor: UIColor(theme.raised)]))
            case .emphasis(let children):
                var italic = face
                italic.italic = true
                out.append(inline(children, style: style, weight: weight, color: color, face: italic))
            case .strong(let children):
                var bold = face
                bold.bold = true
                out.append(inline(children, style: style, weight: weight, color: color, face: bold))
            case .strike(let children):
                let struck = inline(children, style: style, weight: weight, color: color, face: face)
                struck.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: struck.length))
                out.append(struck)
            case .link(let children, let url):
                guard let target = URL(string: url) ?? URL(string: url.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "") else {
                    out.append(inline(children, style: style, weight: weight, color: color, face: face))
                    continue
                }
                let link = inline(children, style: style, weight: weight, color: theme.uiAccent, face: face)
                link.addAttribute(.link, value: target, range: NSRange(location: 0, length: link.length))
                // An @file reads as the composer's chip did: ProseTextView lays one behind it.
                out.append(link)
            case .image:
                // Markdown.runs keeps a paragraph with images out of a run of prose.
                continue
            case .lineBreak:
                // A line break inside the paragraph: its spacing and indents carry on.
                out.append(NSAttributedString(string: "\u{2028}", attributes: [.font: font(style, weight: weight, face)]))
            }
        }
        return out
    }

    private func font(_ style: Font.TextStyle, weight: UIFont.Weight?, _ face: Face) -> UIFont {
        var font = AhType.uiFont(style, weight: face.bold ? .bold : weight, mono: face.mono)
        // Font.ahMono: a point under the text around it.
        if face.mono { font = font.withSize(font.pointSize * (AhType.size(style) - 1) / AhType.size(style)) }
        if face.italic, let italic = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
            font = UIFont(descriptor: italic, size: font.pointSize)
        }
        return font
    }
}
