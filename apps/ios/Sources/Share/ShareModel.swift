import Foundation
import Observation

// The share extension's logic (`Share/` draws it): send what another app shared into a
// session, new or running, on one of the hosts this device is signed in to. It reads the
// app's sign-ins from the shared Keychain and never writes them (the app owns them); it lists
// sessions live from the host (nothing about them is kept); and it says what happened, never
// "Sent" for something it can't confirm.

/// A host this device is signed in to, as the app left it in the Keychain.
struct SharedAccount: Equatable, Sendable, Identifiable {
    let origin: String
    let token: String
    /// Past its expiry: the host would refuse it; the app signs in again with Face ID.
    let expired: Bool
    var id: String { origin }
    /// What to call it before the host has said its name: its address's first part.
    var name: String { URL(string: origin)?.host?.split(separator: ".").first.map(String.init) ?? origin }

    /// The app's credential entries (`credential:<origin>` → `NativeCredential`), newest-named first.
    static func parse(_ entries: [(account: String, data: Data)], now: Date = Date()) -> [SharedAccount] {
        entries.compactMap { entry in
            guard entry.account.hasPrefix("credential:"), let credential = try? JSONDecoder().decode(NativeCredential.self, from: entry.data) else { return nil }
            let origin = String(entry.account.dropFirst("credential:".count))
            guard URL(string: origin)?.host != nil else { return nil }
            return SharedAccount(origin: origin, token: credential.token, expired: credential.expiresAt / 1000 < now.timeIntervalSince1970)
        }
        .sorted { $0.origin < $1.origin }
    }
}

/// Something shared, staged where the extension can read it after the sharing app lets go.
enum SharedItem: Equatable, Sendable {
    case text(String)
    case link(URL)
    case file(StagedFile)
}

struct StagedFile: Equatable, Sendable {
    enum Kind: String, Equatable, Sendable { case image, movie, file }
    let name: String
    /// The extension's own copy (the sharing app's URL is only good while it's handing over).
    let url: URL
    let bytes: Int64
    let kind: Kind
}

enum ShareMessage {
    /// A host takes at most 32 KB of text in one message; longer shared text goes up as a file.
    static let textLimit = 30_000

    /// The words sent: the uploads' paths first (quoted, as the composer sends attachments),
    /// then the note, then links and shared text, each on its own.
    static func compose(note: String, items: [SharedItem], uploaded: [String]) -> String {
        var parts: [String] = []
        if !uploaded.isEmpty { parts.append(uploaded.map(Uploads.shellQuote).joined(separator: " ")) }
        let words = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { parts.append(words) }
        for item in items {
            switch item {
            case .link(let url): parts.append(url.absoluteString)
            case .text(let text):
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { parts.append(trimmed) }
            case .file: break
            }
        }
        return parts.joined(separator: "\n\n")
    }

    /// Text too long for a message: shared as a file instead.
    static func needsFile(_ text: String) -> Bool { text.utf8.count > textLimit }
}

/// A bearer the extension only reads: a refusal is reported to the person, and the app's
/// sign-in is left for the app to end (it would see the same refusal itself).
actor ReadOnlyCredential: CredentialProvider {
    private let token: String
    private(set) var refused = false
    init(token: String) { self.token = token }
    func bearer() async -> String? { token }
    func rejected(bearer: String?) async { refused = true }
}

/// A session the shared things can go to.
struct ShareSession: Equatable, Sendable, Identifiable {
    /// Nil for the account's own host.
    let host: String?
    let uid: String
    let title: String
    let agent: String?
    let project: String
    let projectPath: String
    let status: SessionDTO.Status
    let activity: Double
    var id: String { (host.map { "\($0)/" } ?? "") + uid }
}

@MainActor
@Observable
final class ShareModel {
    enum Destination: Equatable, Sendable {
        case session(ShareSession)
        /// A new session of `preset` in `cwd`, on `host`.
        case new(host: String?, preset: String, cwd: String)
    }

    enum Phase: Equatable, Sendable {
        case choosing
        case uploading(done: Int, of: Int, fraction: Double)
        case sending
        /// It reached the session (`queued`: it goes in once the agent is free or started).
        case sent(queued: Bool)
        /// Refused or not reachable before anything went: safe to try again.
        case failed(String)
        /// It may have arrived: the answer was lost. Trying again could send it twice.
        case unsure(String)
    }

    let accounts: [SharedAccount]
    var account: SharedAccount? { didSet { if account != oldValue { Task { await load() } } } }
    let items: [SharedItem]
    var note = ""
    var destination: Destination?
    private(set) var phase: Phase = .choosing
    private(set) var loading = false
    private(set) var loadError: String?
    /// The host's own name, and the peers it reaches that are online.
    private(set) var hostname: String?
    private(set) var hosts: [String] = []
    private(set) var sessions: [ShareSession] = []
    private(set) var agents: [PresetDTO] = []
    private(set) var defaultSession = ""

    @ObservationIgnored private let transport: any HTTPTransport
    @ObservationIgnored private let device: DeviceDescriptor
    @ObservationIgnored private var credential: ReadOnlyCredential?

    init(accounts: [SharedAccount], items: [SharedItem], transport: any HTTPTransport, device: DeviceDescriptor) {
        self.accounts = accounts
        self.items = items
        self.transport = transport
        self.device = device
        account = accounts.first { !$0.expired }
    }

    var files: [StagedFile] { items.compactMap { if case .file(let file) = $0 { return file } else { return nil } } }
    var busy: Bool {
        switch phase {
        case .uploading, .sending: return true
        default: return false
        }
    }
    var canSend: Bool {
        guard destination != nil, account != nil, !busy else { return false }
        switch phase {
        case .choosing, .failed: return !items.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default: return false
        }
    }

