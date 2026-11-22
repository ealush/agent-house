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

/// Typed client for one host's API (`apps/server/web/api.ts`), addressed through the hub:
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

    func send(_ request: URLRequest, fromFile file: URL? = nil, progress: (@Sendable (Double) -> Void)? = nil) async throws -> Data {
        let started = ContinuousClock.now
        var status: Int?
        do {
            try Task.checkCancellation()
            let (data, response): (Data, HTTPURLResponse)
            if let progress {
                (data, response) = try await transport.upload(for: request, body: file.map(UploadBody.file) ?? .data(request.httpBody ?? Data()), progress: progress)
            } else if let file {
                (data, response) = try await transport.upload(for: request, fromFile: file)
            } else {
                (data, response) = try await transport.data(for: request)
            }
            status = response.statusCode
            guard (200..<300).contains(response.statusCode) else {
                let error = APIError(status: response.statusCode, body: data)
                if case .unauthorized = error { await refused(request) }
                throw error
            }
            ClientLog.shared.request(request, status: status, started: started, error: nil)
            return data
        } catch {
            let error = APIError.wrap(error)
            ClientLog.shared.request(request, status: status, started: started, error: error)
            throw error
        }
    }

    /// Like `send`, but a refusal comes back as its status and body (a 409 that carries the
    /// host's version of something); sign-in rejections and transport failures still throw.
    func exchange(_ request: URLRequest) async throws -> (status: Int, data: Data) {
        let started = ContinuousClock.now
        do {
            try Task.checkCancellation()
            let (data, response) = try await transport.data(for: request)
            ClientLog.shared.request(request, status: response.statusCode, started: started, error: (200..<300).contains(response.statusCode) ? nil : APIError(status: response.statusCode, body: data))
            if response.statusCode == 401 {
                await refused(request)
                throw APIError(status: 401, body: data)
            }
            return (response.statusCode, data)
        } catch let error as APIError {
            throw error
        } catch {
            let error = APIError.wrap(error)
            ClientLog.shared.request(request, status: nil, started: started, error: error)
            throw error
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
            return try await checkedStream(request).stream
        } catch {
            throw APIError.wrap(error)
        }
    }

    /// A streaming response once it's known to be a success; a failure reads its first few
    /// kilobytes for the host's reason.
    private func checkedStream(_ request: URLRequest) async throws -> (response: HTTPURLResponse, stream: AsyncThrowingStream<Data, any Error>) {
        let (response, stream) = try await transport.stream(for: request)
        guard (200..<300).contains(response.statusCode) else {
            var body = Data()
            for try await chunk in stream {
                body.append(chunk)
                if body.count > 4096 { break }
            }
            let error = APIError(status: response.statusCode, body: body)
            if case .unauthorized = error { await refused(request) }
            throw error
        }
        return (response, stream)
    }

    /// A 401 from the hub itself is this device's sign-in refused. One through it from a peer
    /// (`/h/<peer>/…`, which the hub passes on as it came) is only that host not trusting the
    /// hub: signing out over it wiped the device's sign-in, and the peer's stream, started again
    /// on signing back in, did it again. Without its own sign-in the hub refuses `/h/` too, and
    /// its own stream says so.
    private func refused(_ request: URLRequest) async {
        guard scope == nil else { return }
        await credentials.rejected(bearer: Self.bearer(of: request))
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
    func attachedTerminal(_ uid: String) async throws -> AttachedTerminalResponse { try await call("GET", "\(s(uid))/terminal") }
    /// `run: false` types the command without pressing Return (attachedTerminal 2).
    func openTerminal(_ uid: String, command: String? = nil, run: Bool = true) async throws -> AttachedTerminalResponse {
        guard let command else { return try await call("POST", "\(s(uid))/terminal", json: [String: String]()) }
        if run { return try await call("POST", "\(s(uid))/terminal", json: ["command": command]) }
        return try await call("POST", "\(s(uid))/terminal", json: TypedCommand(command: command, run: false))
    }
    private struct TypedCommand: Encodable { let command: String; let run: Bool }
    func terminalText(_ uid: String) async throws -> AttachedTerminalText { try await call("GET", "\(s(uid))/terminal/text") }
    func closeTerminal(_ uid: String) async throws { try await perform("DELETE", "\(s(uid))/terminal") }
    func capture(_ uid: String, lines: Int = 3000) async throws -> String {
        String(decoding: try await send(await request("GET", "\(s(uid))/capture", query: [URLQueryItem(name: "lines", value: String(lines))])), as: UTF8.self)
    }
    func resume(_ ref: String) async throws -> ResumeResult { try await call("POST", "\(s(ref))/resume") }
    func forkInfo(_ ref: String) async throws -> ForkInfo { try await call("GET", "\(s(ref))/fork-info") }
    func fork(_ ref: String, _ body: ForkRequest) async throws -> ForkResult { try await call("POST", "\(s(ref))/fork", json: body) }
    func send(_ ref: String, text: String, enter: Bool = true) async throws -> SendResult {
        do {
            let result: SendResult = try await call("POST", "\(s(ref))/send", json: SendBody(text: text, enter: enter))
            ClientLog.shared.sent(ref: ref, text: text, enter: enter, outcome: result.outcome.rawValue, extra: ["host": .string(scope ?? "local"), "queued": .number(Double(result.queued))])
            return result
        } catch {
            ClientLog.shared.sent(ref: ref, text: text, enter: enter, outcome: "failed", extra: ["host": .string(scope ?? "local"), "error": .string(APIError.wrap(error).message)])
            throw error
        }
    }
    /// One-tap Approve / Deny. `prompt`: the `askId` the answer is about (a notification's);
    /// the host refuses it (409) if the session asks something else now. Older hosts ignore it.
    func answer(_ uid: String, approve: Bool, prompt: String? = nil) async throws {
        var body = ["answer": approve ? "approve" : "deny"]
        if let prompt { body["prompt"] = prompt }
        try await perform("POST", "\(s(uid))/answer", json: body)
    }
    func choose(_ uid: String, key: String) async throws -> ChooseResult { try await call("POST", "\(s(uid))/choose", json: ["key": key]) }
    /// Types what the screen in front of the prompt asks for (a code, an API key); the host
    /// never keeps it. Or, with `back`, Esc where the screen says Esc goes back.
    func answerGate(_ uid: String, text: String) async throws { try await perform("POST", "\(s(uid))/gate", json: ["text": text]) }
    func gateBack(_ uid: String) async throws { try await perform("POST", "\(s(uid))/gate", json: ["back": true]) }
    /// The address a browser here stopped on after a sign-in that hands back to the host's
    /// 127.0.0.1: the host opens it where the agent listens, if it is that sign-in's own.
    func gateCallback(_ uid: String, address: String) async throws { try await perform("POST", "\(s(uid))/gate", json: ["callback": address]) }
    func commands(_ uid: String) async throws -> [SlashCommand] { try await call("GET", "\(s(uid))/commands") }
    func files(_ uid: String, query: String) async throws -> [String] { try await call("GET", "\(s(uid))/files", query: [URLQueryItem(name: "q", value: query)]) }
    /// The @ completion's files under a folder, relative to it (`folderFiles`): a note's Space, which has no session to ask.
    func folderFiles(_ dir: String, query: String) async throws -> [String] { try await call("GET", "/api/fs/complete", query: [URLQueryItem(name: "dir", value: dir), URLQueryItem(name: "q", value: query)]) }
    func answerQuestions(_ uid: String, _ answers: [QuestionAnswer]) async throws { try await perform("POST", "\(s(uid))/questions", json: ["answers": answers]) }
    func answerQuestion(_ uid: String, question: String, answer: QuestionAnswer) async throws {
        try await perform("POST", "\(s(uid))/questions", json: CurrentQuestion(current: .init(question: question, answer: answer)))
    }
    /// The dialog's "Chat about this": declines its questions and hands the conversation back.
    func chatAboutQuestions(_ uid: String, question: String?) async throws {
        try await perform("POST", "\(s(uid))/questions", json: ChatAboutQuestions(question: question))
    }
    func queue(_ uid: String) async throws -> [QueueItem] { try await call("GET", "\(s(uid))/queue") }
    /// The queue after what the agent never took (`unsent` 1); positions in it aren't the queue's.
    func queueAndUnsent(_ uid: String) async throws -> [QueueItem] { try await call("GET", "\(s(uid))/queue", query: [URLQueryItem(name: "unsent", value: "1")]) }
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

    /// The newest entry this device holds of a transcript: the host carries on after it.
    struct FeedResume: Equatable, Sendable {
        let after: Int
        let id: String
        let harness: String
    }

    func feedStream(_ ref: String, resume: FeedResume? = nil) async throws -> AsyncThrowingStream<Data, any Error> {
        var query = [URLQueryItem(name: "device", value: device.name), URLQueryItem(name: "client", value: device.client)]
        if let resume {
            query += [URLQueryItem(name: "after", value: String(resume.after)), URLQueryItem(name: "id", value: resume.id), URLQueryItem(name: "harness", value: resume.harness)]
        }
        return try await eventStream("\(s(ref))/feed/stream", query: query)
    }
    func feedPage(_ ref: String, before: Int?, limit: Int = 200) async throws -> FeedPage {
        try await call("GET", "\(s(ref))/feed", query: [URLQueryItem(name: "before", value: before.map(String.init) ?? "Infinity"), URLQueryItem(name: "limit", value: String(limit))])
    }
    func feedPrompts(_ ref: String) async throws -> [FeedPrompt] { (try await call("GET", "\(s(ref))/feed/prompts", as: PromptsResult.self)).prompts }

    // MARK: Subagents

    /// The agents a session's agent spawned, as a tree (`features.subagents`). `ref`: a live
    /// uid, a history ref, or a child's own ref (which answers its whole tree, naming it in `selfRef`).
    func subagents(_ ref: String) async throws -> SubagentTreeDTO { try await call("GET", "\(s(ref))/subagents") }

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

    // MARK: Voice (`features.voice`, docs/spec/14-voice.md)

    func voiceSettings() async throws -> VoiceSettings { try await call("GET", "/api/voice") }
    func saveVoice(_ change: VoiceChange) async throws -> VoiceSettings { try await call("PUT", "/api/voice", json: change) }
    /// The speech models a subscription's endpoint lists (chat ones come from `subscriptionModels`).
    func speechModels(subscriptionId: String) async throws -> [String] {
        (try await call("POST", "/api/voice/models", json: ["subscriptionId": subscriptionId], as: ModelsResult.self)).models
    }
    /// A recording (AAC in an `.m4a`) heard by the host's speech subscription, tidied unless `style` is verbatim.
    /// `context`: what was heard before it, for a batch of a longer dictation (the speech model reads it as what came before).
    func dictate(_ file: URL, style: VoiceStyle? = nil, context: String = "") async throws -> DictationResult {
        var query = [URLQueryItem(name: "name", value: "speech.\(file.pathExtension.isEmpty ? "m4a" : file.pathExtension)")]
        if let style { query.append(URLQueryItem(name: "style", value: style.rawValue)) }
        // Its end is what the speech model reads; the host takes up to 2000 characters.
        if !context.isEmpty { query.append(URLQueryItem(name: "context", value: String(context.suffix(1200)))) }
        var req = await request("POST", "/api/voice/dictate", query: query, contentType: "audio/mp4")
        req.httpBody = nil
        // A minute of speech is a few hundred KB; the provider then takes its time.
        req.timeoutInterval = 120
        do {
            return try JSONDecoder().decode(DictationResult.self, from: try await send(req, fromFile: file))
        } catch let error as DecodingError {
            throw APIError.decoding(String(describing: error))
        }
    }
    /// Text tidied by the host's cleanup subscription: written on this device, or a batched
    /// dictation's batches. `phone`: this device's own hearing of the same speech, to check against.
    func refine(_ text: String, style: VoiceStyle? = nil, phone: String? = nil) async throws -> RefinedText {
        try await call("POST", "/api/voice/refine", json: RefineBody(text: text, style: style?.rawValue, phone: phone))
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
    /// Agent House in the host's app launcher (on Omarchy, through its web-app installer).
    func desktop() async throws -> DesktopStatus { try await call("GET", "/api/system/desktop") }
    func setDesktop(install: Bool) async throws -> DesktopAction { try await call("POST", "/api/system/desktop", json: ["action": install ? "install" : "uninstall"]) }
    /// Builds the web app again from the host's checkout, then restarts: minutes, not seconds.
    func rebuild() async throws {
        var request = await request("POST", "/api/system/rebuild")
        request.timeoutInterval = 15 * 60
        _ = try await send(request)
    }
    /// The host's developer log: on or off, where, and its kept days (feature `logging`).
    func logging() async throws -> LoggingStatus { try await call("GET", "/api/system/logging") }
    func setLogging(server: Bool) async throws -> LoggingStatus { try await call("PUT", "/api/system/logging", json: ["server": server]) }
    /// A stretch of this device's log, kept on the host beside its own; answers with the file.
    func sendClientLog(_ bundle: ClientLogBundle) async throws -> ClientLogSaved {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        var req = await request("POST", "/api/system/logging/client", body: try encoder.encode(bundle))
        req.timeoutInterval = 120
        return try JSONDecoder().decode(ClientLogSaved.self, from: try await send(req))
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
    /// A host file's bytes, authenticated (for Quick Look and images).
    func file(_ path: String) async throws -> Data { try await send(await request("GET", "/api/fs/file", query: [URLQueryItem(name: "path", value: path)])) }

    /// How a host file's download to disk ended.
    enum Download: Equatable, Sendable {
        /// All of it is in the file: this many bytes.
        case saved(Int)
        /// Past the limit (this many bytes as the host said, or as many as came before it was
        /// passed): nothing is kept.
        case tooBig(Int)
    }

    /// A host file written to `file` as it comes, never all in memory (a screen recording runs to
    /// hundreds of megabytes). `atMost`: given up on as soon as it's known to be bigger.
    /// `progress`: the share so far, when the host says how big it is.
    func download(_ path: String, to file: URL, atMost limit: Int? = nil, progress: (@Sendable (Double) -> Void)? = nil) async throws -> Download {
        let request = await request("GET", "/api/fs/file", query: [URLQueryItem(name: "path", value: path)])
        do {
            let (response, stream) = try await checkedStream(request)
            let expected = response.expectedContentLength
            if let limit, expected > limit { return .tooBig(Int(expected)) }
            guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw APIError.transport("couldn't write \(file.lastPathComponent)") }
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
            #endif
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            var written = 0
            for try await chunk in stream {
                written += chunk.count
                if let limit, written > limit {
                    try? FileManager.default.removeItem(at: file)
                    return .tooBig(written)
                }
                try handle.write(contentsOf: chunk)
                if let progress, expected > 0 { progress(min(1, Double(written) / Double(expected))) }
            }
            // A stream cut short (cancelled, the connection dropped) can end as if it were done.
            try Task.checkCancellation()
            if expected > 0, written != expected { throw APIError.transport("\(file.lastPathComponent) came incomplete") }
            return .saved(written)
        } catch {
            try? FileManager.default.removeItem(at: file)
            throw APIError.wrap(error)
        }
    }
    func mkdir(_ path: String) async throws -> String { (try await call("POST", "/api/fs/mkdir", json: ["path": path], as: UploadedPath.self)).path }
    /// Upload into a folder on the host (Files panel).
    func uploadFile(into dir: String, name: String, data: Data) async throws -> String {
        let req = await request("POST", "/api/fs/upload", query: [URLQueryItem(name: "dir", value: dir), URLQueryItem(name: "name", value: name)], body: data, contentType: "application/octet-stream")
        return try JSONDecoder().decode(UploadedPath.self, from: try await send(req)).path
    }
    /// An attachment for a prompt: lands in ah's upload folder; its path goes into the message.
    /// `progress`: the share sent so far, as it goes.
    func upload(name: String, data: Data, progress: (@Sendable (Double) -> Void)? = nil) async throws -> String {
        var req = await request("POST", "/api/upload", query: [URLQueryItem(name: "name", value: name)], body: data, contentType: "application/octet-stream")
        // Between bytes: the host only answers once the last one lands (a photo on a slow
        // connection took longer than the default).
        req.timeoutInterval = 120
        let path = try JSONDecoder().decode(UploadedPath.self, from: try await send(req, progress: progress)).path
        ClientLog.shared.uploaded(path: path, bytes: data.count, name: name)
        return path
    }

    /// The same from a file on disk, for what's too big to hold in memory (a video).
    func upload(name: String, file: URL, progress: (@Sendable (Double) -> Void)? = nil) async throws -> String {
        var req = await request("POST", "/api/upload", query: [URLQueryItem(name: "name", value: name)], contentType: "application/octet-stream")
        req.httpBody = nil
        // Between bytes: the host only answers once the last one lands.
        req.timeoutInterval = 120
        let path = try JSONDecoder().decode(UploadedPath.self, from: try await send(req, fromFile: file, progress: progress)).path
        let bytes = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        ClientLog.shared.uploaded(path: path, bytes: bytes, name: name)
        return path
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

    // MARK: Portable conversations (`features.portable`)

    func portableCapabilities() async throws -> PortableCapabilities { try await call("GET", "/api/portable/capabilities") }
    /// What continuing `ref` (a session uid, or `harness:harnessId`) in another agent would
    /// carry over; starts nothing.
    func continuePreview(_ ref: String, _ request: ContinueRequest) async throws -> ContinuePlan {
        try await call("POST", "/api/portable/conversations/\(Self.enc(ref))/preview", json: request)
    }
    func continueConversation(_ ref: String, _ request: ContinueRequest) async throws -> ContinueStarted {
        try await call("POST", "/api/portable/conversations/\(Self.enc(ref))/continue", json: request)
    }
    func continueOperation(_ id: String) async throws -> ContinueOperation { try await call("GET", "/api/portable/operations/\(Self.enc(id))") }
    func retryContinue(_ id: String) async throws -> ContinueOperation { try await call("POST", "/api/portable/operations/\(Self.enc(id))/retry") }
    func cancelContinue(_ id: String) async throws -> ContinueOperation { try await call("POST", "/api/portable/operations/\(Self.enc(id))/cancel") }
    func lineage(_ ref: String) async throws -> PortableLineage { try await call("GET", "/api/portable/conversations/\(Self.enc(ref))/lineage") }
    /// A Live Activity this device started for session `uid`: the host moves it along by push.
    func registerActivity(_ uid: String, token: String, environment: String) async throws {
        try await perform("PUT", "/api/push/apns/activity", json: ActivityRegistration(uid: uid, token: token, environment: environment))
    }
    func unregisterActivity(_ uid: String) async throws { try await perform("DELETE", "/api/push/apns/activity/\(Self.enc(uid))") }

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
private struct RefineBody: Encodable { let text: String; let style: String?; let phone: String? }
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
