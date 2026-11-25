import Foundation

/// GitHub-flavored Markdown as the transcript, PR descriptions and reviewer replies use it,
/// parsed into blocks and inline runs the native views draw. HTML isn't interpreted: raw HTML
/// is shown as text, but for an `<img>`, read as the picture it names (its `src` and `alt`,
/// nothing else), as agents write them in a table of screenshots. Links keep their URL for the
/// view to vet before opening.
enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, [MarkdownInline])
    case paragraph([MarkdownInline])
    case code(language: String?, text: String)
    case quote([MarkdownBlock])
    case list(ordered: Bool, start: Int, items: [ListItem])
    case table(header: [[MarkdownInline]], alignments: [Alignment], rows: [[[MarkdownInline]]])
    case rule
    /// Raw HTML from the source: shown as text, never rendered.
    case html(String)

    struct ListItem: Equatable, Sendable {
        /// nil: not a task; true/false: a checked/unchecked task box.
        var task: Bool?
        var blocks: [MarkdownBlock]
    }

    enum Alignment: Equatable, Sendable { case leading, center, trailing, none }

    /// Text alone, which one run of selectable text can hold: a heading, a paragraph without
    /// images, or a list whose items hold only such paragraphs and lists.
    var isProse: Bool {
        switch self {
        case .heading: return true
        case .paragraph(let inlines): return !inlines.contains { if case .image = $0 { true } else { false } }
        case .list(_, _, let items):
            return items.allSatisfy { $0.blocks.allSatisfy { block in
                switch block {
                case .paragraph, .list: return block.isProse
                default: return false
                }
            } }
        default: return false
        }
    }
}

/// A stretch of blocks as selectable text draws it (`Markdown.runs`).
enum MarkdownRun: Equatable, Sendable {
    case prose([MarkdownBlock])
    case block(MarkdownBlock)
}

indirect enum MarkdownInline: Equatable, Sendable {
    case text(String)
    case code(String)
    case emphasis([MarkdownInline])
    case strong([MarkdownInline])
    case strike([MarkdownInline])
    case link(text: [MarkdownInline], url: String)
    case image(alt: String, src: String)
    case lineBreak

    /// The visible text, for copy, accessibility and search.
    var plain: String {
        switch self {
        case .text(let s), .code(let s): return s
        case .emphasis(let c), .strong(let c), .strike(let c): return c.map(\.plain).joined()
        case .link(let t, _): return t.map(\.plain).joined()
        case .image(let alt, _): return alt
        case .lineBreak: return "\n"
        }
    }
}

