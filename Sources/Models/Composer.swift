import Foundation
import Observation

/// Messages sent from this device, shown before the server has them (`../ah/web/outbox.ts`).
/// The composer adds one the moment you send; the transcript draws it as your bubble (or the
/// queue tray as a queued row) until the real thing arrives. A failed send takes it back.
/// Shared by every window, so a pane anywhere shows what any composer sent.
@MainActor
@Observable
final class Outbox {
    struct Item: Equatable, Identifiable, Sendable {
        enum State: String, Sendable {
            /// The request is in flight.
            case sending
            /// Typed into the agent; waiting for its transcript to show it.
            case sent
            /// Held until the agent is free.
            case queued
        }
        let id: Int
        let key: String
        let text: String
        /// Seconds since the epoch.
        let at: Double
        var state: State
        /// When the server answered; a queue fetch that started later has the real row.
        var confirmedAt: Double?
    }

    private(set) var items: [Item] = []
    private var nextID = 0
    var now: () -> Double = { Date().timeIntervalSince1970 }

    func add(key: String, text: String, state: Item.State) -> Int {
        nextID += 1
        items.append(Item(id: nextID, key: key, text: text, at: now(), state: state))
        return nextID
    }

    func update(_ id: Int, state: Item.State, confirmedAt: Double?) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].state = state
        items[i].confirmedAt = confirmedAt
    }

    func remove(_ ids: [Int]) {
        guard !ids.isEmpty else { return }
        let drop = Set(ids)
        items.removeAll { drop.contains($0.id) }
    }

    func items(for key: String) -> [Item] { items.filter { $0.key == key } }

    /// Whitespace-insensitive, the way a transcript may reflow what was typed.
    static func sameText(_ a: String, _ b: String) -> Bool {
        func squash(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        return squash(a) == squash(b)
    }

    /// Sent bubbles leave once the transcript shows a user turn with the same text from
    /// around then (an older identical message isn't this one), or after 30 seconds. One still
    /// sending leaves too when the transcript has it: it landed, and waiting for the request to
    /// answer drew the message twice until the next update.
    func retireSent(key: String, userTurns: [(at: Double, text: String)]) {
        let t = now()
        let done = items.filter { item in
            guard item.key == key, item.state == .sent || item.state == .sending else { return false }
            if item.state == .sent, t - item.at > 30 { return true }
            return userTurns.contains { turn in (turn.at == 0 || turn.at >= item.at - 10) && Outbox.sameText(turn.text, item.text) }
        }
        remove(done.map(\.id))
    }

    /// Queued copies leave once a queue fetch that began after the server confirmed them returns.
    func retireQueued(key: String, fetchStarted: Double) {
        remove(items.filter { $0.key == key && $0.state == .queued && ($0.confirmedAt ?? .infinity) <= fetchStarted }.map(\.id))
    }

    /// Something of ours is still landing: a new message should show as queued too.
    func isLanding(key: String) -> Bool {
        let t = now()
        return items.contains { $0.key == key && ($0.state == .queued || (t - $0.at < 5 && ($0.state == .sending || $0.state == .sent))) }
    }
}

/// Keeps a composer's unsent text on the host (`../ah/web/useDraftSync.ts`), so a message
/// started on one device is on the next. The host's copy only fills a box nobody typed in
/// since the last sync: what's typed here always wins.
@MainActor
@Observable
final class DraftSync {
    private let api: APIClient
    let uid: String
    private let debounce: Duration
    /// The text last saved to or loaded from the host.
    private var synced = ""
    private var pending: String?
    private var timer: Task<Void, Never>?
    /// The device a pulled draft came from ("Continued from iPhone"), when it's another one.
    private(set) var from: String?

    init(api: APIClient, uid: String, debounce: Duration = .milliseconds(700)) {
        self.api = api
        self.uid = uid
        self.debounce = debounce
    }

    /// On open and on returning to the foreground. Returns the text to show, or nil to keep the box as is.
    func pull(current here: String) async -> String? {
        // A failed read changes nothing; no draft at all (sent or cleared elsewhere) is adopted as "".
        let result: Result<Draft?, any Error> = await { do { return .success(try await api.draft(uid)) } catch { return .failure(error) } }()
        guard case .success(let draft) = result else { return nil }
        return adopt(draft, current: here)
    }

