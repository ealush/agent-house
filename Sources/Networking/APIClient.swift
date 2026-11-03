import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The bearer secret for requests, and what to do when the host says it's no longer valid.
protocol CredentialProvider: Sendable {
    func bearer() async -> String?
    /// The host refused `bearer`, the one the request carried: a late answer to an earlier
    /// sign-in mustn't end a newer one.
    func rejected(bearer: String?) async
}

/// Typed client for one host's API (`../ah/web/api.ts`), addressed through the hub:
/// `scope` is nil for the hub itself and a peer's name for `/h/<peer>` (the hub proxies).
/// Requests carry `X-AH: 1` on writes and the device's bearer, never a cookie or Origin.
struct APIClient: Sendable {
    let origin: URL
    let scope: String?
    let transport: any HTTPTransport
    let credentials: any CredentialProvider
    let device: DeviceDescriptor

    init(origin: URL, scope: String? = nil, transport: any HTTPTransport, credentials: any CredentialProvider, device: DeviceDescriptor) {
        self.origin = origin
        self.scope = scope
        self.transport = transport
        self.credentials = credentials
        self.device = device
    }

    /// The same host's API for a peer reached through it.
    func peer(_ name: String?) -> APIClient {
        APIClient(origin: origin, scope: name, transport: transport, credentials: credentials, device: device)
    }

    // MARK: Request plumbing