enum Markdown {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\t", with: "    ").components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        var parser = BlockParser(lines: lines)
        return parser.blocks()
    }

    /// As `parse`, with every line break kept as written (GitHub's comments do this): for words
    /// you typed yourself, where a new line meant one, not a space.
    static func parse(_ source: String, keepingLineBreaks: Bool) -> [MarkdownBlock] {
        let blocks = parse(source)
        return keepingLineBreaks ? blocks.map(hardBreaks) : blocks
    }

    /// As `parse`, remembered: a transcript row is built again each time it scrolls back into
    /// view and each time an update reaches it, and a long reply took milliseconds to read
    /// again every time. Forgotten wholesale once it holds a few hundred texts.
    @MainActor
    static func remembered(_ source: String, keepingLineBreaks: Bool) -> [MarkdownBlock] {
        let key = Remembered(source: source, keepingLineBreaks: keepingLineBreaks)
        if let blocks = remembered[key] { return blocks }
        if remembered.count >= 400 { remembered.removeAll(keepingCapacity: true) }
        let blocks = parse(source, keepingLineBreaks: keepingLineBreaks)
        remembered[key] = blocks
        return blocks
    }

    private struct Remembered: Hashable {
        let source: String
        let keepingLineBreaks: Bool
    }

    @MainActor private static var remembered: [Remembered: [MarkdownBlock]] = [:]

    private static func hardBreaks(_ block: MarkdownBlock) -> MarkdownBlock {
        switch block {
        case .heading(let level, let i): return .heading(level: level, hardBreaks(i))
        case .paragraph(let i): return .paragraph(hardBreaks(i))
        case .quote(let b): return .quote(b.map(hardBreaks))
        case .list(let ordered, let start, let items):
            return .list(ordered: ordered, start: start, items: items.map { MarkdownBlock.ListItem(task: $0.task, blocks: $0.blocks.map(hardBreaks)) })
        case .table(let header, let alignments, let rows):
            return .table(header: header.map(hardBreaks), alignments: alignments, rows: rows.map { $0.map(hardBreaks) })
        case .code, .rule, .html: return block
        }
    }

    /// A soft break is a "\n" left in a text run (drawn as a space); this makes each a break.
    private static func hardBreaks(_ inlines: [MarkdownInline]) -> [MarkdownInline] {
        inlines.flatMap { inline -> [MarkdownInline] in
            switch inline {
            case .text(let s) where s.contains("\n"):
                return s.components(separatedBy: "\n").enumerated().flatMap { index, part -> [MarkdownInline] in
                    (index > 0 ? [.lineBreak] : []) + (part.isEmpty ? [] : [.text(part)])
                }
            case .emphasis(let c): return [.emphasis(hardBreaks(c))]
            case .strong(let c): return [.strong(hardBreaks(c))]
            case .strike(let c): return [.strike(hardBreaks(c))]
            case .link(let t, let url): return [.link(text: hardBreaks(t), url: url)]
            default: return [inline]
            }
        }
    }

    /// The plain text of parsed blocks (copying a message, VoiceOver).
    static func plain(_ blocks: [MarkdownBlock]) -> String {
        blocks.map { block -> String in
            switch block {
            case .heading(_, let i), .paragraph(let i): return i.map(\.plain).joined()
            case .code(_, let t), .html(let t): return t
            case .quote(let b): return plain(b)
            case .list(_, _, let items): return items.map { plain($0.blocks) }.joined(separator: "\n")
            case .table(let header, _, let rows): return ([header] + rows).map { $0.map { $0.map(\.plain).joined() }.joined(separator: "\t") }.joined(separator: "\n")
            case .rule: return "—"
            }
        }.joined(separator: "\n\n")
    }

    /// Blocks as selectable text draws them: paragraphs, headings and lists of plain items
    /// that follow one another make one run, so a finger can select across them; code,
    /// quotes, tables, rules, raw HTML and paragraphs holding images stand alone.
    static func runs(_ blocks: [MarkdownBlock]) -> [MarkdownRun] {
        var out: [MarkdownRun] = []
        for block in blocks {
            if block.isProse, case .prose(let run) = out.last {
                out[out.count - 1] = .prose(run + [block])
            } else {
                out.append(block.isProse ? .prose([block]) : .block(block))
            }
        }
        return out
    }

    /// Words going into a reply as a quote: each line behind `> `, at most `limit` lines.
    static func quote(_ text: String, limit: Int = .max) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).prefix(limit).map { "> \($0)" }.joined(separator: "\n") + "\n\n"
    }

    /// Words selected in drawn prose, back as Markdown: a list's drawn marker (a bullet, a
    /// task box, a number) and its tab become `- ` or `N. `, a line break inside a paragraph
    /// a newline.
    static func source(ofSelected text: String) -> String {
        text.replacingOccurrences(of: "\u{2028}", with: "\n")
            .replacingOccurrences(of: "\u{200B}", with: "")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let tab = line.firstIndex(of: "\t") else { return String(line) }
                let marker = line[..<tab]
                let rest = line[line.index(after: tab)...]
                if marker == "•" || marker == "\u{FFFC}" { return "- " + rest }
                if marker.hasSuffix("."), marker.dropLast().allSatisfy(\.isNumber), !marker.dropLast().isEmpty { return marker + " " + rest }
                return String(line)
            }
            .joined(separator: "\n")
    }

    // MARK: Inline

    static func inline(_ text: String) -> [MarkdownInline] {
        var parser = InlineParser(Array(text))
        return parser.parse(until: nil)
    }
}

private struct BlockParser {
    let lines: [String]
    var i = 0

    init(lines: [String]) { self.lines = lines }

    static func indent(_ s: String) -> Int { s.prefix { $0 == " " }.count }
    static func isBlank(_ s: String) -> Bool { s.allSatisfy { $0 == " " } }

    static func fence(_ s: String) -> (marker: String, info: String)? {
        let t = s.drop { $0 == " " }
        guard indent(s) < 4 else { return nil }
        for m in ["```", "~~~"] where t.hasPrefix(m) {
            let ch = m.first!
            let run = t.prefix { $0 == ch }
            let info = t.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
            if ch == "`" && info.contains("`") { return nil }
            return (String(run), info)
        }
        return nil
    }

