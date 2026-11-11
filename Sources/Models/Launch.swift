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
        // A choice reached through an alias ("fable" for "claude-fable-5-1") is named for the
        // model really running: an alias's label names its newest model, which an older CLI
        // may not have.
        let viaAlias = live != nil && live?.id.lowercased() != session?.model?.lowercased()
        modelLabel = (viaAlias ? Self.shortModel(session?.model) : nil) ?? chosen?.name ?? Self.shortModel(session?.model)
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

    /// "claude-haiku-4-5-20251001" → "Haiku 4.5", "gpt-6.1-sol" → "6.1 Sol", "muse-wonder-full-1.0" → "Wonder Full 1.0".
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
        // A qualifier said before the version stays there: "Wonder Full 1.0", but "Spark 1.3 Contributor".
        let before = word.map { w in rest.firstIndex(of: w)! < (rest.firstIndex { $0.first!.isNumber } ?? rest.endIndex) } ?? false
        var out = [title(family)]
        if let word, before { out.append(title(word)) }
        if !nums.isEmpty { out.append(nums.joined(separator: ".")) }
        if let word, !before { out.append(title(word)) }
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

    /// How a level reads: by its name, but "xhigh" capitalized read like a typo.
    static func effortName(_ level: String) -> String {
        level.lowercased() == "xhigh" ? "Extra high" : level.capitalized
    }
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

// MARK: New session options beyond the presets (`../ah/web/NewDialog.tsx`, `ModelPicker.tsx`)

extension LaunchState {
    /// The agent takes a model it doesn't list ("Other model version").
    static func takesCustomModel(_ preset: PresetDTO) -> Bool { preset.modelArgs != nil }

    /// A model id typed by hand: a letter or digit, then letters, digits and `_ . : / @ -`,
    /// 80 characters at most (the web's `/^[A-Za-z0-9][\w.:/@-]{0,79}$/`).
    static func isValidModelID(_ id: String) -> Bool {
        let scalars = Array(id.unicodeScalars)
        guard let first = scalars.first, scalars.count <= 80, first.isASCII, first.properties.isAlphabetic || ("0"..."9").contains(first) else { return false }
        return scalars.dropFirst().allSatisfy { s in
            s.isASCII && (s.properties.isAlphabetic || ("0"..."9").contains(s) || "_.:/@-".unicodeScalars.contains(s))
        }
    }

    /// The model a new session asks for: a valid typed id wins over the list; the
    /// default (or nothing) sends nothing, so the agent's own default stays in charge.
    /// Where a new session starts by default: the project of the most recently active
    /// session that has one (`newestProject` in `../ah/web/NewDialog.tsx`).
    static func newestProject(_ rows: [SessionRow]) -> String? {
        rows.filter { !$0.dto.projectPath.isEmpty }.max { $0.dto.activity < $1.dto.activity }?.dto.projectPath
    }

    /// What New session remembers per agent and puts back next time: model and effort as
    /// chosen, and the permission mode unless it's a dangerous one (that's always a choice
    /// made on purpose, never a leftover).
    static func remembered(_ memory: DevicePreferences.LaunchMemory?, preset: PresetDTO) -> (mode: String, model: String?, effort: String?) {
        guard let memory else { return ("default", preset.defaultModel, preset.defaultEffort) }
        let mode = preset.modes?.first { $0.id == memory.mode && $0.dangerous != true }?.id ?? "default"
        let model = memory.model.flatMap { id in (preset.models ?? []).contains { $0.id == id } || (takesCustomModel(preset) && isValidModelID(id)) ? id : nil } ?? preset.defaultModel
        return (mode, model, effort(for: model, preset: preset, chosen: memory.effortsByModel, current: preset.defaultEffort))
    }

    /// The effort that goes with a model: the one last chosen with it, else the one already
    /// picked when this model takes it, else Default.
    static func effort(for model: String?, preset: PresetDTO, chosen: [String: String], current: String?) -> String? {
        let levels = levels(preset, model: model)
        if let last = chosen[model ?? "default"] {
            if last == "default" { return nil }
            if levels.contains(last) { return last }
        }
        return current.flatMap { levels.contains($0) ? $0 : nil }
    }

    /// What New session keeps after a start: the choices, and the effort beside the model it
    /// went with, so each model comes back with its own.
    static func remembering(_ memory: DevicePreferences.LaunchMemory?, mode: String, model: String?, effort: String?, trust: Bool?) -> DevicePreferences.LaunchMemory {
        var efforts = memory?.effortsByModel ?? [:]
        efforts[model ?? "default"] = effort ?? "default"
        return .init(mode: mode, model: model, effort: effort, efforts: efforts, trust: trust)
    }

    /// A fork's request (`../ah/web/ForkDialog.tsx`): the name and first message when given,
    /// the permission mode when the agent has a choice, and model or effort only where they
    /// differ from what the parent runs ("default" clears an inherited one).
    static func forkRequest(name: String, prompt: String, mode: String, modes: Int, inherited: (model: String?, effort: String?), picked: (model: String?, effort: String?)) -> ForkRequest {
        var request = ForkRequest()
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { request.name = name }
        if !prompt.isEmpty { request.prompt = prompt }
        if modes > 1 { request.mode = mode }
        if picked.model != inherited.model { request.model = picked.model ?? "default" }
        if picked.effort != inherited.effort { request.effort = picked.effort ?? "default" }
        return request
    }

    static func chosenModel(listed: String?, typed: String, preset: PresetDTO) -> String? {
        let custom = typed.trimmingCharacters(in: .whitespaces)
        if takesCustomModel(preset), !custom.isEmpty, isValidModelID(custom) { return custom }
        return listed != nil && listed != preset.defaultModel ? listed : nil
    }

    /// The tmux sessions to offer and which one starts chosen: the host's default when it
    /// exists, else the first; nil when there are none (a new one must be named).
    static func tmuxChoices(sessions: [String], defaultSession: String) -> (choices: [String], initial: String?) {
        (sessions, sessions.contains(defaultSession) ? defaultSession : sessions.first)
    }
}