    func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        let prefix = scope.map { "/h/\($0)" } ?? ""
        components.percentEncodedPath = prefix + path
        components.queryItems = query.isEmpty ? nil : query
        return components.url!
    }

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, contentType: String = "application/json") async -> URLRequest {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        if method != "GET" && method != "HEAD" {
            request.setValue("1", forHTTPHeaderField: "X-AH")
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body ?? Data("{}".utf8)
        }
        if let token = await credentials.bearer() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// The bearer a request carries, if any.
    static func bearer(of request: URLRequest) -> String? {
        guard let header = request.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Bearer ") else { return nil }
        return String(header.dropFirst("Bearer ".count))
    }

    func send(_ request: URLRequest, fromFile file: URL? = nil) async throws -> Data {
        do {
            try Task.checkCancellation()
            let (data, response): (Data, HTTPURLResponse)
            if let file {
                (data, response) = try await transport.upload(for: request, fromFile: file)
            } else {
                (data, response) = try await transport.data(for: request)
            }
            guard (200..<300).contains(response.statusCode) else {
                let error = APIError(status: response.statusCode, body: data)
                if case .unauthorized = error { await credentials.rejected(bearer: Self.bearer(of: request)) }
                throw error
            }
            return data
        } catch {
            throw APIError.wrap(error)
        }
    }

    func call<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], json: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        let body = try json.map { try JSONEncoder().encode(AnyEncodable($0)) }
        let data = try await send(await request(method, path, query: query, body: body))
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    func perform(_ method: String, _ path: String, query: [URLQueryItem] = [], json: (any Encodable)? = nil) async throws {
        let body = try json.map { try JSONEncoder().encode(AnyEncodable($0)) }
        _ = try await send(await request(method, path, query: query, body: body))
    }

    /// An SSE response stream, already checked for success.
    func eventStream(_ path: String, query: [URLQueryItem] = []) async throws -> AsyncThrowingStream<Data, any Error> {
        var request = await request("GET", path, query: query)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        do {
            let (response, stream) = try await transport.stream(for: request)
            guard (200..<300).contains(response.statusCode) else {
                var body = Data()
                for try await chunk in stream {
                    body.append(chunk)
                    if body.count > 4096 { break }
                }
                let error = APIError(status: response.statusCode, body: body)
                if case .unauthorized = error { await credentials.rejected(bearer: Self.bearer(of: request)) }
                throw error
            }
            return stream
        } catch {
            throw APIError.wrap(error)
        }
    }

    static let enc: @Sendable (String) -> String = { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? $0 }
    private func s(_ ref: String) -> String { "/api/sessions/\(Self.enc(ref))" }

    // MARK: Hello and sign-in (public routes)

    func hello() async throws -> Hello { try await call("GET", "/api/hello") }
    func authStatus() async throws -> AuthStatus { try await call("GET", "/api/auth/status") }

    // MARK: State

    func state() async throws -> HubStateDTO { try await call("GET", "/api/state") }
    func projects() async throws -> [String] { try await call("GET", "/api/projects") }
    func dir(_ path: String) async throws -> DirStatus { try await call("GET", "/api/dir", query: [URLQueryItem(name: "path", value: path)]) }

    // MARK: Sessions

    func create(_ body: NewSessionRequest) async throws -> CreatedWindow { try await call("POST", "/api/windows", json: body) }
    func order(_ uid: String, _ order: Double) async throws { try await perform("POST", "\(s(uid))/order", json: ["order": order]) }
    func rename(_ uid: String, _ name: String) async throws { try await perform("PUT", "\(s(uid))/name", json: ["name": name]) }
    func terminate(_ uid: String) async throws { try await perform("POST", "\(s(uid))/terminate") }
    func capture(_ uid: String, lines: Int = 3000) async throws -> String {
        String(decoding: try await send(await request("GET", "\(s(uid))/capture", query: [URLQueryItem(name: "lines", value: String(lines))])), as: UTF8.self)
    }
    func resume(_ ref: String) async throws -> ResumeResult { try await call("POST", "\(s(ref))/resume") }
    func forkInfo(_ ref: String) async throws -> ForkInfo { try await call("GET", "\(s(ref))/fork-info") }
    func fork(_ ref: String, _ body: ForkRequest) async throws -> ForkResult { try await call("POST", "\(s(ref))/fork", json: body) }
    func send(_ ref: String, text: String, enter: Bool = true) async throws -> SendResult {
        try await call("POST", "\(s(ref))/send", json: SendBody(text: text, enter: enter))
    }
    func answer(_ uid: String, approve: Bool) async throws { try await perform("POST", "\(s(uid))/answer", json: ["answer": approve ? "approve" : "deny"]) }
    func choose(_ uid: String, key: String) async throws -> ChooseResult { try await call("POST", "\(s(uid))/choose", json: ["key": key]) }
    func commands(_ uid: String) async throws -> [SlashCommand] { try await call("GET", "\(s(uid))/commands") }
    func files(_ uid: String, query: String) async throws -> [String] { try await call("GET", "\(s(uid))/files", query: [URLQueryItem(name: "q", value: query)]) }
    func answerQuestions(_ uid: String, _ answers: [QuestionAnswer]) async throws { try await perform("POST", "\(s(uid))/questions", json: ["answers": answers]) }
    func answerQuestion(_ uid: String, question: String, answer: QuestionAnswer) async throws {
        try await perform("POST", "\(s(uid))/questions", json: CurrentQuestion(current: .init(question: question, answer: answer)))
    }
    /// The dialog's "Chat about this": declines its questions and hands the conversation back.
    func chatAboutQuestions(_ uid: String, question: String?) async throws {
        try await perform("POST", "\(s(uid))/questions", json: ChatAboutQuestions(question: question))
    }
    func queue(_ uid: String) async throws -> [QueueItem] { try await call("GET", "\(s(uid))/queue") }
    func clearQueue(_ uid: String, item: String? = nil) async throws {
        try await perform("DELETE", "\(s(uid))/queue" + (item.map { "/\(Self.enc($0))" } ?? ""))
    }
    func moveQueued(_ uid: String, item: String, to: Int) async throws -> [QueueItem] {
        try await call("POST", "\(s(uid))/queue/\(Self.enc(item))/move", json: ["to": to])
    }
    func sendNow(_ uid: String, item: String) async throws -> SendResult { try await call("POST", "\(s(uid))/queue/\(Self.enc(item))/send-now") }
    func switchLaunch(_ uid: String, model: String? = nil, effort: String? = nil) async throws -> SendResult {
        try await call("POST", "\(s(uid))/switch", json: LaunchChange(model: model, effort: effort, mode: nil))
    }
    func openSettings(_ uid: String, setting: String) async throws -> SendResult { try await call("POST", "\(s(uid))/settings", json: ["setting": setting]) }
    func switchMode(_ uid: String, mode: String) async throws -> SwitchModeResult { try await call("POST", "\(s(uid))/mode", json: ["mode": mode]) }
    func relaunch(_ uid: String, model: String? = nil, effort: String? = nil, mode: String? = nil) async throws -> RelaunchResult {
        try await call("POST", "\(s(uid))/relaunch", json: LaunchChange(model: model, effort: effort, mode: mode))
    }
    func interrupt(_ uid: String) async throws { try await perform("POST", "\(s(uid))/interrupt") }
    func pin(_ uid: String, pinned: Bool) async throws { try await perform("POST", "\(s(uid))/pin", json: ["pinned": pinned]) }
    func forget(_ ref: String) async throws { try await perform("DELETE", s(ref)) }

    // MARK: GUI feed

    func feedStream(_ ref: String) async throws -> AsyncThrowingStream<Data, any Error> {
        try await eventStream("\(s(ref))/feed/stream", query: [URLQueryItem(name: "device", value: device.name), URLQueryItem(name: "client", value: device.client)])
    }
    func feedPage(_ ref: String, before: Int?, limit: Int = 200) async throws -> FeedPage {
        try await call("GET", "\(s(ref))/feed", query: [URLQueryItem(name: "before", value: before.map(String.init) ?? "Infinity"), URLQueryItem(name: "limit", value: String(limit))])
    }
    func feedPrompts(_ ref: String) async throws -> [FeedPrompt] { (try await call("GET", "\(s(ref))/feed/prompts", as: PromptsResult.self)).prompts }

    // MARK: Presence, drafts, prompts

    func focus(key: String) async throws { try await perform("POST", "/api/focus", json: ["key": key, "device": device.name, "client": device.client]) }
    func draft(_ uid: String) async throws -> Draft? { (try await call("GET", "\(s(uid))/draft", as: DraftEnvelope.self)).draft }
    func saveDraft(_ uid: String, text: String) async throws -> Draft? {
        (try await call("PUT", "\(s(uid))/draft", json: ["text": text, "device": device.name, "client": device.client], as: DraftEnvelope.self)).draft
    }
    func prompts() async throws -> [PromptRecord] { try await call("GET", "/api/prompts") }
    func clearPrompts() async throws { try await perform("DELETE", "/api/prompts") }

    // MARK: Snapshots and preview

    func snapshots(_ uid: String) async throws -> SnapshotList { try await call("GET", "\(s(uid))/snapshots") }
    func restoreSnapshot(_ uid: String, turn: Int, interrupt: Bool = false) async throws -> SnapshotRestore {
        try await call("POST", "\(s(uid))/snapshots/\(turn)/restore", json: ["interrupt": interrupt])
    }
    func toggleSnapshots(_ uid: String, enabled: Bool) async throws { try await perform("POST", "\(s(uid))/snapshots/toggle", json: ["enabled": enabled]) }
    func preview(_ uid: String) async throws -> PreviewInfo { try await call("GET", "\(s(uid))/preview") }
    func startPreview(_ uid: String, target: Int) async throws -> PreviewDTO { (try await call("PUT", "\(s(uid))/preview", json: ["target": target], as: PreviewStart.self)).preview }
    func stopPreview(_ uid: String) async throws { try await perform("DELETE", "\(s(uid))/preview") }

    // MARK: Git

    func changes(_ uid: String) async throws -> Changes { try await call("GET", "\(s(uid))/changes") }
    func branches(_ uid: String) async throws -> BranchList { try await call("GET", "\(s(uid))/branches") }
    func switchBranch(_ uid: String, branch: String) async throws -> BranchSwitch { try await call("POST", "\(s(uid))/branches", json: ["branch": branch]) }
    func pull(_ uid: String) async throws -> PullInfo { try await call("GET", "\(s(uid))/pull") }

    // MARK: Side chat and subscriptions

    func subscriptions() async throws -> [Subscription] { try await call("GET", "/api/subscriptions") }
    func saveSubscription(_ body: SubscriptionDraft) async throws -> Subscription { try await call("POST", "/api/subscriptions", json: body) }
    func subscriptionModels(baseUrl: String, apiKey: String? = nil, id: String? = nil) async throws -> [String] {
        (try await call("POST", "/api/subscriptions/models", json: ModelsQuery(baseUrl: baseUrl, apiKey: apiKey, id: id), as: ModelsResult.self)).models
    }
    func removeSubscription(_ id: String) async throws { try await perform("DELETE", "/api/subscriptions/\(Self.enc(id))") }
    func defaultSubscription(_ id: String) async throws { try await perform("POST", "/api/subscriptions/default", json: ["id": id]) }
    func summarize(_ text: String, subscriptionId: String? = nil) async throws -> String {
        (try await call("POST", "/api/summarize", json: SummarizeBody(text: text, subscriptionId: subscriptionId), as: SummaryResult.self)).summary
    }
    func chat(_ uid: String) async throws -> ChatThread { try await call("GET", "\(s(uid))/chat") }
    func pickChatSubscription(_ uid: String, id: String) async throws { try await perform("PUT", "\(s(uid))/chat/subscription", json: ["id": id]) }
    func sendChat(_ uid: String, text: String, subscriptionId: String? = nil) async throws -> ChatReply {
        try await call("POST", "\(s(uid))/chat", json: SummarizeBody(text: text, subscriptionId: subscriptionId))
    }
    func clearChat(_ uid: String) async throws { try await perform("DELETE", "\(s(uid))/chat") }
    func pastChats(query: String? = nil) async throws -> [ChatSummary] {
        try await call("GET", "/api/chats", query: query.map { [URLQueryItem(name: "q", value: $0)] } ?? [])
    }
    func pastChat(_ key: String, messageID: Int? = nil) async throws -> [ChatMessage] {
        struct R: Decodable { let messages: [ChatMessage] }
        return (try await call("GET", "/api/chats/\(Self.enc(key))", query: messageID.map { [URLQueryItem(name: "msgId", value: String($0))] } ?? [], as: R.self)).messages
    }

    // MARK: Environment

    func env() async throws -> EnvState { try await call("GET", "/api/env") }
    func saveEnv(name: String, value: String?, secret: Bool) async throws -> EnvVar { try await call("POST", "/api/env", json: EnvBody(name: name, value: value, secret: secret)) }
    func removeEnv(_ name: String) async throws { try await perform("DELETE", "/api/env/\(Self.enc(name))") }

    // MARK: Search

    func search(_ query: SearchQuery, allHosts: Bool = false) async throws -> SearchResponse {
        try await call("GET", allHosts ? "/api/search/all" : "/api/search", query: query.queryItems)
    }
    func searchStatus() async throws -> SearchStatus { try await call("GET", "/api/search/status") }
    func searchRebuild() async throws -> SearchStatus { try await call("POST", "/api/search/rebuild") }
    func searchSetEnabled(_ enabled: Bool) async throws -> SearchStatus { try await call("POST", "/api/search/enabled", json: ["enabled": enabled]) }

    // MARK: System and agents

    func restart() async throws { try await perform("POST", "/api/system/restart") }
    func clearUploads() async throws -> ClearedUploads { try await call("POST", "/api/system/uploads/clear") }
    func hooks() async throws -> HooksStatus { try await call("GET", "/api/system/hooks") }
    func setHooks(install: Bool) async throws -> HooksAction { try await call("POST", "/api/system/hooks", json: ["action": install ? "install" : "uninstall"]) }
    func resetScreenAudit() async throws { try await perform("DELETE", "/api/system/screen-audit") }
    /// Agent Hub in the host's app launcher (on Omarchy, through its web-app installer).
    func desktop() async throws -> DesktopStatus { try await call("GET", "/api/system/desktop") }
    func setDesktop(install: Bool) async throws -> DesktopAction { try await call("POST", "/api/system/desktop", json: ["action": install ? "install" : "uninstall"]) }
    /// Builds the web app again from the host's checkout, then restarts: minutes, not seconds.
    func rebuild() async throws {
        var request = await request("POST", "/api/system/rebuild")
        request.timeoutInterval = 15 * 60
        _ = try await send(request)
    }
    func omarchyTheme() async throws -> OmarchyTheme? { try await call("GET", "/api/omarchy/theme") }
    func harnesses() async throws -> Harnesses { try await call("GET", "/api/harnesses") }
    func checkHarnesses() async throws -> Harnesses { try await call("POST", "/api/harnesses/check") }
    func setHarnessHidden(_ id: String, hidden: Bool) async throws -> Harnesses { try await call("POST", "/api/harnesses/\(Self.enc(id))", json: ["hidden": hidden]) }
    func addHarness(name: String, command: String, resume: String?) async throws -> Harnesses {
        try await call("POST", "/api/harnesses/custom", json: CustomAgent(name: name, command: command, resume: resume))
    }
    func removeHarness(_ id: String) async throws -> Harnesses { try await call("DELETE", "/api/harnesses/custom/\(Self.enc(id))") }

    // MARK: Worktrees

    func worktrees() async throws -> [WorktreeInfo] { try await call("GET", "/api/worktrees") }
    func removeWorktree(_ path: String, force: Bool) async throws { try await perform("DELETE", "/api/worktrees", json: RemoveWorktree(path: path, force: force)) }
    func removeWorktrees(_ paths: [String], force: [String]) async throws -> [BulkRemoveResult] {
        (try await call("POST", "/api/worktrees/remove-bulk", json: ["paths": paths, "force": force], as: BulkRemoveResponse.self)).results
    }

    // MARK: Files

    func list(path: String?, hidden: Bool) async throws -> FsListing {
        var query: [URLQueryItem] = []
        if let path { query.append(URLQueryItem(name: "path", value: path)) }
        if hidden { query.append(URLQueryItem(name: "hidden", value: "1")) }
        return try await call("GET", "/api/fs/list", query: query)
    }
    func fileURL(_ path: String, download: Bool = false) -> URL {
        url("/api/fs/file", query: [URLQueryItem(name: "path", value: path)] + (download ? [URLQueryItem(name: "download", value: "1")] : []))
    }
    /// A host file's bytes, authenticated (for Quick Look and images).
    func file(_ path: String) async throws -> Data { try await send(await request("GET", "/api/fs/file", query: [URLQueryItem(name: "path", value: path)])) }
    func mkdir(_ path: String) async throws -> String { (try await call("POST", "/api/fs/mkdir", json: ["path": path], as: UploadedPath.self)).path }
    /// Upload into a folder on the host (Files panel).
    func uploadFile(into dir: String, name: String, data: Data) async throws -> String {
        let req = await request("POST", "/api/fs/upload", query: [URLQueryItem(name: "dir", value: dir), URLQueryItem(name: "name", value: name)], body: data, contentType: "application/octet-stream")
        return try JSONDecoder().decode(UploadedPath.self, from: try await send(req)).path
    }
    /// An attachment for a prompt: lands in ah's upload folder; its path goes into the message.
    func upload(name: String, data: Data) async throws -> String {
        let req = await request("POST", "/api/upload", query: [URLQueryItem(name: "name", value: name)], body: data, contentType: "application/octet-stream")
        return try JSONDecoder().decode(UploadedPath.self, from: try await send(req)).path
    }

    /// The same from a file on disk, for what's too big to hold in memory (a video).
    func upload(name: String, file: URL) async throws -> String {
        var req = await request("POST", "/api/upload", query: [URLQueryItem(name: "name", value: name)], contentType: "application/octet-stream")
        req.httpBody = nil
        // Between bytes: the host only answers once the last one lands.
        req.timeoutInterval = 120
        return try JSONDecoder().decode(UploadedPath.self, from: try await send(req, fromFile: file)).path
    }

    // MARK: Account management (Settings → Security)

    func authOverview() async throws -> AuthOverview { try await call("GET", "/api/auth/overview") }
    func issueSetupCode() async throws -> SetupCode { try await call("POST", "/api/auth/code") }
    func revokeSession(_ id: String) async throws { try await perform("DELETE", "/api/auth/sessions/\(Self.enc(id))") }
    func signOutEverywhere() async throws { try await perform("POST", "/api/auth/signout-all") }
    func removePasskey(_ id: String) async throws { try await perform("DELETE", "/api/auth/passkeys/\(Self.enc(id))") }
    func removeDevice(_ id: String) async throws { try await perform("DELETE", "/api/auth/devices/\(Self.enc(id))") }
    /// A machine token for scripts; its secret comes back this once and is never stored here.
    func createToken(name: String) async throws -> String { try await call("POST", "/api/auth/tokens", json: ["name": name], as: CreatedToken.self).token }
    func removeToken(_ id: String) async throws { try await perform("DELETE", "/api/auth/tokens/\(Self.enc(id))") }
    func logout() async throws { try await perform("POST", "/api/auth/logout") }
    func cacheKey() async throws -> String {
        struct R: Decodable { let key: String }
        return (try await call("POST", "/api/auth/cache-key", as: R.self)).key
    }
    func previewSession() async throws -> PreviewCookie { try await call("POST", "/api/auth/native/preview-session") }

    // MARK: APNs

    func apnsStatus() async throws -> APNsStatus { try await call("GET", "/api/push/apns") }
    func registerAPNs(token: String, environment: String, waiting: Bool, done: Bool, privatePreview: Bool) async throws -> APNsStatus {
        try await call("PUT", "/api/push/apns", json: APNsRegistration(token: token, environment: environment, events: .init(waiting: waiting, done: done), preview: privatePreview ? "private" : "full"))
    }
    func unregisterAPNs() async throws { try await perform("DELETE", "/api/push/apns") }

    // MARK: Terminal

    /// A terminal WebSocket for the tmux window a session lives in now.
    func terminalSocket(windowId: String, columns: Int, rows: Int) async -> any WebSocketConnection {
        var components = URLComponents(url: url("/ws/\(Self.enc(windowId))"), resolvingAgainstBaseURL: false)!
        components.scheme = origin.scheme == "https" ? "wss" : "ws"
        components.queryItems = [
            URLQueryItem(name: "cols", value: String(columns)), URLQueryItem(name: "rows", value: String(rows)),
            URLQueryItem(name: "device", value: device.name), URLQueryItem(name: "client", value: device.client),
        ]
        var request = URLRequest(url: components.url!)
        if let token = await credentials.bearer() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return transport.webSocket(for: request)
    }
}

