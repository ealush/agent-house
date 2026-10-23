import Foundation

/// A session's model, effort and permission mode, and how a change applies
/// (`../ah/web/useLaunch.ts`, `web/ModelPicker.tsx`, `web/agents.ts`): live where the agent
/// has a command for it, else a relaunch of the same conversation (only while idle, with a
/// warning for dangerous modes), else the agent's own picker in its terminal.
struct LaunchState: Equatable, Sendable {
    let preset: PresetDTO?
    let model: PresetDTO.Model?
    let modelLabel: String?
    let effort: String?
    let mode: PresetDTO.Choice?
    let levels: [String]

    init(preset: PresetDTO?, session: SessionDTO?) {
        self.preset = preset
        let models = preset?.models ?? []
        // What the agent reports it runs beats what it was launched with.
        let live = Self.runningModel(models, session?.model)
        let chosen: PresetDTO.Model? = preset.flatMap { p in live ?? (session?.model != nil ? nil : Self.effectiveModel(p, session?.launchModel)) }
        model = chosen
        modelLabel = chosen?.name ?? Self.shortModel(session?.model)
        effort = session?.launchEffort ?? (session?.launchModel != nil ? nil : preset?.defaultEffort)
        mode = preset?.modes?.first { $0.id == (session?.launchMode ?? "default") }
        levels = preset.map { Self.levels($0, model: chosen?.id) } ?? []
    }

    /// The effort levels a model takes: its own list, else the agent's.
    static func levels(_ preset: PresetDTO, model: String?) -> [String] {
        (preset.models?.first { $0.id == model }?.efforts) ?? preset.effort?.levels ?? []
    }

    static func runningModel(_ models: [PresetDTO.Model], _ running: String?) -> PresetDTO.Model? {
        guard let running, !running.isEmpty else { return nil }
        let id = running.lowercased()
        return models.first { $0.id.lowercased() == id } ?? models.first { $0.id.count >= 4 && $0.id != "default" && id.contains($0.id.lowercased()) }
    }

    /// The model in effect: the chosen one, else the harness default.
    static func effectiveModel(_ preset: PresetDTO, _ id: String?) -> PresetDTO.Model? {
        let models = preset.models ?? []
        if let match = models.first(where: { $0.id == id }) { return match }
        if let id, id != "default" { return PresetDTO.Model(id: id, name: id, description: nil, efforts: nil, isDefault: nil) }
        return models.first { $0.isDefault == true }
    }

    private static let vendors: Set<String> = ["claude", "codex", "openai", "gpt", "gemini", "google", "grok", "xai", "muse", "meta", "hermes", "opencode", "anthropic"]

    /// "claude-haiku-4-5-20251001" → "Haiku 4.5", "gpt-6.1-sol" → "6.1 Sol".
    static func shortModel(_ model: String?) -> String? {
        guard var raw = model?.trimmingCharacters(in: .whitespaces) else { return nil }
        if raw.lowercased().hasSuffix("[1m]") { raw = String(raw.dropLast(4)) }
        guard !raw.isEmpty, raw.lowercased() != "default" else { return nil }
        let separators = CharacterSet(charactersIn: "-_/: +")
        let tokens = raw.components(separatedBy: separators).filter { t in
            !t.isEmpty && !(t.count >= 6 && t.allSatisfy(\.isNumber)) && t.lowercased() != "latest"
        }
        guard !tokens.isEmpty else { return nil }
        let kept = tokens.filter { !vendors.contains($0.lowercased()) }
        let parts = kept.isEmpty ? tokens : kept
        func title(_ t: String) -> String { t.first!.isNumber ? t : t.prefix(1).uppercased() + t.dropFirst().lowercased() }
        let family = parts[0]
        let rest = parts.dropFirst()
        let nums = rest.filter { $0.first!.isNumber }
        let word = rest.first { !$0.first!.isNumber && $0.lowercased() != family.lowercased() }
        var out = [title(family)]
        if !nums.isEmpty { out.append(nums.joined(separator: ".")) }
        if let word { out.append(title(word)) }
        let label = out.joined(separator: " ")
        return label.count > 20 ? String(label.prefix(19)) + "…" : label
    }

    enum Setting: String, Sendable { case model, effort, mode }

    struct Change: Equatable, Sendable {
        var model: String? = nil
        var effort: String? = nil
        var mode: String? = nil
    }

    /// What applying a choice takes, decided before anything is sent.
    enum Plan: Equatable, Sendable {
        case nothing
        /// The agent switches live (`/api/sessions/:uid/switch`); may be queued until it's free.
        case switchLive(Change)
        /// Restart the conversation with it (`/relaunch`); confirm first.
        case relaunch(Change, title: String, body: String, dangerous: Bool)
        /// Only the agent's own picker can do it (`/settings`), shown in its terminal.
        case terminalPicker(Setting)
        /// The server refuses a relaunch while the session works, waits or has a queue.
        case waitUntilIdle
        /// A live mode cycle, falling back to a relaunch (`/mode`).
        case switchMode(id: String, confirmDangerous: Bool)
    }

    func describe(_ change: Change) -> String {
        if change.model == "default" { return "the default model" }
        if let model = change.model { return preset?.models?.first { $0.id == model }?.name ?? model }
        if let mode = change.mode { return "\(preset?.modes?.first { $0.id == mode }?.name ?? mode) mode" }
        return change.effort == "default" ? "default effort" : "\(change.effort ?? "") effort"
    }