    /// Applies a fetched draft (testable without the network).
    func adopt(_ draft: Draft?, current here: String) -> String? {
        guard pending == nil, here == synced else { return nil }
        // No draft there: sent or cleared elsewhere, and an untouched box follows.
        let there: String? = draft == nil ? "" : (draft!.client == api.device.client ? nil : draft!.text)
        guard let there, there != here else { return nil }
        synced = there
        from = draft.flatMap { $0.device != api.device.name ? $0.device : nil }
        return there
    }

    /// The text changed here: save shortly after typing stops.
    func edited(_ text: String) {
        if text == synced && pending == nil { return }
        if text != synced { from = nil }
        pending = text
        timer?.cancel()
        timer = Task { [weak self, debounce] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            // Not flush(): that cancels the timer, which is this task, and the save with it.
            self?.timer = nil
            await self?.save()
        }
    }

    /// Sent or cleared: tell the host now, not after the debounce.
    func saveNow(_ text: String) async {
        pending = text
        await flush()
    }

    /// Going to the background: what was typed is saved before it's picked up elsewhere.
    func flush() async {
        timer?.cancel()
        timer = nil
        await save()
    }

    private func save() async {
        guard let text = pending else { return }
        pending = nil
        synced = text
        _ = try? await api.saveDraft(uid, text: text)
    }
}

/// A session's queued follow-ups (`../ah/web/QueueTray.tsx`): send now (steer), edit,
/// cancel, cancel all, reorder. Polled while anything is queued; mid-drag the rows stay put.
@MainActor
@Observable
final class QueueModel {
    private let api: APIClient
    private let outbox: Outbox
    let uid: String
    let key: String
    private(set) var items: [QueueItem] = []
    /// Being sent now (a steer can take seconds): a second press goes to the next row.
    private(set) var sending: Set<String> = []
    var isDragging = false
    private(set) var error: String?
    private var poll: Task<Void, Never>?

    init(api: APIClient, outbox: Outbox, uid: String, key: String) {
        self.api = api
        self.outbox = outbox
        self.uid = uid
        self.key = key
    }

    /// Our queued messages the server hasn't listed yet.
    var pendingRows: [Outbox.Item] {
        outbox.items(for: key).filter { mine in mine.state == .queued && (mine.confirmedAt == nil || !items.contains { $0.text == mine.text }) }
    }

    var isEmpty: Bool { items.isEmpty && pendingRows.isEmpty }