/// How other devices see this one ("also open on iPhone") and which window of it a draft or
/// viewer belongs to. `client` is per scene, so two iPad windows count as two pages.
struct DeviceDescriptor: Sendable, Equatable {
    var name: String
    var client: String

    /// The server's device-name filter (`[^\w .-]`, 24 chars) applied ahead of time.
    static func sanitizedName(_ raw: String) -> String {
        let kept = raw.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == " " || $0 == "." || $0 == "-") }
        let trimmed = String(kept.prefix(24)).trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "iPhone" : trimmed
    }

    /// A Mac's name from its host name ("Evyatars-MacBook-Pro.local" → "Evyatars MacBook Pro"):
    /// on a Mac the system calls the device an iPad.
    static func macName(hostName: String) -> String {
        var name = hostName
        if name.hasSuffix(".local") { name = String(name.dropLast(".local".count)) }
        let words = name.replacingOccurrences(of: "-", with: " ")
        let cleaned = sanitizedName(words)
        return cleaned == "iPhone" ? "Mac" : cleaned
    }

    static func newClientID() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))
    }
}

struct PreviewCookie: Codable, Equatable, Sendable {
    struct Names: Codable, Equatable, Sendable { let https: String; let http: String }
    let value: String
    let expiresAt: Double
    let names: Names
}

