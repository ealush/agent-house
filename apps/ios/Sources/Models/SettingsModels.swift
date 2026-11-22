import Foundation
import Observation

/// Settings → Security (`apps/server/web/Security.tsx`): this device, signed-in devices and native
/// devices, setup codes for a new device, passkeys and machine tokens, activity.
@MainActor
@Observable
final class SecuritySettings {
    let api: APIClient
    private(set) var overview: AuthOverview?
    private(set) var code: SetupCode?
    private(set) var error: String?
    private(set) var notice: String?

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            overview = try await settled { [api] in try await api.authOverview() }
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    private func act(_ success: String?, _ body: () async throws -> Void) async {
        do {
            try await body()
            notice = success
            error = nil
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// A one-time code another device enrolls with (valid ten minutes).
    func newCode() async { await act(nil) { code = try await api.issueSetupCode() } }
    func revoke(_ signIn: AuthOverview.SignIn) async { await act("Signed out \(signIn.label).") { try await api.revokeSession(signIn.id) } }
    func signOutOthers() async { await act("Every other device was signed out.") { try await api.signOutEverywhere() } }
    func removePasskey(_ passkey: AuthOverview.Passkey) async { await act("Removed \(passkey.label).") { try await api.removePasskey(passkey.id) } }
    func removeDevice(_ device: AuthOverview.Device) async { await act("Removed \(device.label).") { try await api.removeDevice(device.id) } }
    func removeToken(_ token: AuthOverview.Token) async { await act("Revoked \(token.name).") { try await api.removeToken(token.id) } }

    /// A token just made: its name and secret, shown once and kept only until dismissed.
    private(set) var newToken: (name: String, secret: String)?

    func createToken(name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        await act(nil) { newToken = (name, try await api.createToken(name: name)) }
    }

    func dismissToken() { newToken = nil }
    func clearPrompts() async { await act("Prompt history cleared.") { try await api.clearPrompts() } }

    /// The audit log as rows: when, what, from where.
    var activity: [(at: String, date: Date?, event: String, detail: String)] {
        (overview?.audit ?? []).map { entry in
            let at = entry["at"].text
            let event = entry["event"].text
            let rest = (entry.object ?? [:]).filter { $0.key != "at" && $0.key != "event" }.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.text)" }.joined(separator: " · ")
            return (at, Self.date(at), Self.eventName(event), rest)
        }
    }

    /// The host writes ISO 8601 with milliseconds ("2026-11-16T00:01:03.858Z").
    static func date(_ text: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// An event as words: its name where it has one, else its key spelled out ("review.merge"
    /// reads "Review merge"), never the key itself.
    static func eventName(_ event: String) -> String {
        if let name = eventNames[event] { return name }
        let words = event.replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    static let eventNames: [String: String] = [
        "auth.signin": "Signed in", "auth.signout": "Signed out", "auth.failed": "Sign-in failed", "auth.code_issued": "Setup code issued",
        "auth.passkey_added": "Passkey added", "auth.passkey_removed": "Passkey removed", "auth.device_added": "Device enrolled",
        "auth.device_removed": "Device removed", "auth.token_created": "Token created", "auth.token_removed": "Token revoked",
        "auth.password_set": "Master password set", "auth.password_removed": "Master password removed", "auth.preview_session": "Preview opened",
        "session.create": "Session started", "session.send": "Message sent", "session.approve": "Approved", "session.deny": "Denied",
        "session.kill": "Session terminated", "file.upload": "File uploaded", "push.apns.register": "Notifications registered",
        "session.resume": "Session resumed", "session.fork": "Session forked", "session.relaunch": "Session relaunched",
        "session.interrupt": "Turn stopped", "session.branch": "Branch switched", "session.mode": "Permission mode changed",
        "session.switch": "Model or effort changed", "session.restore": "Files restored", "session.choose": "Choice answered",
        "session.questions": "Questions answered", "snapshot.restore": "Snapshot restored", "project.create": "Space created",
        "worktree.remove": "Worktree removed", "terminal.close": "Terminal closed", "preview.start": "Preview started", "preview.stop": "Preview stopped",
        "review.stack": "Review started", "review.link": "Review linked to GitHub", "review.merge": "Pull request merged",
        "review.ready": "Marked ready for review", "review.remove": "Review deleted", "review.resolve": "Finding resolved",
        "review.retarget": "Pull request retargeted", "review.dispatch": "Fixes sent to an agent", "prompts.clear": "Prompt history cleared",
        "subscription.save": "Provider saved", "subscription.remove": "Provider removed", "subscription.default": "Default provider set",
        "env.save": "Variable saved", "env.remove": "Variable removed", "harnesses.add": "Agent added", "harnesses.remove": "Agent removed",
        "harnesses.check": "Agent versions checked", "search.rebuild": "Search index rebuilt", "system.restart": "Agent House restarted",
        "system.rebuild": "Agent House rebuilt", "system.uploads.clear": "Uploaded files cleared",
    ]
}

/// Settings → Agents (`web/AgentsSettings.tsx`).
@MainActor
@Observable
final class AgentsSettings {
    let api: APIClient
    private(set) var harnesses: Harnesses?
    private(set) var checking = false
    private(set) var error: String?

    init(api: APIClient) { self.api = api }

    private func run(_ body: () async throws -> Harnesses) async {
        do {
            harnesses = try await body()
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    func load() async { await run { [api] in try await settled { try await api.harnesses() } } }
    func check() async {
        checking = true
        defer { checking = false }
        await run { try await api.checkHarnesses() }
    }
    func setHidden(_ agent: HarnessInfo, _ hidden: Bool) async { await run { try await api.setHarnessHidden(agent.id, hidden: hidden) } }
    /// True when it was added (the sheet closes then, and only then).
    func add(name: String, command: String, resume: String?) async -> Bool {
        await run { try await api.addHarness(name: name, command: command, resume: resume) }
        return error == nil
    }
    func remove(_ agent: HarnessInfo) async { await run { try await api.removeHarness(agent.id) } }
}

/// Settings → Voice (`docs/spec/14-voice.md`): which subscription hears a dictation
/// (none: this device does), which tidies it and how, the language, the words to spell
/// right. Each change saves at once, as Settings' switches do.
@MainActor
@Observable
final class VoiceSettingsModel {
    let api: APIClient
    /// The host announces `features.voice`; without it only this device's side shows. Nil
    /// until the host's state has come in.
    private(set) var hostDoesVoice: Bool?
    private(set) var settings: VoiceSettings?
    private(set) var subscriptions: [Subscription] = []
    /// What the speech subscription's endpoint lists as speech models.
    private(set) var speechModels: [String] = []
    /// What the cleanup subscription's endpoint lists as chat models.
    private(set) var chatModels: [String] = []
    private(set) var error: String?
    private(set) var loaded = false

    init(api: APIClient) { self.api = api }

    /// The model a speech subscription starts with: the fastest Whisper where there is one.
    nonisolated static func preferredSpeechModel(_ listed: [String]) -> String? {
        for wanted in ["whisper-large-v3-turbo", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-large-v3", "whisper-1"] where listed.contains(wanted) { return wanted }
        return listed.first
    }

    /// Languages offered for the hint: the common ones, by their names here, and the one set.
    nonisolated static func languages(including code: String) -> [String] {
        let common = ["en", "he", "ar", "es", "fr", "de", "it", "pt", "ru", "uk", "pl", "nl", "tr", "hi", "ja", "ko", "zh"]
        return code == "auto" || common.contains(code) ? common : common + [code]
    }

    /// Reads the settings once the host is known to do voice (`hostDoesVoice`: its state's
    /// `features`, nil until that's in).
    func load(hostDoesVoice: Bool?) async {
        self.hostDoesVoice = hostDoesVoice
        guard hostDoesVoice == true else {
            loaded = hostDoesVoice != nil
            return
        }
        do {
            async let voice = settled { [api] in try await api.voiceSettings() }
            async let subs = settled { [api] in try await api.subscriptions() }
            (settings, subscriptions) = try await (voice, subs)
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
        loaded = true
        await listModels()
    }

    private func listModels() async {
        if let speech = settings?.speech {
            speechModels = (try? await api.speechModels(subscriptionId: speech.subscriptionId)) ?? []
        } else {
            speechModels = []
        }
        if let cleanup = settings?.cleanup, let sub = subscriptions.first(where: { $0.id == cleanup.subscriptionId }) {
            chatModels = (try? await api.subscriptionModels(baseUrl: sub.baseUrl, id: sub.id)) ?? []
        } else {
            chatModels = []
        }
    }

    private func save(_ change: VoiceChange, relist: Bool = false) async {
        do {
            settings = try await api.saveVoice(change)
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
        if relist { await listModels() }
    }

    /// The speech subscription, or nil for this device. A new one starts on the speech model
    /// its endpoint lists first among the fast ones.
    func hearWith(_ subscriptionId: String?) async {
        guard let subscriptionId else { return await save(VoiceChange(speech: .some(nil)), relist: true) }
        let listed: [String]
        do {
            listed = try await api.speechModels(subscriptionId: subscriptionId)
        } catch {
            self.error = "Couldn’t list its speech models: \(APIError.wrap(error).message)"
            return
        }
        guard let model = Self.preferredSpeechModel(listed) else {
            let name = subscriptions.first { $0.id == subscriptionId }?.name ?? "That provider"
            error = "\(name) lists no speech models. Groq and OpenAI keys can hear you."
            return
        }
        speechModels = listed
        await save(VoiceChange(speech: .some(.init(subscriptionId: subscriptionId, model: model))))
    }

    func setSpeechModel(_ model: String) async {
        guard let speech = settings?.speech, !model.isEmpty, model != speech.model else { return }
        await save(VoiceChange(speech: .some(.init(subscriptionId: speech.subscriptionId, model: model))))
    }

    /// The cleanup subscription, or nil for none; it starts on its own model.
    func tidyWith(_ subscriptionId: String?) async {
        await save(VoiceChange(cleanup: .some(subscriptionId.map { .init(subscriptionId: $0, model: "") })), relist: true)
    }

    /// A chat model for the cleanup; "" for the subscription's own.
    func setCleanupModel(_ model: String) async {
        guard let cleanup = settings?.cleanup else { return }
        await save(VoiceChange(cleanup: .some(.init(subscriptionId: cleanup.subscriptionId, model: model))))
    }

    func setStyle(_ style: VoiceStyle) async { await save(VoiceChange(style: style)) }
    func setLanguage(_ code: String) async { await save(VoiceChange(language: code)) }

    func addWord(_ word: String) async {
        let word = word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let settings, !word.isEmpty, !settings.vocabulary.contains(where: { $0.caseInsensitiveCompare(word) == .orderedSame }) else { return }
        await save(VoiceChange(vocabulary: settings.vocabulary + [word]))
    }

    func removeWord(_ word: String) async {
        guard let settings else { return }
        await save(VoiceChange(vocabulary: settings.vocabulary.filter { $0 != word }))
    }

    /// A subscription made from here (Add a Groq Key): listed again, and hearing you when it can.
    func added() async {
        let before = Set(subscriptions.map(\.id))
        subscriptions = (try? await api.subscriptions()) ?? subscriptions
        if settings?.speech == nil, let new = subscriptions.first(where: { !before.contains($0.id) }) { await hearWith(new.id) }
    }
}

/// Settings → Subscriptions (`web/Subscriptions.tsx`): providers for side chat, review and
/// summaries. Keys come back only masked; a typed key replaces the saved one.
@MainActor
@Observable
final class SubscriptionsSettings {
    let api: APIClient
    private(set) var list: [Subscription] = []
    private(set) var models: [String] = []
    private(set) var error: String?

    init(api: APIClient) { self.api = api }

    struct Preset: Sendable, Identifiable {
        let id: String
        let name: String
        let baseUrl: String
        let model: String
        /// Where to create a key; opened in the browser.
        let keyURL: String
        /// The variable its own tools read the key from: a suggestion, never filled in.
        let envName: String
    }

    /// Provider presets (`apps/server/web/providers.ts`); "Other" is any OpenAI-compatible endpoint.
    nonisolated static let presets: [Preset] = [
        Preset(id: "claude", name: "Claude", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5", keyURL: "https://platform.claude.com/settings/keys", envName: "ANTHROPIC_API_KEY"),
        Preset(id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6.1-sol", keyURL: "https://platform.openai.com/api-keys", envName: "OPENAI_API_KEY"),
        Preset(id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash", keyURL: "https://aistudio.google.com/apikey", envName: "GEMINI_API_KEY"),
        Preset(id: "muse", name: "Muse", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", keyURL: "https://dev.meta.ai", envName: "MODEL_API_KEY"),
        // Also hears you: Voice's speech subscription (whisper-large-v3-turbo).
        Preset(id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", keyURL: "https://console.groq.com/keys", envName: "GROQ_API_KEY"),
    ]

    nonisolated static func provider(for baseUrl: String) -> Preset? {
        func trim(_ s: String) -> String { s.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")).lowercased() }
        return presets.first { trim($0.baseUrl) == trim(baseUrl) }
    }

    func load() async {
        do {
            list = try await settled { [api] in try await api.subscriptions() }
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    /// An editor opening: no error or model list left from the last one.
    func beginEditing() {
        error = nil
        models = []
    }

    func save(_ draft: SubscriptionDraft) async -> Bool {
        error = nil
        do {
            _ = try await api.saveSubscription(draft)
            await load()
            return true
        } catch {
            self.error = APIError.wrap(error).message
            return false
        }
    }

    func discoverModels(baseUrl: String, apiKey: String?, id: String?) async {
        do {
            models = try await api.subscriptionModels(baseUrl: baseUrl, apiKey: apiKey, id: id)
        } catch {
            models = []
            self.error = APIError.wrap(error).message
        }
    }

    func remove(_ s: Subscription) async {
        do {
            try await api.removeSubscription(s.id)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func makeDefault(_ s: Subscription) async {
        do {
            try await api.defaultSubscription(s.id)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }
}

/// Settings → Environment (`web/Environment.tsx`): variables every new session window starts
/// with; secrets come back masked; sessions on older values restart one at a time.
@MainActor
@Observable
final class EnvironmentSettings {
    let api: APIClient
    private(set) var state: EnvState?
    private(set) var restarting: Set<String> = []
    private(set) var error: String?

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            state = try await settled { [api] in try await api.env() }
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    /// `value` nil keeps a secret's saved value (renaming its secrecy only).
    func save(name: String, value: String?, secret: Bool) async -> Bool {
        do {
            _ = try await api.saveEnv(name: name, value: value, secret: secret)
            await load()
            return true
        } catch {
            self.error = APIError.wrap(error).message
            return false
        }
    }

    func remove(_ v: EnvVar) async {
        do {
            try await api.removeEnv(v.name)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// Ready to restart: stale and idle (the host says why not, otherwise).
    var ready: [EnvState.Stale] { state?.stale.filter { $0.restart == nil } ?? [] }

    func restart(_ uid: String) async {
        restarting.insert(uid)
        defer { restarting.remove(uid) }
        do {
            _ = try await api.relaunch(uid)
            await load()
        } catch {
            self.error = "Couldn’t restart the session: \(APIError.wrap(error).message)"
        }
    }

    /// One at a time: each restart stops and resumes a conversation.
    func restartAll() async {
        for stale in ready { await restart(stale.uid) }
    }

    static func validName(_ name: String) -> Bool {
        guard let first = name.first, first.isLetter || first == "_", name.count <= 128 else { return false }
        return name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }
}

/// Settings → Search (`web/SearchSettings.tsx`).
@MainActor
@Observable
final class SearchSettings {
    let api: APIClient
    private(set) var status: SearchStatus?
    private(set) var error: String?

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            status = try await settled { [api] in try await api.searchStatus() }
            error = nil
        } catch { self.error = APIError.shown(error) }
    }

    func setEnabled(_ on: Bool) async {
        do {
            status = try await api.searchSetEnabled(on)
            error = nil
        } catch { self.error = APIError.wrap(error).message }
    }

    func rebuild() async {
        do {
            status = try await api.searchRebuild()
            error = nil
        } catch { self.error = APIError.wrap(error).message }
    }
}

/// Settings → System (`web/System.tsx`): agent hooks, screen-rule audit, the host's app
/// launcher, restart and rebuild, uploads.
@MainActor
@Observable
final class SystemSettings {
    let api: APIClient
    private(set) var hooks: HooksStatus?
    private(set) var messages: [String] = []
    private(set) var desktop: DesktopStatus?
    private(set) var desktopMessages: [String] = []
    private(set) var rebuilding = false
    /// Why the last rebuild failed, as the build said it (the host sends the end of its log).
    private(set) var buildLog: String?
    private(set) var error: String?
    private(set) var notice: String?

    init(api: APIClient) { self.api = api }

    func load() async {
        // Both at once: the desktop's state needn't wait for the hooks'.
        let api = api
        async let hooking = settled { try await api.hooks() }
        async let launching = settled { try await api.desktop() }
        do { hooks = try await hooking } catch { self.error = APIError.shown(error) }
        do { desktop = try await launching } catch { self.error = APIError.shown(error) }
    }

    func setDesktop(install: Bool) async {
        do {
            let result = try await api.setDesktop(install: install)
            desktop = result.status
            desktopMessages = result.messages
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// Clears the host's web build, builds it again, and restarts once it's built.
    func rebuild() async {
        guard !rebuilding else { return }
        rebuilding = true
        buildLog = nil
        notice = nil
        defer { rebuilding = false }
        do {
            try await api.rebuild()
            notice = "Built. Agent House is restarting; sessions keep running and this reconnects in a moment."
        } catch {
            buildLog = APIError.wrap(error).message
        }
    }

    func setHooks(install: Bool) async {
        do {
            let result = try await api.setHooks(install: install)
            hooks = result.status
            messages = result.messages
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func resetAudit() async {
        do {
            try await api.resetScreenAudit()
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// The daemon restarts under systemd; live sessions belong to tmux and keep running.
    func restartServer() async {
        do {
            try await api.restart()
            notice = "Restarting. Sessions keep running; this reconnects in a moment."
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func clearUploads() async {
        do {
            let result = try await api.clearUploads()
            notice = "Removed \(result.removed) upload\(result.removed == 1 ? "" : "s")."
        } catch {
            self.error = APIError.wrap(error).message
        }
    }
}

/// Settings → Notifications: this device's opt-ins, registered with the host's APNs provider.
@MainActor
@Observable
final class NotificationSettings {
    let api: APIClient
    private(set) var status: APNsStatus?
    private(set) var error: String?
    /// The last registration didn't reach the host (offline, Tailscale down): worth trying again.
    private(set) var unreachable = false

    init(api: APIClient) { self.api = api }

    func load() async {
        do { status = try await settled { [api] in try await api.apnsStatus() } } catch { self.error = APIError.shown(error) }
    }

    /// Register (or update) this sign-in's token with what it wants to hear about.
    func register(token: Data, environment: String, preferences: DevicePreferences.Notifications) async {
        guard preferences.enabled else {
            try? await api.unregisterAPNs()
            await load()
            return
        }
        do {
            status = try await api.registerAPNs(token: token.map { String(format: "%02x", $0) }.joined(), environment: environment, waiting: preferences.needsYou, done: preferences.finished, privatePreview: preferences.privatePreview)
            error = nil
            unreachable = false
        } catch {
            let wrapped = APIError.wrap(error)
            self.error = wrapped.message
            if case .transport = wrapped { unreachable = true } else { unreachable = false }
        }
    }
}

/// A Settings page's load outlives the view task that asked for it. SwiftUI cancels a page's
/// `.task` while a phone's navigation settles; the request went with it, and the page stayed
/// on "Cancelled." under a spinner. The load now finishes in a task of its own.
@MainActor
func settled<T: Sendable>(_ body: @escaping @Sendable () async throws -> T) async throws -> T {
    try await Task { try await body() }.value
}

/// Settings → System → Developer (`web/System.tsx`'s DeveloperCard): the host's log, on or off,
/// and this device's (`ClientLog`): a stretch of it, the last minutes or a range, sent to the
/// host for an agent to read or shared as a file.
@MainActor
@Observable
final class DeveloperSettings {
    /// How much of this device's log a bundle holds.
    enum Span: String, CaseIterable, Identifiable, Sendable {
        case minutes15, hour, hours6, hours24, all, range
        var id: String { rawValue }
        var label: String {
            switch self {
            case .minutes15: "15m"
            case .hour: "1h"
            case .hours6: "6h"
            case .hours24: "24h"
            case .all: "All"
            case .range: "Range"
            }
        }
        var name: String {
            switch self {
            case .minutes15: "Last 15 minutes"
            case .hour: "Last hour"
            case .hours6: "Last 6 hours"
            case .hours24: "Last 24 hours"
            case .all: "Everything kept"
            case .range: "A range"
            }
        }
        var minutes: Int? {
            switch self {
            case .minutes15: 15
            case .hour: 60
            case .hours6: 360
            case .hours24: 1440
            case .all, .range: nil
            }
        }
    }

    let api: APIClient
    let log: ClientLog
    /// The host has the developer log (feature `logging`): its switch, and Send to Host.
    let hostSupports: Bool
    let sender: ClientLog.Sender
    private(set) var host: LoggingStatus?
    private(set) var deviceOn: Bool
    var span: Span = .hour
    var from: Date
    var to: Date
    var note = ""
    private(set) var sending = false
    private(set) var saved: ClientLogSaved?
    private(set) var error: String?
    /// Bumped when this device's log changes here, so what's counted is read again.
    private(set) var revision = 0
    private let now: () -> Date

    init(api: APIClient, log: ClientLog = .shared, hostSupports: Bool, sender: ClientLog.Sender, now: @escaping () -> Date = Date.init) {
        self.api = api
        self.log = log
        self.hostSupports = hostSupports
        self.sender = sender
        self.now = now
        deviceOn = log.isOn
        to = now()
        from = now().addingTimeInterval(-30 * 60)
    }

    /// The window the chosen span names now. Nil ends are open.
    var window: (from: Date?, to: Date?) {
        if span == .range { return (from, to) }
        guard let minutes = span.minutes else { return (nil, nil) }
        let end = now()
        return (end.addingTimeInterval(-Double(minutes) * 60), end)
    }

    var badRange: Bool { span == .range && from > to }
    var kept: Int { _ = revision; return log.entries().count }
    var picked: [ClientLog.Entry] {
        _ = revision
        let w = window
        return badRange ? [] : log.entries(from: w.from, to: w.to)
    }

    func load() async {
        guard hostSupports else { return }
        do { host = try await api.logging() } catch { self.error = APIError.wrap(error).message }
    }

    func setHost(_ on: Bool) async {
        do {
            host = try await api.setLogging(server: on)
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func setDevice(_ on: Bool) {
        log.set(on)
        deviceOn = on
        revision += 1
    }

    /// The chosen stretch, kept on the host beside its own log.
    func send() async {
        guard !sending else { return }
        sending = true
        saved = nil
        defer { sending = false }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            saved = try await api.sendClientLog(ClientLogBundle(client: sender, note: trimmed.isEmpty ? nil : trimmed, entries: picked.map(\.json)))
            note = ""
            error = nil
            host = (try? await api.logging()) ?? host
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// The chosen stretch as a file to share or save (a bundle as the host keeps one).
    func file() throws -> URL {
        let w = window
        let data = ClientLog.bundleFile(picked, sender: sender, note: note.trimmingCharacters(in: .whitespacesAndNewlines), from: w.from, to: w.to)
        let stamp = ClientLog.iso(now()).prefix(16).replacingOccurrences(of: ":", with: "").replacingOccurrences(of: "-", with: "")
        let name = "ah-log-\(sender.device.replacingOccurrences(of: " ", with: "-"))-\(stamp).jsonl"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try data.write(to: url, options: .atomic)
        return url
    }

    func clear() {
        log.clear()
        saved = nil
        revision += 1
    }

    /// Re-count after time passes (the sheet coming back): the window moves with the clock.
    func refresh() { revision += 1 }
}
