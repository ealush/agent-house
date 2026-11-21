import Foundation

/// The attached terminal's text as it goes into a message: a fenced block its own backticks
/// can't close, so the agent reads it as the terminal showed it.
enum TerminalQuote {
    /// The text fenced, the fence longer than any run of backticks inside it.
    static func fenced(_ text: String, language: String = "") -> String {
        let body = text.trimmingTrailingNewlines
        var longest = 0
        var run = 0
        for c in body {
            run = c == "`" ? run + 1 : 0
            longest = max(longest, run)
        }
        let fence = String(repeating: "`", count: max(3, longest + 1))
        return "\(fence)\(language)\n\(body)\n\(fence)"
    }

    /// The command's line (its prompt too, as the terminal shows it) over what it printed.
    static func lastCommand(_ last: LastCommandDTO) -> String {
        let shown = [last.line, last.truncated ? "…" : nil, last.output.isEmpty ? nil : last.output].compactMap { $0 }.joined(separator: "\n")
        let block = fenced(shown, language: "console")
        return last.running ? "Still running; what it has printed so far:\n\(block)" : block
    }

    /// The same for the clipboard: the line and what it printed, unfenced.
    static func plain(_ last: LastCommandDTO) -> String {
        [last.line, last.output.isEmpty ? nil : last.output].compactMap { $0 }.joined(separator: "\n")
    }

    /// What the menu says the last command is: its first line, cut short.
    static func title(_ last: LastCommandDTO) -> String {
        let first = last.command.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let cut = first.count > 48 ? String(first.prefix(47)) + "…" : first
        return last.running ? "\(cut) · running" : cut
    }
}

private extension String {
    var trimmingTrailingNewlines: String {
        var s = Substring(self)
        while let last = s.last, last == "\n" || last == "\r" { s = s.dropLast() }
        return String(s)
    }
}
