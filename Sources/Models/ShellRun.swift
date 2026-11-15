import Foundation

/// Shell snippets sent to the session’s attached terminal: runnable languages and prompt removal.
enum ShellRun {
    /// A code block in no language, or in a shell's, is something to run; Swift or JSON isn't.
    static func runs(language: String?) -> Bool {
        guard let language = language?.trimmingCharacters(in: .whitespaces).lowercased(), !language.isEmpty else { return true }
        return languages.contains(language)
    }

    private static let languages: Set<String> = ["sh", "bash", "zsh", "fish", "ksh", "nu", "shell", "console", "terminal", "shellsession", "shell-session"]

    /// What the shell is given: the words, less the marks that aren't part of the command.
    /// A `$ ` before every line is a prompt, copied with them. A `! ` before the first is
    /// Claude Code's (its box runs the rest in a shell); typed to a shell it's `!`, which flips
    /// the exit status, so `! cd x && make` never ran make.
    static func command(_ snippet: String) -> String {
        let text = snippet.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = text.components(separatedBy: "\n")
        let said = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if !said.isEmpty, said.allSatisfy({ $0.hasPrefix("$ ") }) {
            return lines.map { $0.hasPrefix("$ ") ? String($0.dropFirst(2)) : $0 }.joined(separator: "\n")
        }
        if text.hasPrefix("! ") { return String(text.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
        return text
    }

}