// MARK: - Request bodies

private struct SendBody: Encodable { let text: String; let enter: Bool }
private struct CurrentQuestion: Encodable {
    struct Current: Encodable { let question: String; let answer: QuestionAnswer }
    let current: Current
}
private struct ChatAboutQuestions: Encodable {
    let chat = true
    let question: String?
}
private struct LaunchChange: Encodable { let model: String?; let effort: String?; let mode: String? }
private struct ModelsQuery: Encodable { let baseUrl: String; let apiKey: String?; let id: String? }
private struct SummarizeBody: Encodable { let text: String; let subscriptionId: String? }
private struct EnvBody: Encodable { let name: String; let value: String?; let secret: Bool }
private struct CustomAgent: Encodable { let name: String; let command: String; let resume: String? }
private struct RemoveWorktree: Encodable { let path: String; let force: Bool }
private struct APNsRegistration: Encodable {
    struct Events: Encodable { let waiting: Bool; let done: Bool }
    let token: String
    let environment: String
    let events: Events
    let preview: String
}

/// Lets `call` take any Encodable body without generic plumbing at every call site.
struct AnyEncodable: Encodable {
    private let encodeValue: (any Encoder) throws -> Void
    init(_ value: any Encodable) { encodeValue = { try value.encode(to: $0) } }
    func encode(to encoder: any Encoder) throws { try encodeValue(encoder) }
}
