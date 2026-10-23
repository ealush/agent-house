import Foundation

/// What a waiting agent asks, in parts, so every place that shows it (Inbox card, the
/// GUI's ask panel, the bar under the terminal, a notification) draws the same thing
/// (`../ah/web/askView.ts`, `web/screenText.ts`). Never the raw screen as the message.
struct AskParts: Equatable, Sendable {
    /// What it wants, in words: "Wants to run a command", "Asked you".
    let kind: String
    let command: String?
    let description: String?
    let question: String?
    /// The rest of what the screen shows, for "Show terminal text".
    let context: String?

    static func kindLabel(_ kind: AskDTO.Kind) -> String {
        switch kind {
        case .command: return "Wants to run a command"
        case .tool: return "Wants to use a tool"
        case .question: return "Asked a question"
        case .screen: return "Waiting for you"
        case .choice: return "Asked you"
        }
    }

    init(kind: String, command: String? = nil, description: String? = nil, question: String? = nil, context: String? = nil) {
        self.kind = kind
        self.command = command
        self.description = description
        self.question = question
        self.context = context
    }

    init(_ ask: AskDTO, detail: String? = nil) {
        let kind = Self.kindLabel(ask.kind)
        let text = ask.text
        let question = ScreenText.questionLine(text)
        switch ask.kind {
        case .command:
            let lines = ScreenText.clean(text).split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && !Self.isHeading($0) && $0 != question }
            // A hook's detail ("$ pnpm test") is the command exactly; the screen's first line otherwise.
            let hooked = detail.flatMap { $0.hasPrefix("$ ") ? String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces) : nil }
            let command = hooked ?? lines.first
            let rest = hooked.map { h in lines.filter { !h.contains($0) } } ?? Array(lines.dropFirst())
            self.init(
                kind: kind,
                command: command,
                description: rest.count == 1 ? rest[0] : nil,
                question: question.flatMap { Self.isGeneric($0) ? nil : $0 },
                context: text.contains("\n") ? ScreenText.clean(text) : nil
            )
        case .choice:
            let q = ask.dialog?.question ?? ask.questions?.first?.question ?? (text.isEmpty ? nil : text)
            self.init(kind: kind, question: q)
        default:
            let context = ScreenText.clean(text, dropping: question)
            self.init(kind: kind, question: question, context: context.isEmpty ? nil : context)
        }
    }

    /// One line for a lock screen or a list row (`server/push.ts askLine`).
    static func line(_ ask: AskDTO?) -> String {
        guard let ask else { return "" }
        func first(_ t: String) -> String {
            t.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        }
        func short(_ t: String) -> String { t.count > 120 ? String(t.prefix(119)) + "…" : t }
        switch ask.kind {
        case .command:
            let lines = ask.text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            let cmd = lines.first == "Bash command" ? (lines.count > 1 ? lines[1] : nil) : lines.first
            return cmd.map { short("Wants to run \($0)") } ?? "Wants to run a command"
        case .choice, .question: return short("Asks: \(first(ask.text))")
        case .tool: return short(first(ask.text))
        case .screen: return "Wants your answer"
        }
    }

    private static func isHeading(_ line: String) -> Bool {
        ["bash command", "shell command", "run command"].contains(line.lowercased())
    }

    private static func isGeneric(_ question: String) -> Bool {
        question.lowercased() == "do you want to proceed?"
    }
}

enum ScreenText {
    /// The prompt's own question: the last line ending with "?".
    static func questionLine(_ text: String) -> String? {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.last { $0.hasSuffix("?") }
    }

    private static let ruleCharacters: Set<Character> = Set(" \t─━╌╍┄┅┈┉╴╶-–—_=·•.…⎯")

    /// Screen text without the TUI's rules and with its 80-column wrapping undone.
    static func clean(_ text: String, dropping drop: String? = nil) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).filter { line in
            let isRule = !line.isEmpty && line.allSatisfy { ruleCharacters.contains($0) }
            return !isRule && (drop == nil || line.trimmingCharacters(in: .whitespaces) != drop)
        }
        return unwrap(lines).joined(separator: "\n").trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
    }

    /// Join lines the TUI broke only because the window was narrow.
    static func unwrap(_ lines: [String]) -> [String] {
        let width = lines.map { $0.trimmingTrailingWhitespace().count }.max() ?? 0
        guard width >= 40 else { return lines.map { $0.trimmingCharacters(in: .whitespaces) } }
        var out: [String] = []
        for (i, raw) in lines.enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let carries: Bool = {
                guard i > 0, !out.isEmpty, lines[i - 1].trimmingTrailingWhitespace().count >= width - 12 else { return false }
                var chars = raw.makeIterator()
                var c = chars.next()
                if c == " " { c = chars.next() }
                return c.map { $0.isLowercase && $0.isASCII } ?? false
            }()
            if !carries {
                out.append(line)
                continue
            }
            let last = out[out.count - 1]
            let token = last.split(separator: " ").last.map(String.init) ?? last
            let glue = (!last.contains(" ") || token.count > 24) ? "" : " "
            out[out.count - 1] = last + glue + line
        }
        return out
    }
}

extension String {
    func trimmingTrailingWhitespace() -> String {
        var s = self
        while let last = s.last, last.isWhitespace { s.removeLast() }
        return s
    }
}