    private func api(host: String?) -> APIClient? {
        guard let account, let origin = URL(string: account.origin) else { return nil }
        let credential = self.credential ?? ReadOnlyCredential(token: account.token)
        self.credential = credential
        let hub = APIClient(origin: origin, transport: transport, credentials: credential, device: device)
        return host.map { hub.peer($0) } ?? hub
    }

    /// The account's sessions (and its online peers'), newest activity first, and its agents.
    func load() async {
        credential = nil
        sessions = []
        agents = []
        destination = nil
        hostname = nil
        hosts = []
        loadError = nil
        guard let account else { return }
        if account.expired {
            loadError = "Your sign-in to \(account.name) has ended. Open Agent House to sign in again."
            return
        }
        guard let hub = api(host: nil) else { return }
        loading = true
        defer { loading = false }
        do {
            let state = try await hub.state()
            hostname = state.hostname
            defaultSession = state.defaultSession
            agents = state.presets.filter { $0.offered && !$0.isShell }
            var rows = Self.sessions(state, host: nil)
            let peers = state.hosts.filter { !$0.isSelf && $0.online }.map(\.name)
            hosts = peers
            await withTaskGroup(of: [ShareSession].self) { group in
                for peer in peers {
                    group.addTask { [hub] in
                        guard let peerState = try? await hub.peer(peer).state() else { return [] }
                        return ShareModel.sessions(peerState, host: peer)
                    }
                }
                for await more in group { rows += more }
            }
            sessions = rows.sorted { $0.activity > $1.activity }
        } catch {
            loadError = await message(for: error)
        }
    }

    nonisolated static func sessions(_ state: HubStateDTO, host: String?) -> [ShareSession] {
        state.windows.map { ShareSession(host: host, uid: $0.uid, title: $0.title, agent: $0.agent, project: $0.project, projectPath: $0.projectPath, status: $0.status, activity: $0.activity) }
    }

    /// Projects to start a new session in (on the account's own host, where new ones start):
    /// where its sessions are, most active first.
    var projects: [(path: String, name: String)] {
        var seen = Set<String>()
        return sessions.compactMap { s in
            guard s.host == nil, !s.projectPath.isEmpty, seen.insert(s.projectPath).inserted else { return nil }
            return (s.projectPath, s.project)
        }
    }

    /// Uploads the files, starts the session if it's a new one, sends. Called once per tap:
    /// nothing here retries on its own, so nothing goes twice.
    func send() async {
        guard canSend, let destination else { return }
        let host: String? = {
            switch destination {
            case .session(let s): return s.host
            case .new(let host, _, _): return host
            }
        }()
        guard let api = api(host: host) else { return }
        let files = self.files
        var uploaded: [String] = []
        // Files go to the host that runs the session (a peer's own disk).
        for (index, file) in files.enumerated() {
            phase = .uploading(done: index, of: files.count, fraction: 0)
            do {
                let path = try await api.upload(name: file.name, file: file.url) { fraction in
                    Task { @MainActor [weak self] in
                        guard let self, case .uploading(let done, let of, _) = self.phase, done == index else { return }
                        self.phase = .uploading(done: done, of: of, fraction: fraction)
                    }
                }
                uploaded.append(path)
            } catch {
                phase = .failed("\(file.name) didn’t upload: \(await message(for: error)) Nothing was sent.")
                return
            }
        }
        phase = .sending
        let text = ShareMessage.compose(note: note, items: items, uploaded: uploaded)
        let uid: String
        switch destination {
        case .session(let s):
            uid = s.uid
        case .new(_, let preset, let cwd):
            do {
                uid = try await api.create(NewSessionRequest(preset: preset, cwd: cwd, session: defaultSession, label: "")).uid
            } catch {
                // A lost answer may mean it started: never start a second one on our own.
                if case .transport = APIError.wrap(error) {
                    phase = .unsure("Agent House couldn’t confirm the new session started. Check it in Agent House before trying again.")
                } else {
                    phase = .failed("The session didn’t start: \(await message(for: error))")
                }
                return
            }
        }
        do {
            let result = try await api.send(uid, text: text)
            phase = .sent(queued: result.outcome == .queued)
        } catch {
            guard case .transport = APIError.wrap(error) else {
                phase = .failed("It wasn’t sent: \(await message(for: error))")
                return
            }
            // The answer was lost, not necessarily the message: look in its queue.
            let since = Date().timeIntervalSince1970 - 120
            if let queued = try? await api.queue(uid), queued.contains(where: { $0.at >= since && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == text.trimmingCharacters(in: .whitespacesAndNewlines) }) {
                phase = .sent(queued: true)
            } else {
                phase = .unsure("Agent House couldn’t confirm it arrived. Open the session to check before sending it again.")
            }
        }
    }

    /// After `unsure`: the person looked and wants it sent anyway.
    func sendAgain() async {
        guard case .unsure = phase else { return }
        phase = .choosing
        await send()
    }

    private func message(for error: any Error) async -> String {
        let wrapped = APIError.wrap(error)
        var ended = await credential?.refused == true
        if case .unauthorized = wrapped { ended = true }
        if ended {
            return "Your sign-in to \(hostname ?? account?.name ?? "the host") has ended. Open Agent House to sign in again."
        }
        if case .transport = wrapped { return "Couldn’t reach \(hostname ?? account?.name ?? "the host"). Is Tailscale connected?" }
        return wrapped.message
    }
}