    /// A model or effort choice (`choose`).
    func plan(_ requested: Change, session: SessionDTO?) -> Plan {
        guard let preset, session != nil else { return .nothing }
        var change = requested
        let isModel = change.model != nil
        let live = isModel ? preset.switchModel : preset.switchEffort
        if (isModel ? change.model : change.effort) == "default", live != nil, (isModel ? preset.resetModel : preset.resetEffort) == nil {
            guard let named = isModel ? preset.defaultModel : preset.defaultEffort else { return .terminalPicker(isModel ? .model : .effort) }
            change = isModel ? Change(model: named) : Change(effort: named)
        }
        if live != nil {
            if let m = change.model, m != model?.id { return .switchLive(Change(model: m)) }
            if let e = change.effort, e != (effort ?? "default") { return .switchLive(Change(effort: e)) }
            return .nothing
        }
        return relaunchPlan(change, session: session!)
    }

    /// Permission mode (`chooseMode`).
    func planMode(_ id: String, session: SessionDTO?) -> Plan {
        guard let preset, let session, let target = preset.modes?.first(where: { $0.id == id }), id != mode?.id else { return .nothing }
        guard preset.modeCycle != nil else { return relaunchPlan(Change(mode: id), session: session) }
        return .switchMode(id: id, confirmDangerous: target.dangerous == true)
    }

    func relaunchPlan(_ change: Change, session: SessionDTO) -> Plan {
        let same = change.model != nil ? change.model == model?.id : change.mode != nil ? change.mode == mode?.id : change.effort == (effort ?? "default")
        if same { return .nothing }
        if session.status == .busy || session.status == .waiting || session.queued > 0 { return .waitUntilIdle }
        let what = describe(change)
        let dangerous = change.mode.flatMap { m in preset?.modes?.first { $0.id == m }?.dangerous } ?? false
        let body = (dangerous ? "It will run any command and edit any file without asking. " : "") + "The session restarts with the new setting; the conversation, queue and snapshots carry over."
        return .relaunch(change, title: "Relaunch with \(what)?", body: body, dangerous: dangerous)
    }

    /// Where a change of this setting happens, for the picker's footer.
    func footer(_ setting: Setting) -> String {
        switch setting {
        case .model: return preset?.switchModel != nil ? "Changes this session" : "Restarts this session with it"
        case .effort: return preset?.switchEffort != nil ? "Changes this session" : "Restarts this session with it"
        case .mode: return preset?.modeCycle != nil ? "Changes this session" : "Restarts this session with it"
        }
    }

    static let effortHints: [String: String] = [
        "none": "No extra reasoning", "minimal": "Fastest, least reasoning", "low": "Fast responses with lighter reasoning",
        "medium": "Balanced speed and depth", "high": "Deeper reasoning for harder problems", "xhigh": "Extended reasoning for long, agentic work",
        "max": "Maximum reasoning", "ultra": "Everything it has",
    ]
}

/// Composer completion (`../ah/web/Suggest.tsx`): "/" at the start lists slash commands,
/// "@" after a space lists project files.
struct CompletionTrigger: Equatable, Sendable {
    enum Kind: String, Sendable { case slash, file }
    let kind: Kind
    let query: String
    /// UTF-16 offsets of the text the pick replaces.
    let start: Int
    let end: Int

    static func at(_ text: String, caret: Int) -> CompletionTrigger? {
        let utf16 = Array(text.utf16)
        guard caret >= 0, caret <= utf16.count else { return nil }
        let before = String(decoding: utf16[..<caret], as: UTF16.self)
        if before.hasPrefix("/") {
            let query = String(before.dropFirst())
            if query.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == ":" || $0 == "." || $0 == "-" }) {
                return CompletionTrigger(kind: .slash, query: query, start: 0, end: caret)
            }
        }
        guard let atIndex = before.lastIndex(of: "@") else { return nil }
        let query = String(before[before.index(after: atIndex)...])
        guard !query.contains(where: { $0.isWhitespace || $0 == "@" }) else { return nil }
        if atIndex != before.startIndex, !before[before.index(before: atIndex)].isWhitespace { return nil }
        let start = caret - query.utf16.count - 1
        return CompletionTrigger(kind: .file, query: query, start: start, end: caret)
    }

    struct Item: Equatable, Sendable, Hashable {
        let value: String
        let label: String
        let detail: String?
    }

    /// Ranked slash commands (`rankCommands`): prefix, then contains, then description.
    static func rank(_ commands: [SlashCommand], query: String) -> [Item] {
        let q = query.lowercased()
        return commands.compactMap { c -> (SlashCommand, Int)? in
            let name = c.name.lowercased()
            let score = q.isEmpty ? 1 : name.hasPrefix(q) ? 3 : name.contains(q) ? 2 : c.description.lowercased().contains(q) ? 1 : 0
            return score > 0 ? (c, score) : nil
        }
        .enumerated().sorted { a, b in a.element.1 != b.element.1 ? a.element.1 > b.element.1 : a.offset < b.offset }
        .prefix(40)
        .map { pair in
            let c = pair.element.0
            let detail = [c.description, c.source == "built-in" ? "" : c.source].filter { !$0.isEmpty }.joined(separator: " · ")
            return Item(value: "/\(c.name) ", label: "/\(c.name)", detail: detail.isEmpty ? nil : detail)
        }
    }

    static func files(_ paths: [String]) -> [Item] {
        paths.prefix(40).map { Item(value: "@\($0) ", label: $0, detail: nil) }
    }

    /// The text with the pick in place, and where the caret goes.
    func applying(_ item: Item, to text: String) -> (text: String, caret: Int) {
        let utf16 = Array(text.utf16)
        let head = String(decoding: utf16[..<start], as: UTF16.self)
        let tail = String(decoding: utf16[min(end, utf16.count)...], as: UTF16.self)
        return (head + item.value + tail, start + item.value.utf16.count)
    }
}