    static func heading(_ s: String) -> (Int, String)? {
        guard indent(s) < 4 else { return nil }
        let t = s.drop { $0 == " " }
        let hashes = t.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = t.dropFirst(hashes.count)
        guard rest.isEmpty || rest.first == " " else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // A closing run of #s goes.
        if let range = text.range(of: "\\s+#+$", options: .regularExpression) { text.removeSubrange(range) } else if text.allSatisfy({ $0 == "#" }) { text = "" }
        return (hashes.count, text)
    }

    static func isRule(_ s: String) -> Bool {
        guard indent(s) < 4 else { return false }
        let t = s.filter { $0 != " " }
        guard t.count >= 3, let c = t.first, "-*_".contains(c) else { return false }
        return t.allSatisfy { $0 == c }
    }

    /// "- x", "* x", "+ x", "1. x", "2) x": (ordered, start, content column, content).
    static func listMarker(_ s: String) -> (ordered: Bool, start: Int, width: Int, content: String)? {
        let pad = indent(s)
        guard pad < 4 else { return nil }
        let t = Array(s.dropFirst(pad))
        guard !t.isEmpty else { return nil }
        if "-*+".contains(t[0]) {
            guard t.count == 1 || t[1] == " " else { return nil }
            let content = t.count > 1 ? String(t[2...]) : ""
            return (false, 1, pad + 2, content)
        }
        var digits = ""
        var j = 0
        while j < t.count, t[j].isNumber, digits.count < 9 { digits.append(t[j]); j += 1 }
        guard !digits.isEmpty, j < t.count, t[j] == "." || t[j] == ")", j + 1 == t.count || t[j + 1] == " " else { return nil }
        let content = j + 2 <= t.count ? String(t[min(j + 2, t.count)...]) : ""
        return (true, Int(digits) ?? 1, pad + j + 2, content)
    }

    static func tableCells(_ s: String) -> [String]? {
        var t = s.trimmingCharacters(in: .whitespaces)
        guard t.contains("|") else { return nil }
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") && !t.hasSuffix("\\|") { t.removeLast() }
        var cells: [String] = []
        var cell = ""
        var escaped = false
        var inCode = false
        for c in t {
            if escaped { cell.append(c); escaped = false; continue }
            if c == "\\" { escaped = true; cell.append(c); continue }
            if c == "`" { inCode.toggle() }
            if c == "|" && !inCode {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(c)
            }
        }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells.map { $0.replacingOccurrences(of: "\\|", with: "|") }
    }

    static func alignments(_ s: String) -> [MarkdownBlock.Alignment]? {
        guard let cells = tableCells(s), !cells.isEmpty else { return nil }
        var out: [MarkdownBlock.Alignment] = []
        for cell in cells {
            let core = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !core.isEmpty, core.allSatisfy({ $0 == "-" }) else { return nil }
            switch (cell.hasPrefix(":"), cell.hasSuffix(":")) {
            case (true, true): out.append(.center)
            case (true, false): out.append(.leading)
            case (false, true): out.append(.trailing)
            default: out.append(.none)
            }
        }
        return out
    }

    /// Starts a block other than a paragraph (so a paragraph stops before it).
    func interrupts(_ s: String) -> Bool {
        Self.fence(s) != nil || Self.heading(s) != nil || Self.isRule(s) || s.drop(while: { $0 == " " }).hasPrefix(">")
            || (Self.listMarker(s).map { !$0.content.isEmpty && (!$0.ordered || $0.start == 1) } ?? false)
    }

