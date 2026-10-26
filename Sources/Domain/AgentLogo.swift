/// Which mark an agent draws (`../ah/web/logos.tsx`): its own logo from the asset catalog
/// (`scripts/agent-logos.sh`), or, for one added on a host without a known logo, its initial
/// in its tint.
enum AgentLogo {
    /// Agents with a logo in `App/Assets.xcassets/Agents`.
    static let known: Set<String> = [
        "claude", "codex", "gemini", "grok", "muse", "hermes", "opencode", "cursor", "copilot", "crush", "pi",
        "aider", "amp", "auggie", "cline", "codebuff", "droid", "goose", "jules", "kilocode", "kimi", "kiro",
        "openhands", "plandex", "qwen",
    ]
    /// Logos that are whole app icons (their own background): drawn edge to edge.
    static let tiles: Set<String> = ["hermes", "aider", "codebuff", "crush", "droid", "kiro"]

    /// Other names the same agents go by (a command, a company, a longer name).
    private static let alias: [String: String] = [
        "cursor-agent": "cursor", "github-copilot": "copilot", "augment": "auggie", "factory": "droid",
        "kilo-code": "kilocode", "kilo": "kilocode", "kiro-cli": "kiro", "qwen-code": "qwen",
    ]

    /// The logo an agent id draws: its own, or, for one added on the host ("custom-qwen-code"),
    /// the one its name matches. Nil when there's none.
    static func key(_ id: String) -> String? {
        let lower = id.lowercased()
        let bare = lower.hasPrefix("custom-") ? String(lower.dropFirst(7)) : lower
        let first = bare.split(separator: "-").first.map(String.init)
        return [lower, bare, alias[bare], first].compactMap { $0 }.first { known.contains($0) }
    }

    /// The initial a logo-less agent shows.
    static func initial(_ id: String) -> String {
        let lower = id.lowercased()
        let bare = lower.hasPrefix("custom-") ? lower.dropFirst(7) : Substring(lower)
        return bare.first { $0.isLetter || $0.isNumber }.map { String($0).uppercased() } ?? "?"
    }

    /// An agent's tint (`--c-<agent>`), dark theme then light, for its initial.
    static func tint(_ id: String) -> (dark: String, light: String) {
        switch key(id) {
        case "claude": return ("#f0a27c", "#a8511f")
        case "codex": return ("#8db4ff", "#2f5fd0")
        case "gemini": return ("#82aefa", "#2b5fc7")
        case "grok", "cursor": return ("#c9cdd4", "#3f4650")
        case "muse": return ("#c3a6f5", "#6d3fd4")
        case "hermes": return ("#eed27a", "#8a6300")
        case "opencode": return ("#6fd3bf", "#14705e")
        case "copilot": return ("#a5b4fc", "#4f46b8")
        case "crush": return ("#f2a3c7", "#a3336b")
        case "pi": return ("#f0c674", "#8a6300")
        default: return ("#a2a4b3", "#5f6272")
        }
    }
}
