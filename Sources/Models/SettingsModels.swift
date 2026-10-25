import Foundation
import Observation

/// Settings → Security (`../ah/web/Security.tsx`): this device, signed-in devices and native
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
            overview = try await api.authOverview()
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
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
    var activity: [(at: String, event: String, detail: String)] {
        (overview?.audit ?? []).map { entry in
            let at = entry["at"].text
            let event = entry["event"].text
            let rest = (entry.object ?? [:]).filter { $0.key != "at" && $0.key != "event" }.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.text)" }.joined(separator: " · ")
            return (at, Self.eventNames[event] ?? event, rest)
        }
    }

    static let eventNames: [String: String] = [
        "auth.signin": "Signed in", "auth.signout": "Signed out", "auth.failed": "Sign-in failed", "auth.code_issued": "Setup code issued",
        "auth.passkey_added": "Passkey added", "auth.passkey_removed": "Passkey removed", "auth.device_added": "Device enrolled",
        "auth.device_removed": "Device removed", "auth.token_created": "Token created", "auth.token_removed": "Token revoked",
        "auth.password_set": "Master password set", "auth.password_removed": "Master password removed", "auth.preview_session": "Preview opened",
        "session.create": "Session started", "session.send": "Message sent", "session.approve": "Approved", "session.deny": "Denied",
        "session.kill": "Session terminated", "file.upload": "File uploaded", "push.apns.register": "Notifications registered",
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
            self.error = APIError.wrap(error).message
        }
    }

    func load() async { await run { try await api.harnesses() } }
    func check() async {
        checking = true
        defer { checking = false }
        await run { try await api.checkHarnesses() }
    }
    func setHidden(_ agent: HarnessInfo, _ hidden: Bool) async { await run { try await api.setHarnessHidden(agent.id, hidden: hidden) } }
    func add(name: String, command: String, resume: String?) async { await run { try await api.addHarness(name: name, command: command, resume: resume) } }
    func remove(_ agent: HarnessInfo) async { await run { try await api.removeHarness(agent.id) } }
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

    /// Provider presets (`../ah/web/providers.ts`); "Other" is any OpenAI-compatible endpoint.
    nonisolated static let presets: [Preset] = [
        Preset(id: "claude", name: "Claude", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5", keyURL: "https://platform.claude.com/settings/keys", envName: "ANTHROPIC_API_KEY"),
        Preset(id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6.1-sol", keyURL: "https://platform.openai.com/api-keys", envName: "OPENAI_API_KEY"),
        Preset(id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash", keyURL: "https://aistudio.google.com/apikey", envName: "GEMINI_API_KEY"),
        Preset(id: "muse", name: "Muse", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3", keyURL: "https://dev.meta.ai", envName: "MODEL_API_KEY"),
    ]

    nonisolated static func provider(for baseUrl: String) -> Preset? {
        func trim(_ s: String) -> String { s.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")).lowercased() }
        return presets.first { trim($0.baseUrl) == trim(baseUrl) }
    }

    func load() async {
        do {
            list = try await api.subscriptions()
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func save(_ draft: SubscriptionDraft) async -> Bool {
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
            state = try await api.env()
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
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
        do { status = try await api.searchStatus() } catch { self.error = APIError.wrap(error).message }
    }

    func setEnabled(_ on: Bool) async {
        do { status = try await api.searchSetEnabled(on) } catch { self.error = APIError.wrap(error).message }
    }

    func rebuild() async {
        do { status = try await api.searchRebuild() } catch { self.error = APIError.wrap(error).message }
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
        do { hooks = try await api.hooks() } catch { self.error = APIError.wrap(error).message }
        do { desktop = try await api.desktop() } catch { self.error = APIError.wrap(error).message }
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
            notice = "Built. Agent Hub is restarting; sessions keep running and this reconnects in a moment."
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

    init(api: APIClient) { self.api = api }

    func load() async {
        do { status = try await api.apnsStatus() } catch { self.error = APIError.wrap(error).message }
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
        } catch {
            self.error = APIError.wrap(error).message
        }
    }
}