    mutating func blocks() -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        while i < lines.count {
            let line = lines[i]
            if Self.isBlank(line) { i += 1; continue }
            if let (marker, info) = Self.fence(line) {
                let pad = Self.indent(line)
                i += 1
                var body: [String] = []
                while i < lines.count {
                    let l = lines[i]
                    let t = l.drop { $0 == " " }
                    if Self.indent(l) < 4, t.hasPrefix(marker), t.allSatisfy({ $0 == marker.first! || $0 == " " }) { i += 1; break }
                    body.append(String(l.dropFirst(min(pad, Self.indent(l)))))
                    i += 1
                }
                out.append(.code(language: info.isEmpty ? nil : String(info.split(separator: " ").first ?? ""), text: body.joined(separator: "\n")))
                continue
            }
            if let (level, text) = Self.heading(line) {
                out.append(.heading(level: level, Markdown.inline(text)))
                i += 1
                continue
            }
            if Self.isRule(line) {
                out.append(.rule)
                i += 1
                continue
            }
            if line.drop(while: { $0 == " " }).hasPrefix(">") {
                var inner: [String] = []
                while i < lines.count, !Self.isBlank(lines[i]) {
                    var t = Substring(lines[i]).drop { $0 == " " }
                    if t.hasPrefix(">") {
                        t = t.dropFirst()
                        if t.hasPrefix(" ") { t = t.dropFirst() }
                    } else if interrupts(lines[i]) { break }
                    inner.append(String(t))
                    i += 1
                }
                var sub = BlockParser(lines: inner)
                out.append(.quote(sub.blocks()))
                continue
            }
            if let marker = Self.listMarker(line) {
                out.append(list(ordered: marker.ordered, start: marker.start))
                continue
            }
            if i + 1 < lines.count, let header = Self.tableCells(line), let aligns = Self.alignments(lines[i + 1]), header.count == aligns.count {
                i += 2
                var rows: [[[MarkdownInline]]] = []
                while i < lines.count, !Self.isBlank(lines[i]), let cells = Self.tableCells(lines[i]) {
                    let padded = (cells + Array(repeating: "", count: max(0, header.count - cells.count))).prefix(header.count)
                    rows.append(padded.map(Markdown.inline))
                    i += 1
                }
                out.append(.table(header: header.map(Markdown.inline), alignments: aligns, rows: rows))
                continue
            }
            if line.drop(while: { $0 == " " }).hasPrefix("<"), let first = line.drop(while: { $0 == " " }).dropFirst().first, first.isLetter || first == "/" || first == "!" {
                var html: [String] = []
                while i < lines.count, !Self.isBlank(lines[i]) { html.append(lines[i]); i += 1 }
                let raw = html.joined(separator: "\n")
                // Pictures alone (`<img …>` after `<img …>`): a paragraph of them, not markup.
                let inlines = Markdown.inline(raw)
                if inlines.allSatisfy({ if case .image = $0 { true } else if case .text(let t) = $0 { t.allSatisfy(\.isWhitespace) } else { false } }), inlines.contains(where: { if case .image = $0 { true } else { false } }) {
                    out.append(.paragraph(inlines.filter { if case .image = $0 { true } else { false } }))
                } else {
                    out.append(.html(raw))
                }
                continue
            }
            // Paragraph: until a blank line or another block starts.
            var text: [String] = []
            while i < lines.count, !Self.isBlank(lines[i]) {
                if !text.isEmpty && interrupts(lines[i]) { break }
                if !text.isEmpty, i + 1 < lines.count, Self.tableCells(lines[i]) != nil, Self.alignments(lines[i + 1]) != nil { break }
                text.append(lines[i])
                i += 1
            }
            out.append(.paragraph(Markdown.inline(text.map { $0.trimmingLeadingWhitespace() }.joined(separator: "\n"))))
        }
        return out
    }

    /// A list and its items; an item's continuation lines are those indented past its marker.
    mutating func list(ordered: Bool, start: Int) -> MarkdownBlock {
        var items: [MarkdownBlock.ListItem] = []
        var loose = false
        while i < lines.count, let marker = Self.listMarker(lines[i]), marker.ordered == ordered {
            var body = [marker.content]
            i += 1
            var sawBlank = false
            while i < lines.count {
                let l = lines[i]
                if Self.isBlank(l) {
                    sawBlank = true
                    body.append("")
                    i += 1
                    continue
                }
                if Self.indent(l) >= marker.width {
                    body.append(String(l.dropFirst(marker.width)))
                    i += 1
                    sawBlank = false
                    continue
                }
                if sawBlank { break }
                // Lazy continuation of the item's paragraph.
                if Self.listMarker(l) == nil && !interrupts(l) {
                    body.append(l.trimmingLeadingWhitespace())
                    i += 1
                    continue
                }
                break
            }
            while body.last == "" { body.removeLast(); loose = true }
            var task: Bool?
            if let first = body.first {
                if first.hasPrefix("[ ] ") || first == "[ ]" { task = false; body[0] = String(first.dropFirst(min(4, first.count))) }
                else if first.lowercased().hasPrefix("[x] ") || first.lowercased() == "[x]" { task = true; body[0] = String(first.dropFirst(min(4, first.count))) }
            }
            var sub = BlockParser(lines: body)
            items.append(MarkdownBlock.ListItem(task: task, blocks: sub.blocks()))
            // A blank line then something that's not this list's next item ends it.
            if i < lines.count, Self.isBlank(lines[i - 1]) && Self.listMarker(lines[i]) == nil { break }
        }
        _ = loose
        return .list(ordered: ordered, start: start, items: items)
    }
}

