import Foundation

/// A Markdown file on the host read as a page (`MarkdownDocumentSheet`), as GitHub reads one:
/// its relative links and pictures (`shots/home.png`, `../README.md`) are files beside it.
extension Markdown {
    /// Whether a host path names a Markdown file, by its extension.
    static func isDocument(_ path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return ["md", "markdown", "mdown", "mkd"].contains(ext)
    }

    /// `blocks` as a page in `folder` (a host path, `/…` or `~/…`) reads them: a relative link or
    /// picture becomes the host path it names there, and a `file://` picture its path. Web links,
    /// absolute paths, anchors and anything with a scheme are left as they are.
    static func resolving(_ blocks: [MarkdownBlock], in folder: String) -> [MarkdownBlock] {
        blocks.map { resolving($0, in: folder) }
    }

    /// The host path a relative `target` names from `folder`, without its query or fragment and
    /// with its `.` and `..` walked; nil when it isn't relative (or `folder` isn't a host path).
    static func hostPath(_ target: String, in folder: String) -> String? {
        guard folder.hasPrefix("/") || folder == "~" || folder.hasPrefix("~/") else { return nil }
        let raw = target.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty, !raw.hasPrefix("/"), !raw.hasPrefix("~"), !raw.hasPrefix("#"), !raw.hasPrefix("?"), !hasScheme(raw) else { return nil }
        let bare = String(raw.prefix { $0 != "?" && $0 != "#" })
        let relative = bare.removingPercentEncoding ?? bare
        var parts = folder.split(separator: "/").map(String.init)
        let floor = parts.first == "~" ? 1 : 0
        for piece in relative.split(separator: "/") {
            switch piece {
            case ".": continue
            case "..": if parts.count > floor { parts.removeLast() }
            default: parts.append(String(piece))
            }
        }
        return floor == 1 ? parts.joined(separator: "/") : "/" + parts.joined(separator: "/")
    }

    /// `mailto:`, `https:`, `data:`, `C:`… : a scheme, so not a path.
    private static func hasScheme(_ raw: String) -> Bool {
        guard let colon = raw.firstIndex(of: ":"), let first = raw.first, first.isLetter else { return false }
        return raw[..<colon].allSatisfy { $0.isLetter || $0.isNumber || "+-.".contains($0) }
    }

    private static func resolving(_ block: MarkdownBlock, in folder: String) -> MarkdownBlock {
        switch block {
        case .heading(let level, let inlines): return .heading(level: level, resolving(inlines, in: folder))
        case .paragraph(let inlines): return .paragraph(resolving(inlines, in: folder))
        case .quote(let blocks): return .quote(resolving(blocks, in: folder))
        case .list(let ordered, let start, let items):
            return .list(ordered: ordered, start: start, items: items.map { .init(task: $0.task, blocks: resolving($0.blocks, in: folder)) })
        case .table(let header, let alignments, let rows):
            return .table(header: header.map { resolving($0, in: folder) }, alignments: alignments, rows: rows.map { $0.map { resolving($0, in: folder) } })
        case .code, .rule, .html: return block
        }
    }

    private static func resolving(_ inlines: [MarkdownInline], in folder: String) -> [MarkdownInline] {
        inlines.map { inline in
            switch inline {
            case .emphasis(let c): return .emphasis(resolving(c, in: folder))
            case .strong(let c): return .strong(resolving(c, in: folder))
            case .strike(let c): return .strike(resolving(c, in: folder))
            case .link(let text, let url): return .link(text: resolving(text, in: folder), url: hostPath(url, in: folder) ?? url)
            case .image(let alt, let src):
                if let path = hostPath(src, in: folder) { return .image(alt: alt, src: path) }
                // A picture linked as a file:// URL is the host's file, as a link of that kind is.
                if src.lowercased().hasPrefix("file:"), case .hostFile(let path) = LinkPolicy.classify(src) {
                    return .image(alt: alt, src: path.removingPercentEncoding ?? path)
                }
                return inline
            case .text, .code, .lineBreak: return inline
            }
        }
    }
}