    func load() async {
        let started = Date().timeIntervalSince1970
        do {
            let list = try await api.queue(uid)
            if !isDragging { items = list }
            outbox.retireQueued(key: key, fetchStarted: started)
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// Keep polling while the session reports a queue, ours is landing, or rows show.
    func watch(queued: Int) {
        let active = queued > 0 || outbox.items(for: key).contains { $0.state == .queued } || !items.isEmpty
        if !active {
            poll?.cancel()
            poll = nil
            return
        }
        guard poll == nil else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.load()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func stop() {
        poll?.cancel()
        poll = nil
    }

    private func act(_ what: String, _ body: () async throws -> Void) async {
        do {
            try await body()
            error = nil
        } catch {
            self.error = "Couldn’t \(what): \(APIError.wrap(error).message)"
        }
        await load()
    }

    @discardableResult
    func steer(_ item: QueueItem) async -> SendResult? {
        guard !sending.contains(item.id) else { return nil }
        sending.insert(item.id)
        defer { sending.remove(item.id) }
        var result: SendResult?
        await act("send it now") { result = try await api.sendNow(uid, item: item.id) }
        return result
    }

    /// Empty Enter, ⌃⌥S: the oldest one not already on its way. False when there's none.
    @discardableResult
    func steerFirst() -> Bool {
        guard let next = items.first(where: { !sending.contains($0.id) }) else { return false }
        Task { await steer(next) }
        return true
    }

    func cancel(_ item: QueueItem) async {
        await act("cancel it") { try await api.clearQueue(uid, item: item.id) }
    }

    func cancelAll() async {
        await act("cancel the queue") { try await api.clearQueue(uid) }
    }

    /// Shown at once, then the server's order.
    func move(_ id: String, to: Int) async {
        guard let from = items.firstIndex(where: { $0.id == id }), from != to, items.indices.contains(to) else { return }
        let item = items.remove(at: from)
        items.insert(item, at: to)
        await act("reorder the queue") { items = try await api.moveQueued(uid, item: id, to: to) }
    }

    /// Edit: take it out of the queue; its text goes back into the composer.
    func edit(_ item: QueueItem) async -> String? {
        do {
            try await api.clearQueue(uid, item: item.id)
            await load()
            return item.text
        } catch {
            self.error = "Couldn’t edit it: \(APIError.wrap(error).message)"
            return nil
        }
    }
}

/// The message bar under a GUI session (`../ah/web/Composer.tsx`). It goes through the
/// server, which types the text in now (idle agent, any shell), queues it while an agent
/// works, answers a waiting prompt, or resumes an ended session first. Sending is
/// optimistic and serialized; a refused send comes back into the box.
@MainActor
@Observable
final class ComposerModel {
    struct Attachment: Equatable, Identifiable, Sendable {
        let id: Int
        let name: String
        let image: Bool
        /// Set once the upload finished.
        var path: String?
        var thumbnail: Data?
    }

    enum Event: Equatable, Sendable {
        case sent(SendResult)
        case failed(String)
        case interrupted
        case notice(String)
    }

    private let api: APIClient
    private let outbox: Outbox
    let key: String
    let uid: String
    /// A shell takes commands, an agent messages. Follows the session: a just-started agent
    /// is listed before ah knows which agent it is.
    var isShell: Bool
    let drafts: DraftSync

    var text = "" {
        didSet {
            guard text != oldValue else { return }
            drafts.edited(text)
        }
    }
    private(set) var attachments: [Attachment] = []
    private var videoUploads: [Int: Task<Void, Never>] = [:]
    private(set) var recent: [String] = []
    private var cursor = -1
    private(set) var justSent = false
    private(set) var events: [Event] = []
    private var chain: Task<Void, Never>?
    private var nextAttachment = 0
    var caret = 0
    private(set) var suggestions: [CompletionTrigger.Item] = []
    private var dismissedTrigger: String?
    private var commands: [SlashCommand]?
    private var suggestTask: Task<Void, Never>?

    init(api: APIClient, outbox: Outbox, key: String, uid: String, isShell: Bool, draftDebounce: Duration = .milliseconds(700)) {
        self.api = api
        self.outbox = outbox
        self.key = key
        self.uid = uid
        self.isShell = isShell
        drafts = DraftSync(api: api, uid: uid, debounce: draftDebounce)
    }

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty }
    var isUploading: Bool { attachments.contains { $0.path == nil } }
    var canSend: Bool { !isEmpty && !isUploading }

    /// Stop replaces Send only for a working agent and an empty box, and not right after a send.
    func showsStop(working: Bool) -> Bool { !isShell && working && isEmpty && !justSent }

    func placeholder(working: Bool, queued: Int, touchOnly: Bool, agent: String? = nil, waiting: Bool = false, ended: Bool = false) -> String {
        Self.placeholder(isShell: isShell, working: working, queued: queued, touchOnly: touchOnly, agent: agent, waiting: waiting, ended: ended)
    }

    /// What Send will do now (ah's Composer): message the agent, add to its queue, answer it, or
    /// resume it. Keys are named only when there's a keyboard.
    nonisolated static func placeholder(isShell: Bool, working: Bool, queued: Int, touchOnly: Bool, agent: String? = nil, waiting: Bool = false, ended: Bool = false) -> String {
        if isShell { return "Type or paste a command" }
        if ended { return "Message to resume" }
        if waiting { return "Reply to answer" }
        if working && queued > 0 { return touchOnly ? "Add to the queue · sent when it’s free" : "Add to the queue · ↵ on empty steers the next · ⌘↵ sends now · esc stops" }
        if working { return touchOnly ? "Add to the queue · sent when it’s free" : "Add to the queue · sent when it’s free · ⌘↵ sends now · esc stops" }
        return "Message \(agent ?? "the agent") · / commands · @ files"
    }

    /// The longest run of a placeholder's " · " hints, from the start, that fits the width.
    nonisolated static func fitting(_ placeholder: String, width: Double, measure: (String) -> Double) -> String {
        var parts = placeholder.components(separatedBy: " · ")
        while parts.count > 1, measure(parts.joined(separator: " · ")) > width { parts.removeLast() }
        return parts.joined(separator: " · ")
    }

    func takeEvents() -> [Event] {
        defer { events = [] }
        return events
    }

    // MARK: Open, foreground, background

    func open() async {
        if let pulled = await drafts.pull(current: text) { text = pulled }
        if let prompts = try? await api.prompts() { recent = prompts.map(\.text) }
    }

    func foreground() async {
        if let pulled = await drafts.pull(current: text) { text = pulled }
    }

    func background() async { await drafts.flush() }

    // MARK: Sending

    /// Return in the box. False when there was nothing to send (an empty box steers instead).
    ///
    /// `steer`: while the agent works, don't wait for the turn to end: send this now (the turn
    /// stops, as a queued message's Send now does). ⌘Return in the box.
    @discardableResult
    func submit(working: Bool, steer: Bool = false) -> Bool {
        let typed = text
        let sentFiles = attachments
        guard !isEmpty, !isUploading else { return false }
        let message = (sentFiles.compactMap(\.path).map(Uploads.shellQuote) + [typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : typed]).filter { !$0.isEmpty }.joined(separator: " ")
        // The server decides; this only picks where it shows until the server says.
        let state: Outbox.Item.State = (working || outbox.isLanding(key: key)) && !isShell && !steer ? .queued : .sending
        let id = outbox.add(key: key, text: message, state: state)
        recent = [message] + recent.filter { $0 != message }
        cursor = -1
        text = ""
        attachments = []
        justSent = true
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            self?.justSent = false
        }
        let previous = chain
        chain = Task { [weak self, api, uid] in
            await previous?.value
            await self?.drafts.saveNow("")
            do {
                let result = try await api.send(uid, text: message)
                if steer, result.outcome == .queued, let queued = result.queueId {
                    // Queued behind the turn: send it now instead.
                    let now = try await api.sendNow(uid, item: queued)
                    self?.outbox.update(id, state: .sent, confirmedAt: Date().timeIntervalSince1970)
                    self?.events.append(.sent(now))
                    return
                }
                self?.outbox.update(id, state: result.outcome == .queued ? .queued : .sent, confirmedAt: Date().timeIntervalSince1970)
                self?.events.append(.sent(result))
            } catch {
                guard let self else { return }
                self.outbox.remove([id])
                // Back into the box, unless something new was typed or attached meanwhile.
                if self.text.isEmpty { self.text = typed }
                if self.attachments.isEmpty { self.attachments = sentFiles }
                self.events.append(.failed("Couldn’t send: \(APIError.wrap(error).message)"))
            }
        }
        return true
    }

    /// Waits for every send so far (tests, and before leaving a session).
    func settle() async { await chain?.value }

    func stop() async {
        do {
            try await api.interrupt(uid)
            events.append(.interrupted)
        } catch {
            events.append(.failed("Couldn’t interrupt: \(APIError.wrap(error).message)"))
        }
    }

    /// ↑ in an empty box (or while recalling) walks back through recent prompts.
    func recall(_ step: Int) {
        guard !recent.isEmpty else { return }
        cursor = max(-1, min(recent.count - 1, cursor + step))
        text = cursor < 0 ? "" : recent[cursor]
    }

    var isRecalling: Bool { cursor >= 0 }

    /// A message coming back (Edit on a queued one): its uploads as tiles again.
    func compose(_ message: String) {
        let (uploads, rest) = Uploads.split(message)
        text = rest
        for upload in uploads {
            nextAttachment += 1
            attachments.append(Attachment(id: nextAttachment, name: upload.name, image: upload.image, path: upload.path))
        }
    }

    /// Insert at the caret (a file path from Files, a diff line reference).
    func insert(_ snippet: String) {
        let utf16 = Array(text.utf16)
        let at = min(max(0, caret), utf16.count)
        let head = String(decoding: utf16[..<at], as: UTF16.self)
        let tail = String(decoding: utf16[at...], as: UTF16.self)
        let spacer = head.isEmpty || head.hasSuffix(" ") || head.hasSuffix("\n") ? "" : " "
        text = head + spacer + snippet + tail
        caret = at + spacer.utf16.count + snippet.utf16.count
    }

    // MARK: Attachments

    /// Upload now; a shell gets the path typed in, an agent gets a tile sent with the message.
    func attach(name: String, data: Data, image: Bool, thumbnail: Data? = nil) async {
        if isShell {
            do {
                let path = try await api.upload(name: name, data: data)
                text += (text.isEmpty || text.hasSuffix(" ") ? "" : " ") + Uploads.shellQuote(path) + " "
            } catch {
                events.append(.failed("Couldn’t attach \(name): \(APIError.wrap(error).message)"))
            }
            return
        }
        nextAttachment += 1
        let id = nextAttachment
        attachments.append(Attachment(id: id, name: name, image: image, path: nil, thumbnail: thumbnail))
        do {
            let path = try await api.upload(name: name, data: data)
            if let i = attachments.firstIndex(where: { $0.id == id }) { attachments[i].path = path }
        } catch {
            attachments.removeAll { $0.id == id }
            events.append(.failed("Couldn’t attach \(name): \(APIError.wrap(error).message)"))
        }
    }

    /// A video: its tile shows at once, `load` brings the file to this device (from iCloud, that
    /// can take minutes), then it uploads from disk and the file goes. Removing the tile stops it.
    func attachVideo(name: String, load: @escaping @Sendable () async throws -> (file: URL, thumbnail: Data?)) {
        nextAttachment += 1
        let id = nextAttachment
        if !isShell { attachments.append(Attachment(id: id, name: name, image: false, path: nil)) }
        videoUploads[id] = Task { [weak self, api] in
            defer { self?.videoUploads[id] = nil }
            do {
                let loaded = try await load()
                defer { try? FileManager.default.removeItem(at: loaded.file) }
                self?.setThumbnail(loaded.thumbnail, id)
                let path = try await api.upload(name: name, file: loaded.file)
                self?.finishVideo(id, path: path)
            } catch {
                guard !Task.isCancelled else { return }
                self?.failVideo(id, name: name, error)
            }
        }
    }

    private func setThumbnail(_ thumbnail: Data?, _ id: Int) {
        if let i = attachments.firstIndex(where: { $0.id == id }) { attachments[i].thumbnail = thumbnail }
    }

    private func finishVideo(_ id: Int, path: String) {
        if isShell {
            text += (text.isEmpty || text.hasSuffix(" ") ? "" : " ") + Uploads.shellQuote(path) + " "
        } else if let i = attachments.firstIndex(where: { $0.id == id }) {
            attachments[i].path = path
        }
    }

    private func failVideo(_ id: Int, name: String, _ error: any Error) {
        attachments.removeAll { $0.id == id }
        events.append(.failed("Couldn’t attach \(name): \(APIError.wrap(error).message)"))
    }

    func removeAttachment(_ id: Int) {
        videoUploads[id]?.cancel()
        attachments.removeAll { $0.id == id }
    }

    // MARK: Completion

    var trigger: CompletionTrigger? {
        guard !isShell, let t = CompletionTrigger.at(text, caret: caret), "\(t.kind.rawValue):\(t.start)" != dismissedTrigger else { return nil }
        return t
    }

    func dismissSuggestions() {
        if let t = CompletionTrigger.at(text, caret: caret) { dismissedTrigger = "\(t.kind.rawValue):\(t.start)" }
        suggestions = []
    }

    /// Refresh suggestions for the trigger at the caret: commands once per session, files as you type.
    func updateSuggestions() {
        suggestTask?.cancel()
        guard let trigger else {
            suggestions = []
            return
        }
        suggestTask = Task { [weak self, api, uid] in
            guard let self else { return }
            switch trigger.kind {
            case .slash:
                if self.commands == nil { self.commands = (try? await api.commands(uid)) ?? [] }
                guard !Task.isCancelled else { return }
                self.suggestions = CompletionTrigger.rank(self.commands ?? [], query: trigger.query)
            case .file:
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
                let files = (try? await api.files(uid, query: trigger.query)) ?? []
                guard !Task.isCancelled else { return }
                self.suggestions = CompletionTrigger.files(files)
            }
        }
    }

    func accept(_ item: CompletionTrigger.Item) {
        guard let trigger else { return }
        let applied = trigger.applying(item, to: text)
        text = applied.text
        caret = applied.caret
        suggestions = []
    }
}