private struct InlineParser {
    let chars: [Character]
    var i = 0
    /// For each delimiter, the earliest point a search for its closer found none (in text
    /// with no code in it): nothing later can find one either. A line of unmatched `*`s (a
    /// pasted log) searched to its end once per star.
    private var noCloser: [String: Int] = [:]

    init(_ chars: [Character]) { self.chars = chars }

    private static let punctuation = Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

    /// An `<img …>` tag at `at`: its alt, its src, and where the tag ends. Only these two
    /// attributes are read (width, style and the rest are left); without a src it's no picture.
    static func imgTag(_ chars: [Character], at start: Int) -> (alt: String, src: String, next: Int)? {
        guard start + 4 < chars.count, String(chars[(start + 1)...(start + 3)]).lowercased() == "img", chars[start + 4].isWhitespace || chars[start + 4] == "/" || chars[start + 4] == ">" else { return nil }
        var attributes: [String: String] = [:]
        var i = start + 4
        while i < chars.count {
            while i < chars.count, chars[i].isWhitespace || chars[i] == "/" { i += 1 }
            guard i < chars.count else { return nil }
            if chars[i] == ">" { break }
            var name = ""
            while i < chars.count, !chars[i].isWhitespace, chars[i] != "=", chars[i] != ">", chars[i] != "/" { name.append(chars[i]); i += 1 }
            guard !name.isEmpty else { return nil }
            while i < chars.count, chars[i].isWhitespace { i += 1 }
            var value = ""
            if i < chars.count, chars[i] == "=" {
                i += 1
                while i < chars.count, chars[i].isWhitespace { i += 1 }
                guard i < chars.count else { return nil }
                if chars[i] == "\"" || chars[i] == "'" {
                    let quote = chars[i]
                    i += 1
                    while i < chars.count, chars[i] != quote { value.append(chars[i]); i += 1 }
                    guard i < chars.count else { return nil }
                    i += 1
                } else {
                    while i < chars.count, !chars[i].isWhitespace, chars[i] != ">" { value.append(chars[i]); i += 1 }
                }
            }
            attributes[name.lowercased()] = value
        }
        guard i < chars.count, let src = attributes["src"]?.trimmingCharacters(in: .whitespaces), !src.isEmpty else { return nil }
        return (Self.entities(attributes["alt"] ?? ""), Self.entities(src), i + 1)
    }

    /// The few character references an attribute is written with (`&amp;` in a URL's query).
    private static func entities(_ s: String) -> String {
        guard s.contains("&") else { return s }
        return s.replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&amp;", with: "&")
    }
    private static let https = Array("https://"), http = Array("http://")

