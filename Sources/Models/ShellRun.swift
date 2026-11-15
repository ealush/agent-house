import Foundation

/// A snippet from a conversation run in a shell (a code block's Run, Run in Terminal on
/// selected words): what's typed, and which shell takes it.
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

    /// The shell it's typed into: one of the session's host's shells in the session's folder,
    /// waiting at its prompt, the one used last. One running a server or an editor would take
    /// the words as its own input. Nil: start one.
    static func shell(for session: SessionRow, among rows: [SessionRow]) -> SessionRow? {
        rows.filter { row in
            row.host == session.host && row.key != session.key && row.dto.agent == nil
                && row.dto.cwd == session.dto.cwd && prompts.contains(name(row.dto.command))
        }
        .max { $0.dto.activity < $1.dto.activity }
    }

    /// A pane at its shell's prompt has the shell as its foreground command (`-zsh` when it's
    /// a login shell).
    private static let prompts: Set<String> = ["bash", "zsh", "fish", "sh", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh"]

    private static func name(_ command: String) -> String {
        let word = command.trimmingCharacters(in: .whitespaces)
        return String((word.hasPrefix("-") ? word.dropFirst() : Substring(word)).split(separator: "/").last ?? "")
    }
}
