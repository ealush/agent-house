import Foundation

/// "@path" in parsed markdown: each mention of a file that's there becomes a link to it
/// (`Mentions.scheme`), in prose only. Code, inline or fenced, keeps what it says; a link's own
/// text isn't linked again inside it. ah's web/mentions.ts does the same with a remark plugin.
extension Markdown {
    /// The paths every mention in the prose names, to ask which are files.
    static func mentionPaths(_ blocks: [MarkdownBlock]) -> Set<String> {
        var paths = Set<String>()
        func inlines(_ list: [MarkdownInline]) {
            for inline in list {
                switch inline {
                case .text(let s): paths.formUnion(Mentions.find(s).map(\.path))
                case .emphasis(let c), .strong(let c), .strike(let c): inlines(c)
                case .code, .link, .image, .lineBreak: break
                }
            }
        }
        visit(blocks, inlines)
        return paths
    }

    /// The blocks with each mention of a path in `files` (as written → the path it opens)
    /// turned into its link.
    static func linkingMentions(_ blocks: [MarkdownBlock], files: [String: String]) -> [MarkdownBlock] {
        guard !files.isEmpty else { return blocks }
        func inlines(_ list: [MarkdownInline]) -> [MarkdownInline] {
            list.flatMap { inline -> [MarkdownInline] in
                switch inline {
                case .text(let s): return split(s, files)
                case .emphasis(let c): return [.emphasis(inlines(c))]
                case .strong(let c): return [.strong(inlines(c))]
                case .strike(let c): return [.strike(inlines(c))]
                case .code, .link, .image, .lineBreak: return [inline]
                }
            }
        }
        return map(blocks, inlines)
    }

    /// Turns session references (`#<uid>`, bare `<uid>`, or `https://host/#<uid>`) matching a
    /// known session (`uid → displayLabel`) into clickable `ah-session:<uid>` name chips.
    static func linkingSessions(_ blocks: [MarkdownBlock], sessions: [String: String]) -> [MarkdownBlock] {
        guard !sessions.isEmpty else { return blocks }
        func inlines(_ list: [MarkdownInline]) -> [MarkdownInline] {
            list.flatMap { inline -> [MarkdownInline] in
                switch inline {
                case .text(let s):
                    return splitSessions(s, sessions)
                case .link(let label, let url):
                    if let uid = SessionMentions.uid(fromWebURL: url), let title = sessions[uid] {
                        let plain = label.map(\.plain).joined()
                        let nextLabel: [MarkdownInline] = plain == url ? [.text(title)] : label
                        return [.link(text: nextLabel, url: SessionMentions.link(uid))]
                    }
                    return [inline]
                case .emphasis(let c): return [.emphasis(inlines(c))]
                case .strong(let c): return [.strong(inlines(c))]
                case .strike(let c): return [.strike(inlines(c))]
                case .code, .image, .lineBreak: return [inline]
                }
            }
        }
        return map(blocks, inlines)
    }

    private static func splitSessions(_ text: String, _ sessions: [String: String]) -> [MarkdownInline] {
        let found = SessionMentions.find(text).filter { sessions[$0.uid] != nil }
        guard !found.isEmpty else { return [.text(text)] }
        let ns = text as NSString
        var out: [MarkdownInline] = []
        var at = 0
        for r in found {
            if r.range.location > at {
                out.append(.text(ns.substring(with: NSRange(location: at, length: r.range.location - at))))
            }
            let label = sessions[r.uid] ?? r.uid
            out.append(.link(text: [.text(label)], url: SessionMentions.link(r.uid)))
            at = r.range.location + r.range.length
        }
        if at < ns.length { out.append(.text(ns.substring(from: at))) }
        return out
    }

    private static func split(_ text: String, _ files: [String: String]) -> [MarkdownInline] {
        let found = Mentions.find(text).filter { files[$0.path] != nil }
        guard !found.isEmpty else { return [.text(text)] }
        let ns = text as NSString
        var out: [MarkdownInline] = []
        var at = 0
        for m in found {
            if m.range.location > at { out.append(.text(ns.substring(with: NSRange(location: at, length: m.range.location - at)))) }
            out.append(.link(text: [.text(ns.substring(with: m.range))], url: Mentions.link(files[m.path]!)))
            at = m.range.location + m.range.length
        }
        if at < ns.length { out.append(.text(ns.substring(from: at))) }
        return out
    }

    private static func visit(_ blocks: [MarkdownBlock], _ inlines: ([MarkdownInline]) -> Void) {
        for block in blocks {
            switch block {
            case .heading(_, let i), .paragraph(let i): inlines(i)
            case .quote(let b): visit(b, inlines)
            case .list(_, _, let items): items.forEach { visit($0.blocks, inlines) }
            case .table(let header, _, let rows):
                header.forEach(inlines)
                rows.forEach { $0.forEach(inlines) }
            case .code, .rule, .html: break
            }
        }
    }

    private static func map(_ blocks: [MarkdownBlock], _ inlines: ([MarkdownInline]) -> [MarkdownInline]) -> [MarkdownBlock] {
        blocks.map { block in
            switch block {
            case .heading(let level, let i): return .heading(level: level, inlines(i))
            case .paragraph(let i): return .paragraph(inlines(i))
            case .quote(let b): return .quote(map(b, inlines))
            case .list(let ordered, let start, let items):
                return .list(ordered: ordered, start: start, items: items.map { MarkdownBlock.ListItem(task: $0.task, blocks: map($0.blocks, inlines)) })
            case .table(let header, let alignments, let rows):
                return .table(header: header.map(inlines), alignments: alignments, rows: rows.map { $0.map(inlines) })
            case .code, .rule, .html: return block
            }
        }
    }
}