    mutating func parse(until closer: String?) -> [MarkdownInline] {
        var out: [MarkdownInline] = []
        var text = ""
        func flush() {
            if !text.isEmpty { out.append(.text(text)); text = "" }
        }
        while i < chars.count {
            if let closer, matches(closer) { break }
            let c = chars[i]
            switch c {
            case "\\":
                if i + 1 < chars.count, Self.punctuation.contains(chars[i + 1]) {
                    text.append(chars[i + 1])
                    i += 2
                } else if i + 1 < chars.count, chars[i + 1] == "\n" {
                    flush()
                    out.append(.lineBreak)
                    i += 2
                } else {
                    text.append(c)
                    i += 1
                }
            case "`":
                let run = count(of: "`", from: i)
                if let end = find(String(repeating: "`", count: run), from: i + run) {
                    flush()
                    var code = String(chars[(i + run)..<end]).replacingOccurrences(of: "\n", with: " ")
                    if code.count >= 2, code.hasPrefix(" "), code.hasSuffix(" "), code.contains(where: { $0 != " " }) { code = String(code.dropFirst().dropLast()) }
                    out.append(.code(code))
                    i = end + run
                } else {
                    text += String(repeating: "`", count: run)
                    i += run
                }
            case "!" where peek(1) == "[":
                if let (alt, src, next) = bracketLink(from: i + 1) {
                    flush()
                    out.append(.image(alt: alt.map(\.plain).joined(), src: src))
                    i = next
                } else {
                    text.append(c)
                    i += 1
                }
            case "[":
                if let (label, url, next) = bracketLink(from: i) {
                    flush()
                    out.append(.link(text: label, url: url))
                    i = next
                } else {
                    text.append(c)
                    i += 1
                }
            case "<" where Self.imgTag(chars, at: i) != nil:
                let (alt, src, next) = Self.imgTag(chars, at: i)!
                flush()
                out.append(.image(alt: alt, src: src))
                i = next
            case "<":
                // An autolink has no spaces in it: no need to look past the first.
                var end = i + 1
                while end < chars.count, chars[end] != ">", !chars[end].isWhitespace { end += 1 }
                if end < chars.count, chars[end] == ">", end > i + 1 {
                    let inner = String(chars[(i + 1)..<end])
                    if (inner.hasPrefix("http://") || inner.hasPrefix("https://") || inner.hasPrefix("mailto:")) && !inner.contains(" ") {
                        flush()
                        out.append(.link(text: [.text(inner)], url: inner))
                        i = end + 1
                        continue
                    }
                }
                text.append(c)
                i += 1
            case "*", "_":
                let run = min(count(of: c, from: i), 3)
                let leftFlanking = i + run < chars.count && !chars[i + run].isWhitespace
                let intraword = c == "_" && i > 0 && (chars[i - 1].isLetter || chars[i - 1].isNumber)
                let marker = String(repeating: c, count: run)
                if leftFlanking && !intraword, let close = closing(marker, from: i + run) {
                    flush()
                    var inner = InlineParser(Array(chars[(i + run)..<close]))
                    let content = inner.parse(until: nil)
                    switch run {
                    case 1: out.append(.emphasis(content))
                    case 2: out.append(.strong(content))
                    default: out.append(.strong([.emphasis(content)]))
                    }
                    i = close + run
                } else {
                    text += marker
                    i += run
                }
            case "~" where peek(1) == "~":
                if let close = closing("~~", from: i + 2) {
                    flush()
                    var inner = InlineParser(Array(chars[(i + 2)..<close]))
                    out.append(.strike(inner.parse(until: nil)))
                    i = close + 2
                } else {
                    text += "~~"
                    i += 2
                }
            case "\n":
                // Two trailing spaces make a hard break; otherwise a soft break is a space.
                if text.hasSuffix("  ") {
                    text = text.trimmingTrailingWhitespace()
                    flush()
                    out.append(.lineBreak)
                } else {
                    text.append("\n")
                }
                i += 1
            case "h" where autolinkStart():
                let start = i
                while i < chars.count, !chars[i].isWhitespace, chars[i] != "<" { i += 1 }
                var url = String(chars[start..<i])
                // Trailing punctuation isn't part of a bare URL.
                while let last = url.last, ".,;:!?)'\"".contains(last) {
                    if last == ")" && url.filter({ $0 == "(" }).count >= url.filter({ $0 == ")" }).count { break }
                    url.removeLast()
                    i -= 1
                }
                flush()
                out.append(.link(text: [.text(url)], url: url))
            default:
                text.append(c)
                i += 1
            }
        }
        flush()
        return out
    }

    func peek(_ n: Int) -> Character? { i + n < chars.count ? chars[i + n] : nil }

    func matches(_ s: String) -> Bool {
        has(Array(s), at: i)
    }

    /// Whether `a` is written at `j`, compared in place (a copy at every character was most
    /// of what reading a long reply cost).
    func has(_ a: [Character], at j: Int) -> Bool {
        guard j >= 0, j + a.count <= chars.count else { return false }
        for k in a.indices where chars[j + k] != a[k] { return false }
        return true
    }

    func count(of c: Character, from start: Int) -> Int {
        var n = 0
        while start + n < chars.count, chars[start + n] == c { n += 1 }
        return n
    }

