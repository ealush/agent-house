import Foundation

/// Return in a Markdown list, as notes apps do it: the next line starts the next item ("- ",
/// "- [ ] " for a task, "3. " after "2. ", "> " in a quote), at the same indent; Return on an
/// item with nothing in it ends the list instead.
enum NoteLists {
    /// What to put where for a Return typed at UTF-16 offset `at`; nil: an ordinary new line.
    static func continuation(of text: String, at: Int) -> (replace: NSRange, with: String)? {
        let ns = text as NSString
        guard at >= 0, at <= ns.length else { return nil }
        let lineStart = ns.lineRange(for: NSRange(location: at, length: 0)).location
        let head = ns.substring(with: NSRange(location: lineStart, length: at - lineStart))
        guard let marker = marker(head) else { return nil }
        let rest = head.dropFirst(marker.indent.count + marker.text.count)
        if rest.trimmingCharacters(in: .whitespaces).isEmpty {
            // An empty item: Return takes its marker away, leaving the line blank.
            return (NSRange(location: lineStart, length: at - lineStart), "")
        }
        return (NSRange(location: at, length: 0), "\n" + marker.indent + marker.next)
    }

    private struct Marker { let indent: String; let text: String; let next: String }

    private static func marker(_ line: String) -> Marker? {
        let indent = String(line.prefix { $0 == " " || $0 == "\t" })
        let body = line.dropFirst(indent.count)
        for bullet in ["- ", "* ", "+ "] {
            for box in ["[ ] ", "[x] ", "[X] "] where body.hasPrefix(bullet + box) {
                return Marker(indent: indent, text: bullet + box, next: bullet + "[ ] ")
            }
            if body.hasPrefix(bullet) { return Marker(indent: indent, text: bullet, next: bullet) }
        }
        if body.hasPrefix("> ") { return Marker(indent: indent, text: "> ", next: "> ") }
        let digits = body.prefix { $0.isASCII && $0.isNumber }
        if !digits.isEmpty, digits.count <= 9, let n = Int(digits) {
            let after = body.dropFirst(digits.count)
            for close in [". ", ") "] where after.hasPrefix(close) {
                return Marker(indent: indent, text: String(digits) + close, next: "\(n + 1)" + close)
            }
        }
        return nil
    }
}