    func find(_ s: String, from start: Int) -> Int? {
        let a = Array(s)
        var j = start
        while j + a.count <= chars.count {
            if has(a, at: j) && (j + a.count == chars.count || chars[j + a.count] != a[0] || a[0] != "`") {
                if a[0] == "`", j > start, chars[j - 1] == "`" { j += 1; continue }
                return j
            }
            j += 1
        }
        return nil
    }

    /// A closing delimiter run not preceded by whitespace.
    mutating func closing(_ marker: String, from start: Int) -> Int? {
        if let none = noCloser[marker], start >= none { return nil }
        let a = Array(marker)
        var j = start
        var code = false
        while j + a.count <= chars.count {
            if chars[j] == "`" {
                code = true
                let run = count(of: "`", from: j)
                if let end = find(String(repeating: "`", count: run), from: j + run) { j = end + run; continue }
            }
            if has(a, at: j), j > start, !chars[j - 1].isWhitespace {
                let after = j + a.count < chars.count ? chars[j + a.count] : " "
                if after != a[0] && !(a[0] == "_" && (after.isLetter || after.isNumber)) { return j }
            }
            j += 1
        }
        if !code { noCloser[marker] = min(noCloser[marker] ?? start, start) }
        return nil
    }

    /// `[label](url)` from `[`: label, URL, index after.
    func bracketLink(from start: Int) -> ([MarkdownInline], String, Int)? {
        var depth = 0
        var j = start
        var close: Int?
        while j < chars.count {
            if chars[j] == "\\" { j += 2; continue }
            if chars[j] == "`" {
                let run = count(of: "`", from: j)
                if let end = find(String(repeating: "`", count: run), from: j + run) { j = end + run; continue }
            }
            if chars[j] == "[" { depth += 1 }
            if chars[j] == "]" {
                depth -= 1
                if depth == 0 { close = j; break }
            }
            j += 1
        }
        guard let close, close + 1 < chars.count, chars[close + 1] == "(" else { return nil }
        var k = close + 2
        var parens = 1
        var url = ""
        while k < chars.count {
            if chars[k] == "(" { parens += 1 }
            if chars[k] == ")" {
                parens -= 1
                if parens == 0 { break }
            }
            url.append(chars[k])
            k += 1
        }
        guard k < chars.count else { return nil }
        // An optional "title" after the URL is dropped.
        var target = url.trimmingCharacters(in: .whitespaces)
        if let space = target.firstIndex(of: " ") { target = String(target[..<space]) }
        if target.hasPrefix("<") && target.hasSuffix(">") { target = String(target.dropFirst().dropLast()) }
        var label = InlineParser(Array(chars[(start + 1)..<close]))
        return (label.parse(until: nil), target, k + 1)
    }

    func autolinkStart() -> Bool {
        (has(Self.https, at: i) || has(Self.http, at: i)) && (i == 0 || chars[i - 1].isWhitespace || "(*_~".contains(chars[i - 1]))
    }
}

/// Which link targets a view may open, and how.
enum LinkPolicy {
    enum Target: Equatable, Sendable {
        /// https/http/mailto: in the browser.
        case external(URL)
        /// A path on the host: through ah's authenticated file API.
        case hostFile(String)
        /// Anything else (javascript:, another machine's file:, custom schemes): not opened.
        case refused(String)
    }

    static func classify(_ raw: String) -> Target {
        if raw.hasPrefix("/") || raw.hasPrefix("~/") { return .hostFile(raw) }
        // A file:// URL is how agents link a file on the host they run on: never this device's.
        if let path = fileURLPath(raw) { return .hostFile(path) }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return .refused(raw) }
        if ["https", "http"].contains(scheme), url.host != nil { return .external(url) }
        if scheme == "mailto" { return .external(url) }
        return .refused(raw)
    }

    /// The path of a `file:///…` (or `file://localhost/…`) URL, without a query or fragment; nil
    /// for anything else, a file on another machine (`file://server/…`) included.
    private static func fileURLPath(_ raw: String) -> String? {
        guard raw.lowercased().hasPrefix("file://") else { return nil }
        var rest = raw.dropFirst("file://".count)
        if rest.lowercased().hasPrefix("localhost/") { rest = rest.dropFirst("localhost".count) }
        guard rest.hasPrefix("/") else { return nil }
        let path = rest.prefix { $0 != "?" && $0 != "#" }
        return path.count > 1 ? String(path) : nil
    }
}
