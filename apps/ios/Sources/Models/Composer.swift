import Foundation
import Observation
#if canImport(ImageIO)
import ImageIO
#endif

/// Messages sent from this device, shown before the server has them (`apps/server/web/outbox.ts`).
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
        /// The message as it goes (its attachments' paths and your words): while it waits on
        /// an upload, the paths so far.
        var text: String
        /// Seconds since the epoch.
        let at: Double
        var state: State
        /// When the server answered; a queue fetch that started later has the real row.
        var confirmedAt: Double?
        /// The uploads it waits on before it goes (see `uploads`); none once they're up.
        var waitingOn: [Int] = []
        /// Held by the host (its queue item's id) only until a just-started agent is up: it's
        /// sent as far as you're concerned, and goes in on its own.
        var heldAs: String?
    }

    private(set) var items: [Item] = []
    private var nextID = 0
    var now: () -> Double = { Date().timeIntervalSince1970 }

    /// Every attachment's upload under way, by id, and how much of it has gone up (0 to 1).
    /// Here, not in a composer: a message sent before its photo is up still goes once it is,
    /// whichever session or screen you've gone to meanwhile.
    private(set) var uploads: [Int: Double] = [:]
    private var nextUpload = 0

    /// Asked for while a message here is under way (by its id), so it can finish with the app
    /// put away and say how it's going outside it: returns what to call once it's done. (The
    /// app's layer sets it; none in tests.)
    var keepAlive: (@MainActor (Int) -> (@MainActor () -> Void))?
    /// The same for an attachment uploading before anything's sent (named for iOS): one
    /// switched away from mid-upload was suspended, failed, and its tile went.
    var keepUploading: (@MainActor (String) -> (@MainActor () -> Void))?

    func add(key: String, text: String, state: Item.State, waitingOn: [Int] = []) -> Int {
        nextID += 1
        items.append(Item(id: nextID, key: key, text: text, at: now(), state: state, waitingOn: waitingOn))
        return nextID
    }

    /// Its uploads are up: the message as it goes now.
    func ready(_ id: Int, text: String) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].text = text
        items[i].waitingOn = []
    }

    func beginUpload() -> Int {
        nextUpload += 1
        uploads[nextUpload] = 0
        return nextUpload
    }

    /// In steps of a percent at least: every packet would have drawn its bar again.
    func progressed(_ upload: Int, _ fraction: Double) {
        guard let was = uploads[upload], fraction >= 1 || fraction - was >= 0.01 else { return }
        uploads[upload] = min(1, fraction)
    }

    func endUpload(_ upload: Int) { uploads[upload] = nil }

    /// A message that couldn't go after its box was gone: back into the session's next box.
    private var returned: [String: (text: String, reason: String)] = [:]

    func returnToBox(key: String, text: String, reason: String) {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return }
        returned[key] = (text, reason)
    }

    func takeReturned(_ key: String) -> (text: String, reason: String)? {
        defer { returned[key] = nil }
        return returned[key]
    }

    /// How far a message's uploads have got together, or nil when it waits on none.
    func progress(_ item: Item) -> Double? {
        guard !item.waitingOn.isEmpty else { return nil }
        let each = item.waitingOn.map { uploads[$0] ?? 1 }
        return each.reduce(0, +) / Double(each.count)
    }

    func update(_ id: Int, state: Item.State, confirmedAt: Double?, heldAs: String? = nil) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].state = state
        items[i].confirmedAt = confirmedAt
        items[i].heldAs = heldAs
    }

    func remove(_ ids: [Int]) {
        guard !ids.isEmpty else { return }
        let drop = Set(ids)
        items.removeAll { drop.contains($0.id) }
    }

    func items(for key: String) -> [Item] { items.filter { $0.key == key } }

    /// The same message, as a transcript may have written it: whitespace reflowed, and past
    /// that, its letters and digits alone (a paste's wrapper, invisible joiners and punctuation
    /// an input box changed left out).
    static func sameText(_ a: String, _ b: String) -> Bool {
        func squash(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        if squash(a) == squash(b) { return true }
        let x = letters(a)
        return !x.isEmpty && x == letters(b)
    }

    private static func letters(_ s: String) -> String {
        let unwrapped = s.replacingOccurrences(of: #"</?pasted_content\b[^>]*>"#, with: "", options: .regularExpression)
        return String(String.UnicodeScalarView(unwrapped.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })).lowercased()
    }

    /// Sent bubbles leave once the transcript shows a user turn with the same text from
    /// around then (an older identical message isn't this one), or after 30 seconds. One still
    /// sending leaves too when the transcript has it: it landed, and waiting for the request to
    /// answer drew the message twice until the next update. Each turn answers for one bubble.
    ///
    /// One the host has taken (sent) also leaves for a turn of yours that came after it and
    /// matches nothing here by its words: an agent can write what it was given its own way (a
    /// paste wrapped and kept whole, a picture as a placeholder), and the bubble stayed beside
    /// its own turn, the message drawn twice, for the half minute. Oldest bubble first.
    func retireSent(key: String, userTurns: [(at: Double, text: String)]) {
        let t = now()
        let mine = items.filter { $0.key == key && ($0.state == .sent || $0.state == .sending) }.sorted { $0.at < $1.at }
        var done = Set<Int>()
        var answered = Set<Int>()
        for item in mine {
            if item.state == .sent, t - item.at > 30 {
                done.insert(item.id)
                continue
            }
            if let i = userTurns.indices.first(where: { !answered.contains($0) && (userTurns[$0].at == 0 || userTurns[$0].at >= item.at - 10) && Outbox.sameText(userTurns[$0].text, item.text) }) {
                answered.insert(i)
                done.insert(item.id)
            }
        }
        // By order, only for a turn after it was sent (a couple of seconds' clock between the
        // device and the host): the turn of the message before it, sent a moment earlier,
        // isn't this one's.
        for item in mine where item.state == .sent && !done.contains(item.id) {
            if let i = userTurns.indices.first(where: { !answered.contains($0) && userTurns[$0].at >= item.at - 2 && !matchedElsewhere(userTurns[$0], key: key) }) {
                answered.insert(i)
                done.insert(item.id)
            }
        }
        remove(Array(done))
    }

    /// A turn whose words are another message still on its way here (it's that one's).
    private func matchedElsewhere(_ turn: (at: Double, text: String), key: String) -> Bool {
        items.contains { $0.key == key && $0.state == .queued && Outbox.sameText(turn.text, $0.text) }
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

/// Keeps a composer's unsent text on the host (`apps/server/web/useDraftSync.ts`), so a message
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
    /// Typed and not on the host yet, a save that failed included.
    private var pending: String?
    private var timer: Task<Void, Never>?
    /// The save going out: each waits for the one before, so a late PUT of a message can't
    /// land after the clear that sent it (the box then filled with it again on the next open).
    private var saving: Task<Bool, Never>?
    /// The device a pulled draft came from ("Continued from iPhone"), when it's another one.
    private(set) var from: String?

    init(api: APIClient, uid: String, debounce: Duration = .milliseconds(700)) {
        self.api = api
        self.uid = uid
        self.debounce = debounce
    }

    /// On open and on returning to the foreground. Returns the text to show, or nil to keep the box as is.
    func pull(current here: String) async -> String? {
        // What didn't save goes first: the host's copy is older than what's in the box.
        if pending != nil { await flush() }
        // A failed read changes nothing; no draft at all (sent or cleared elsewhere) is adopted as "".
        let result: Result<Draft?, any Error> = await { do { return .success(try await api.draft(uid)) } catch { return .failure(error) } }()
        guard case .success(let draft) = result else { return nil }
        return adopt(draft, current: here)
    }

    /// Applies a fetched draft (testable without the network).
    func adopt(_ draft: Draft?, current here: String) -> String? {
        guard pending == nil, here == synced else { return nil }
        // No draft there: sent or cleared elsewhere, and an untouched box follows. One this
        // device saved is its own echo, except into a box opened afresh (the session left
        // and come back to): there it's what you'd typed, and an empty box lost it.
        let fresh = synced.isEmpty && here.isEmpty
        let there: String? = draft == nil ? "" : (draft!.client == api.device.client && !fresh ? nil : draft!.text)
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
        let previous = saving
        let put = Task { [api, uid] in
            _ = await previous?.value
            return (try? await api.saveDraft(uid, text: text)) != nil
        }
        saving = put
        if await put.value {
            synced = text
        } else if pending == nil {
            // Not on the host: still typed here, so the host's older copy (or none) isn't taken
            // for its echo and put over it, and the next save tries again.
            pending = text
        }
    }
}

/// A session's queued follow-ups (`apps/server/web/QueueTray.tsx`): send now (steer), edit,
/// cancel, cancel all, reorder. Polled while anything is queued; mid-drag the rows stay put.
/// Above them, from a host that says (`unsent` 1), what was typed in and never reached the
/// agent: send again (steer), edit, or let go (cancel).
@MainActor
@Observable
final class QueueModel {
    private let api: APIClient
    private let outbox: Outbox
    let uid: String
    let key: String
    /// The queue as the host lists it.
    private(set) var listed: [QueueItem] = []
    /// What was typed in and the agent never took, oldest first; never among `listed`, whose
    /// positions are the queue's own.
    private(set) var unsent: [QueueItem] = []
    private let hostShowsUnsent: () -> Bool
    /// The queue as shown: less a message waiting only for a just-started agent to be up,
    /// which shows as your message in the conversation (it goes in on its own).
    var items: [QueueItem] {
        let held = Set(outbox.items(for: key).compactMap(\.heldAs))
        return held.isEmpty ? listed : listed.filter { !held.contains($0.id) }
    }
    /// Being sent now (a steer can take seconds): a second press goes to the next row.
    private(set) var sending: Set<String> = []
    var isDragging = false
    /// Every queued message in the tray, not only the next two: kept here, with the session, so
    /// going to another session and back (or changing the model) leaves the tray as it was.
    var expanded = false
    /// What went wrong: the last thing you did to the queue ("Couldn’t send it now: …"), kept
    /// until your next one, or else the last read of it. A reload clears only its own: the one
    /// right after a failed Send Now cleared why it failed, and the tap looked like nothing.
    var error: String? { failed ?? unreadable }
    private var failed: String?
    private var unreadable: String?
    private var poll: Task<Void, Never>?

    init(api: APIClient, outbox: Outbox, uid: String, key: String, hostShowsUnsent: @escaping () -> Bool = { false }) {
        self.api = api
        self.outbox = outbox
        self.uid = uid
        self.key = key
        self.hostShowsUnsent = hostShowsUnsent
    }

    /// Our queued messages the server hasn't listed yet.
    var pendingRows: [Outbox.Item] {
        outbox.items(for: key).filter { mine in mine.state == .queued && (mine.confirmedAt == nil || !items.contains { $0.text == mine.text }) }
    }

    var isEmpty: Bool { items.isEmpty && pendingRows.isEmpty && unsent.isEmpty }

    func load() async {
        let started = Date().timeIntervalSince1970
        do {
            let list = hostShowsUnsent() ? try await api.queueAndUnsent(uid) : try await api.queue(uid)
            unsent = list.filter { $0.unsent == true }
            if !isDragging { listed = list.filter { $0.unsent != true } }
            outbox.retireQueued(key: key, fetchStarted: started)
            unreadable = nil
        } catch {
            unreadable = APIError.wrap(error).message
        }
    }

    /// Keep polling while the session reports a queue, ours is landing, or the host lists rows
    /// (shown or not: a row held for a starting agent, hidden, was left listed after it went in,
    /// and came back as stale once its message was in the conversation).
    func watch(queued: Int) {
        let active = queued > 0 || outbox.items(for: key).contains { $0.state == .queued } || !listed.isEmpty || !unsent.isEmpty
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
            failed = nil
        } catch {
            failed = "Couldn’t \(what): \(APIError.wrap(error).message)"
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
        let shown = items
        guard let at = shown.firstIndex(where: { $0.id == id }), at != to, shown.indices.contains(to),
              let from = listed.firstIndex(where: { $0.id == id }), let onto = listed.firstIndex(where: { $0.id == shown[to].id }) else { return }
        let item = listed.remove(at: from)
        listed.insert(item, at: onto)
        await act("reorder the queue") { listed = try await api.moveQueued(uid, item: id, to: to) }
    }

    /// Edit: take it out of the queue, its text back into the box. Queued again from there, it
    /// goes back where it was (`place`), not to the end.
    func edit(_ item: QueueItem, into composer: ComposerModel) async {
        let shown = items
        // One that never went in was ahead of everything queued: queued again, it goes first.
        let next = unsent.contains(item) ? shown.first?.id : shown.firstIndex { $0.id == item.id }.flatMap { shown.indices.contains($0 + 1) ? shown[$0 + 1].id : nil }
        do {
            try await api.clearQueue(uid, item: item.id)
            await load()
            composer.compose(item.text)
            composer.requeueBefore = next
            failed = nil
        } catch {
            failed = "Couldn’t edit it: \(APIError.wrap(error).message)"
        }
    }

    /// An edited message queued again: before the one that followed it, if that one's still
    /// waiting (gone ahead or cancelled meanwhile, the end is as near as it gets).
    func place(_ id: String, before next: String) async {
        await load()
        guard let to = items.firstIndex(where: { $0.id == next }), let at = items.firstIndex(where: { $0.id == id }), at > to else { return }
        await move(id, to: to)
    }
}

/// The message bar under a GUI session (`apps/server/web/Composer.tsx`). It goes through the
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
        /// Its upload in the outbox (how far it's got), while one's under way.
        var upload: Int?
        /// Its name in the text ("@<token>"), a chip where it was put; none for one that goes
        /// in front of the message (one sent back by a host as only its path).
        var token: String? = nil
    }

    enum Event: Equatable, Sendable {
        case sent(SendResult)
        /// A message edited out of the queue went back into it: before this one (`QueueModel.place`).
        case requeue(String, before: String)
        case failed(String)
        case interrupted
        case notice(String)
    }

    private let api: APIClient
    let outbox: Outbox
    let key: String
    let uid: String
    /// A shell takes commands, an agent messages. Follows the session: a just-started agent
    /// is listed before ah knows which agent it is.
    var isShell: Bool
    let drafts: DraftSync

    var text = "" {
        didSet {
            guard text != oldValue else { return }
            saveDraft()
            if text.isEmpty, attachments.isEmpty { requeueBefore = nil }
            onTextChange?(oldValue, text)
        }
    }
    /// Told of every change to the text, before and after (dictation follows what it put in).
    @ObservationIgnored var onTextChange: ((String, String) -> Void)?
    /// A queued message taken out to edit (`QueueModel.edit`): queued again from this box, it
    /// goes back before the message that followed it (this one's id). The next send takes it;
    /// a box emptied without one lets it go, so a later message isn't moved for it.
    var requeueBefore: String?
    private(set) var attachments: [Attachment] = [] {
        // A file that finished uploading (or went) changes the draft: its path is in it.
        didSet { if attachments.map(\.path) != oldValue.map(\.path) { saveDraft() } }
    }
    /// Putting a pulled draft back: it's the host's already.
    private var restoring = false

    /// The draft as the host keeps it: the message it would send, each uploaded file's path
    /// where its chip is, so a box opened afresh (the session left and come back to, another
    /// device) has its pictures back, not chips naming files it no longer has.
    var draftText: String {
        Uploads.placing(attachments.compactMap { file in file.path.map { (file.token, $0) } }, in: text)
    }

    private func saveDraft() {
        // A box with no session yet (New session's) has no draft on the host to keep.
        if !uid.isEmpty, !restoring { drafts.edited(draftText) }
    }

    /// A draft from the host in the box: its files as tiles again, and as chips where they
    /// were in the words. Files still uploading here stay.
    private func restore(_ draft: String) {
        restoring = true
        defer { restoring = false }
        let kept = attachments.filter { $0.path == nil }
        let (placed, rest) = Uploads.place(draft, taken: Set(kept.compactMap(\.token)))
        attachments = kept + placed.map { p in
            nextAttachment += 1
            return Attachment(id: nextAttachment, name: p.upload.name, image: p.upload.image, path: p.upload.path, token: p.token)
        }
        text = rest
    }
    /// Each attachment's upload while it runs, by attachment: what a message sent before it's
    /// up waits on. Not cancelled by sending (the message needs it) or by leaving.
    private var uploads: [Int: Task<String, any Error>] = [:]
    private(set) var recent: [String] = []
    private var cursor = -1
    /// What was in the box when ↑ began walking back.
    private var beforeRecall = ""
    private(set) var justSent = false
    private(set) var events: [Event] = []
    private var chain: Task<Void, Never>?
    private var nextAttachment = 0
    var caret = 0
    /// Where the box puts its caret after a change made here mid-text (a picked suggestion, a
    /// snippet put in); any other change leaves it at the end. Taken once.
    @ObservationIgnored var placeCaret: Int?
    /// The settings over the box are out (a swipe up on it); folded on a send, or a scroll
    /// back through the transcript.
    var trayOpen = false
    private(set) var suggestions: [CompletionTrigger.Item] = []
    /// The highlighted suggestion (Return or Tab takes it): the first, each time the text changes.
    var suggestionIndex = 0
    /// Something floats over the transcript above the box: suggestions, or the settings tray.
    var floats: Bool { trayOpen || !suggestions.isEmpty }
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
        if let back = outbox.takeReturned(key) {
            text = back.text
            events.append(.failed(back.reason))
        }
    }

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty }
    var isUploading: Bool { attachments.contains { $0.path == nil } }
    /// Whenever there's something to send: what's still uploading goes with it once it's up.
    var canSend: Bool { !isEmpty }

    /// Stop replaces Send only for a working agent and an empty box, and not right after a send.
    func showsStop(working: Bool) -> Bool { !isShell && working && isEmpty && !justSent }

    func placeholder(working: Bool, queued: Int, touchOnly: Bool, agent: String? = nil, waiting: Bool = false, trusting: Bool = false, ended: Bool = false, settings: [String] = []) -> String {
        Self.placeholder(isShell: isShell, working: working, queued: queued, touchOnly: touchOnly, agent: agent, waiting: waiting, trusting: trusting, ended: ended, settings: settings)
    }

    /// What Send will do now (ah's Composer): message the agent, add to its queue, answer it, or
    /// resume it. Keys are named only when there's a keyboard.
    /// `settings`: what's in force (the model, the effort), said after whom it messages. What
    /// a message goes out with is visible before it's sent, with nothing added to the box;
    /// the hints drop from the end as the box narrows.
    nonisolated static func placeholder(isShell: Bool, working: Bool, queued: Int, touchOnly: Bool, agent: String? = nil, waiting: Bool = false, trusting: Bool = false, ended: Bool = false, settings: [String] = []) -> String {
        if isShell { return "Type or paste a command" }
        if ended { return "Message to resume" }
        // A screen in front of the prompt (trust, a sign-in), a picker or a question dialog isn't
        // answered in words: the message waits for it.
        if trusting { return "Message \(agent ?? "the agent") · sent once you answer" }
        if waiting { return "Reply to answer" }
        if working && queued > 0 { return touchOnly ? "Add to the queue · sent when it’s free" : "Add to the queue · ↵ on empty steers the next · ⌘↵ sends now · esc stops" }
        if working { return touchOnly ? "Add to the queue · sent when it’s free" : "Add to the queue · sent when it’s free · ⌘↵ sends now · esc stops" }
        // A finger finds / and @ among the settings a swipe up brings out; the box says only
        // whom it messages.
        let inForce = settings.filter { !$0.isEmpty }.map { " · " + $0 }.joined()
        return touchOnly ? "Message \(agent ?? "the agent")" + inForce : "Message \(agent ?? "the agent")" + inForce + " · / commands · @ files"
    }

    /// The longest run of a placeholder's " · " hints, from the start, that fits the width.
    nonisolated static func fitting(_ placeholder: String, width: Double, measure: (String) -> Double) -> String {
        var parts = placeholder.components(separatedBy: " · ")
        while parts.count > 1, measure(parts.joined(separator: " · ")) > width { parts.removeLast() }
        return parts.joined(separator: " · ")
    }

    /// A word for the person, shown the way the box's other notices are.
    func notify(_ message: String) { events.append(.notice(message)) }

    func takeEvents() -> [Event] {
        defer { events = [] }
        return events
    }

    // MARK: Open, foreground, background

    func open() async {
        // Both at once: the history ↑ walks needn't wait for the draft's round trip.
        let current = draftText
        let api = api
        let history = Task { try? await api.prompts() }
        if let pulled = await drafts.pull(current: current) { restore(pulled) }
        if let prompts = await history.value { recent = prompts.map(\.text) }
    }

    func foreground() async {
        if let pulled = await drafts.pull(current: draftText) { restore(pulled) }
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
        guard !isEmpty else { return false }
        let requeueBefore = requeueBefore
        self.requeueBefore = nil
        let words = typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : typed
        // Each file's path where its chip is; one without a chip in the words goes in front.
        func compose(_ paths: [Int: String]) -> String { Uploads.placing(sentFiles.compactMap { file in paths[file.id].map { (file.token, $0) } }, in: words) }
        // Sent now, whatever's still uploading: it waits for that (in the outbox, which
        // outlives this box), then goes. Each attachment in its place, as it was attached.
        let waits = sentFiles.filter { $0.path == nil }.compactMap { file in uploads[file.id].map { (file.id, $0) } }
        let tasks = Dictionary(waits, uniquingKeysWith: { first, _ in first })
        let message = compose(Dictionary(uniqueKeysWithValues: sentFiles.compactMap { file in file.path.map { (file.id, $0) } }))
        // The server decides; this only picks where it shows until the server says.
        let state: Outbox.Item.State = (working || outbox.isLanding(key: key)) && !isShell && !steer ? .queued : .sending
        let id = outbox.add(key: key, text: message, state: state, waitingOn: sentFiles.filter { tasks[$0.id] != nil }.compactMap(\.upload))
        recent = [message] + recent.filter { $0 != message }
        cursor = -1
        text = ""
        attachments = []
        justSent = true
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            self?.justSent = false
        }
        // The host's draft is cleared now, not after the sends before this one: what's typed
        // meanwhile (a resume can take seconds) was saved and then wiped by that late clear.
        Task { [drafts] in await drafts.saveNow("") }
        let previous = chain
        chain = Task { [weak self, api, uid, outbox, key] in
            // Finished with the app put away, too.
            let release = outbox.keepAlive?(id)
            defer { release?() }
            await previous?.value
            var asked = false
            do {
                var message = message
                if !tasks.isEmpty {
                    var paths: [Int: String] = [:]
                    for file in sentFiles {
                        if let path = file.path { paths[file.id] = path } else if let task = tasks[file.id] { paths[file.id] = try await task.value }
                    }
                    message = compose(paths)
                    outbox.ready(id, text: message)
                }
                asked = true
                let result = try await api.send(uid, text: message)
                if steer, result.outcome == .queued, let queued = result.queueId {
                    // Queued behind the turn: send it now instead. If that fails it's still
                    // queued (the host keeps it), so it stays in the queue rather than coming
                    // back to the box, where sending it again sent it twice.
                    do {
                        let now = try await api.sendNow(uid, item: queued)
                        self?.outbox.update(id, state: .sent, confirmedAt: Date().timeIntervalSince1970)
                        self?.events.append(.sent(now))
                    } catch {
                        self?.outbox.update(id, state: .queued, confirmedAt: Date().timeIntervalSince1970)
                        self?.events.append(.failed("Queued; couldn’t send it now: \(APIError.wrap(error).message)"))
                    }
                    return
                }
                // Held only for a just-started agent: sent, as your message in the conversation,
                // not a row in the queue (it goes in as soon as the agent is up).
                let held = result.outcome == .queued && result.starting == true
                self?.outbox.update(id, state: result.outcome == .queued && !held ? .queued : .sent, confirmedAt: Date().timeIntervalSince1970, heldAs: held ? result.queueId : nil)
                self?.events.append(.sent(result))
                // Edited out of the queue and queued again: back in its place.
                if let requeueBefore, result.outcome == .queued, !held, let queued = result.queueId {
                    self?.events.append(.requeue(queued, before: requeueBefore))
                }
            } catch {
                // No answer isn't no: the connection can drop after the host has typed it in (a
                // handover from Wi-Fi to cellular), and the text back in the box was sent twice
                // when you sent it again. As the host has it: a row in its queue, or your turn in the
                // conversation (shown as sent while also queued, it was there twice).
                if asked, case .transport = APIError.wrap(error), let item = outbox.items.first(where: { $0.id == id }),
                   let state = await Self.landed(item.text, since: item.at, api: api, uid: uid) {
                    outbox.update(id, state: state, confirmedAt: Date().timeIntervalSince1970)
                    return
                }
                outbox.remove([id])
                let reason = "Couldn’t send: \(APIError.wrap(error).message)"
                // The box it came from is gone (you'd left the session): back into the next
                // one, when you come back to it, rather than lost.
                guard let self else {
                    outbox.returnToBox(key: key, text: typed, reason: reason)
                    return
                }
                // Back into the box, unless something new was typed or attached meanwhile
                // (what never got up isn't: it would wait there for an upload that's over).
                if self.text.isEmpty { self.text = typed }
                if self.attachments.isEmpty { self.attachments = sentFiles.compactMap { file in file.path != nil ? file : nil } }
                self.events.append(.failed(reason))
            }
        }
        return true
    }

    /// Where the host has `text`, sent at `since`: `.queued` in its queue, `.sent` a turn of yours
    /// in its transcript; nil when it has neither. Asked a few times, as a turn takes a moment
    /// to be written.
    static func landed(_ text: String, since: Double, api: APIClient, uid: String, tries: Int = 3, apart: Duration = .seconds(2)) async -> Outbox.Item.State? {
        for attempt in 0..<tries {
            if attempt > 0 { try? await Task.sleep(for: apart) }
            if let queued = try? await api.queue(uid), queued.contains(where: { $0.at >= since - 10 && Outbox.sameText($0.text, text) }) { return .queued }
            if let page = try? await api.feedPage(uid, before: nil, limit: 20) {
                let turns = FeedProjection.project(page.entries).filter { if case .user = $0 { return true } else { return false } }
                if turns.contains(where: { ($0.at == 0 || $0.at / 1000 >= since - 10) && Outbox.sameText($0.text, text) }) { return .sent }
            }
        }
        return nil
    }

    /// Waits for every send so far (tests, and before leaving a session).
    func settle() async { await chain?.value }

    /// When you last stopped a turn from here: the turn that ends because of it isn't news.
    private(set) var interruptedAt: Date?
    var stoppedLately: Bool { interruptedAt.map { Date().timeIntervalSince($0) < 15 } ?? false }

    func stop() async {
        do {
            try await api.interrupt(uid)
            interruptedAt = Date()
            events.append(.interrupted)
        } catch {
            events.append(.failed("Couldn’t interrupt: \(APIError.wrap(error).message)"))
        }
    }

    /// ↑ in an empty box (or while recalling) walks back through recent prompts.
    func recall(_ step: Int) {
        guard !recent.isEmpty else { return }
        if cursor < 0 { beforeRecall = text }
        cursor = max(-1, min(recent.count - 1, cursor + step))
        // Back past the newest: what was in the box before, not an empty one.
        text = cursor < 0 ? beforeRecall : recent[cursor]
    }

    /// Typed into: a recalled message edited is a draft of its own, and ↑ moves the caret
    /// again rather than swapping it for an older one.
    func edited() {
        if cursor >= 0 && text != recent[cursor] { cursor = -1 }
    }

    var isRecalling: Bool { cursor >= 0 }

    /// A message coming back (Edit on a queued one): its uploads as tiles again, and as chips
    /// where they were in the words.
    func compose(_ message: String) {
        let (uploads, rest) = Uploads.place(message, taken: Set(attachments.compactMap(\.token)))
        text = rest
        for placed in uploads {
            nextAttachment += 1
            attachments.append(Attachment(id: nextAttachment, name: placed.upload.name, image: placed.upload.image, path: placed.upload.path, token: placed.token))
        }
    }

    /// Inserts a quoted excerpt or reused user prompt into the composer without mutating sent
    /// history or silently replacing an existing non-empty draft.
    func insertReuse(_ payload: String) {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            compose(trimmed)
        } else {
            let separator = text.hasSuffix("\n\n") ? "" : text.hasSuffix("\n") ? "\n" : "\n\n"
            text += separator + trimmed
            caret = text.utf16.count
            placeCaret = caret
        }
    }

    /// A text's files already on the host (a note's, `NoteText.shown`): each a tile, its token
    /// where it is in the words. Those still uploading stay; one shown already keeps its tile.
    func show(uploads placed: [Uploads.Placed]) {
        let shown = placed.map { p in
            if let same = attachments.first(where: { $0.path == p.upload.path && $0.token == p.token }) { return same }
            nextAttachment += 1
            return Attachment(id: nextAttachment, name: p.upload.name, image: p.upload.image, path: p.upload.path, token: p.token)
        }
        let next = shown + attachments.filter { $0.path == nil }
        if next != attachments { attachments = next }
    }

    /// A file just attached: its token, put in the text at the caret, as a chip there.
    private func placeToken(_ id: Int) {
        guard !isShell, let i = attachments.firstIndex(where: { $0.id == id }) else { return }
        var taken = Set(attachments.compactMap(\.token))
        let token = Uploads.token(attachments[i].name, taken: &taken)
        attachments[i].token = token
        let utf16 = Array(text.utf16)
        let at = min(max(0, caret), utf16.count)
        let head = String(decoding: utf16[..<at], as: UTF16.self)
        let tail = String(decoding: utf16[at...], as: UTF16.self)
        let before = head.isEmpty || head.last?.isWhitespace == true ? "" : " "
        let after = tail.first == " " ? "" : " "
        text = head + before + "@\(token)" + after + tail
        // Past the space after it (put in or already there): a caret on its end is still typing it.
        caret = at + before.utf16.count + 1 + token.utf16.count + 1
        placeCaret = caret
    }

    /// A block of its own at the end (a terminal's text), after a blank line, the caret after it
    /// to say what it's about.
    func addBlock(_ block: String) {
        var head = text
        while let last = head.last, last.isWhitespace { head.removeLast() }
        text = head.isEmpty ? block + "\n" : head + "\n\n" + block + "\n"
        caret = text.utf16.count
        placeCaret = caret
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
        placeCaret = caret
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
        // The tile shows (and holds Send) at once; its picture follows.
        attachments.append(Attachment(id: id, name: name, image: image, path: nil))
        placeToken(id)
        await upload(id, name: name, data: data, thumbnail: thumbnail)
    }

    /// A photo still coming from the library (from iCloud, that takes a while): its tile shows
    /// at once, so Send waits for it, rather than the message going without it and the photo
    /// turning up after in an empty box.
    func attach(name: String, image: Bool, load: @escaping @Sendable () async throws -> Data) async {
        guard !isShell else {
            if let data = try? await load() { await attach(name: name, data: data, image: image) }
            return
        }
        nextAttachment += 1
        let id = nextAttachment
        attachments.append(Attachment(id: id, name: name, image: image, path: nil))
        placeToken(id)
        begin(id, name: name) { [weak self, api] progress in
            let data = try await load()
            if image { await self?.setThumbnail(Self.tile(data), id) }
            return try await api.upload(name: name, data: data, progress: progress)
        }
        _ = try? await uploads[id]?.value
    }

    private func upload(_ id: Int, name: String, data: Data, thumbnail: Data?) async {
        guard attachments.contains(where: { $0.id == id }) else { return }
        begin(id, name: name) { [weak self, api] progress in
            if let thumbnail { await self?.setThumbnail(Self.tile(thumbnail), id) }
            return try await api.upload(name: name, data: data, progress: progress)
        }
        _ = try? await uploads[id]?.value
    }

    /// Starts an attachment's upload (`send` gets it to the host, telling `progress` how far):
    /// its progress kept in the outbox, its path put on the tile when it's up. Kept running
    /// when the message goes before it's done, and when the box is left.
    private func begin(_ id: Int, name: String, _ send: @escaping @Sendable (@escaping @Sendable (Double) -> Void) async throws -> String) {
        let upload = outbox.beginUpload()
        if let i = attachments.firstIndex(where: { $0.id == id }) { attachments[i].upload = upload }
        let outbox = outbox
        let release = outbox.keepUploading?("Attaching \(name)")
        uploads[id] = Task { [weak self] in
            defer {
                outbox.endUpload(upload)
                self?.uploads[id] = nil
                release?()
            }
            do {
                let path = try await send { fraction in Task { @MainActor in outbox.progressed(upload, fraction) } }
                if let self, let i = self.attachments.firstIndex(where: { $0.id == id }) {
                    if self.isShell {
                        self.attachments.remove(at: i)
                        self.text += (self.text.isEmpty || self.text.hasSuffix(" ") ? "" : " ") + Uploads.shellQuote(path) + " "
                    } else {
                        self.attachments[i].path = path
                    }
                }
                return path
            } catch {
                if !Task.isCancelled, let self, self.attachments.contains(where: { $0.id == id }) {
                    self.attachments.removeAll { $0.id == id }
                    self.events.append(.failed("Couldn’t attach \(name): \(APIError.wrap(error).message)"))
                }
                throw error
            }
        }
    }

    /// A video: its tile shows at once, `load` brings the file to this device (from iCloud, that
    /// can take minutes), then it uploads from disk and the file goes. Removing the tile stops it.
    func attachVideo(name: String, load: @escaping @Sendable () async throws -> (file: URL, thumbnail: Data?)) {
        nextAttachment += 1
        let id = nextAttachment
        // A shell's tile too while it comes (it's typed in as a path once it's up).
        attachments.append(Attachment(id: id, name: name, image: false, path: nil))
        placeToken(id)
        begin(id, name: name) { [weak self, api] progress in
            let loaded = try await load()
            defer { try? FileManager.default.removeItem(at: loaded.file) }
            await self?.setThumbnail(loaded.thumbnail, id)
            return try await api.upload(name: name, file: loaded.file, progress: progress)
        }
    }

    /// A tile's picture: the photo made small once, off the main thread. The tiles are drawn
    /// again on every keystroke, and each time a 12-megapixel original was decoded for a
    /// 64-point square. Anything ImageIO can't read is kept as it came.
    nonisolated static func tile(_ data: Data) async -> Data {
        #if canImport(ImageIO)
        await Task.detached(priority: .userInitiated) {
            let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 256] as CFDictionary
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return data }
            let out = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return data }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
            return CGImageDestinationFinalize(destination) ? out as Data : data
        }.value
        #else
        data
        #endif
    }

    private func setThumbnail(_ thumbnail: Data?, _ id: Int) {
        if let i = attachments.firstIndex(where: { $0.id == id }) { attachments[i].thumbnail = thumbnail }
    }

    /// Taken off before it's sent: its upload stops.
    func removeAttachment(_ id: Int) {
        uploads[id]?.cancel()
        // Its chip goes with it.
        if let chip = attachmentChips.first(where: { $0.attachment.id == id }) {
            let removed = Mentions.removing(chip.mention, from: text)
            text = removed.text
            caret = removed.caret
            placeCaret = removed.caret
        }
        attachments.removeAll { $0.id == id }
        if text.isEmpty, attachments.isEmpty { requeueBefore = nil }
    }

    /// What was attached in another box: New session's, before this session existed. Its
    /// tiles move into this box, with the uploads still under way (not started again), so the
    /// first message goes with them once they're up; each keeps its name, so its path goes
    /// where its chip is in the words that come with it. The other box is left empty.
    func adopt(attachmentsOf other: ComposerModel) {
        for file in other.attachments {
            nextAttachment += 1
            let id = nextAttachment
            attachments.append(Attachment(id: id, name: file.name, image: file.image, path: file.path, thumbnail: file.thumbnail, upload: file.upload, token: file.token))
            guard file.path == nil, let running = other.uploads[file.id] else { continue }
            uploads[id] = Task { [weak self] in
                defer { self?.uploads[id] = nil }
                do {
                    let path = try await running.value
                    if let self, let i = self.attachments.firstIndex(where: { $0.id == id }) { self.attachments[i].path = path }
                    return path
                } catch {
                    if !Task.isCancelled, let self, self.attachments.contains(where: { $0.id == id }) {
                        self.attachments.removeAll { $0.id == id }
                        self.events.append(.failed("Couldn’t attach \(file.name): \(APIError.wrap(error).message)"))
                    }
                    throw error
                }
            }
        }
        other.attachments = []
        other.uploads = [:]
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
            // Only when there were some: every keystroke came here, and each write told every
            // view reading the suggestions (the transcript among them) to draw again.
            if !suggestions.isEmpty { suggestions = [] }
            return
        }
        suggestTask = Task { [weak self, api, uid] in
            guard let self else { return }
            switch trigger.kind {
            case .slash:
                // No session, no commands (a note's box).
                guard !uid.isEmpty else {
                    self.suggestions = []
                    return
                }
                // Kept only once fetched: a fetch cut short by the next keystroke (or failed)
                // was kept as no commands at all, for the rest of the session.
                if self.commands == nil, let fetched = try? await api.commands(uid) { self.commands = fetched }
                guard !Task.isCancelled else { return }
                self.suggestions = CompletionTrigger.rank(self.commands ?? [], query: trigger.query)
            case .file:
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
                let files: [String]
                if uid.isEmpty {
                    // A box with no session (a note's): the files in its folder, if it has one.
                    guard let folder = self.filesFolder?() else {
                        self.suggestions = []
                        return
                    }
                    let found = (try? await api.folderFiles(folder.dir, query: trigger.query)) ?? []
                    let dir = folder.dir.hasSuffix("/") ? String(folder.dir.dropLast()) : folder.dir
                    files = folder.absolute ? found.map { "\(dir)/\($0)" } : found
                } else {
                    files = (try? await api.files(uid, query: trigger.query)) ?? []
                }
                guard !Task.isCancelled else { return }
                self.suggestions = CompletionTrigger.files(files)
            case .session:
                let rows = self.sessionsProvider?() ?? []
                let space = self.currentSpace?()
                self.suggestions = CompletionTrigger.sessions(rows, query: trigger.query, currentUid: uid, currentSpace: space)
            }
        }
    }

    /// Live sessions on this host for `#` session autocomplete.
    @ObservationIgnored var sessionsProvider: (@MainActor () -> [SessionRow])?
    /// Current session's Space name, used to prioritize same-Space sessions in `#` autocomplete.
    @ObservationIgnored var currentSpace: (@MainActor () -> String?)?

    /// Where the box's @mentions are looked up; none for a box with no session (New session's).
    @ObservationIgnored var mentionLookup: MentionLookup?
    /// Where a box with no session finds files for its @ completion (a note's Space, or home):
    /// a whole path for each when `absolute`. Nil: no @ completion.
    @ObservationIgnored var filesFolder: (@MainActor () -> (dir: String, absolute: Bool)?)?

    /// The @mentions in the text that name a file there: chips in the box. Not the one the @
    /// completion is still on (it isn't finished), nor a shell's (its @ is the shell's).
    var fileMentions: [Mention] {
        guard !isShell, let lookup = mentionLookup, let cwd = lookup.cwd() else { return [] }
        let typing = CompletionTrigger.at(text, caret: caret).flatMap { $0.kind == .file ? $0.start : nil }
        return lookup.files.found(in: text, cwd: cwd, skipping: typing)
    }

    /// Each attachment's chip where it was put: the first "@token" of each in the text.
    var attachmentChips: [(mention: Mention, attachment: Attachment)] {
        let byToken = Dictionary(attachments.compactMap { a in a.token.map { ($0, a) } }, uniquingKeysWith: { a, _ in a })
        guard !byToken.isEmpty else { return [] }
        let typing = CompletionTrigger.at(text, caret: caret).flatMap { $0.kind == .file ? $0.start : nil }
        var seen = Set<String>()
        return Mentions.find(text).compactMap { m in
            guard m.range.location != typing, let a = byToken[m.path], seen.insert(m.path).inserted else { return nil }
            return (m, a)
        }
    }

    /// Every chip in the box, in the order they're in the text: files it names and what's
    /// attached (an attachment's name wins over a file's).
    var chips: [Mention] {
        let attached = attachmentChips
        let tokens = Set(attached.map(\.mention.path))
        return (fileMentions.filter { !tokens.contains($0.path) } + attached.map(\.mention)).sorted { $0.range.location < $1.range.location }
    }

    /// The attachment a chip is, if it's one.
    func attachment(for chip: Mention) -> Attachment? { attachmentChips.first { $0.mention == chip }?.attachment }

    /// A chip's ×: an attachment goes with its tile; a file's mention goes from the text.
    func removeChip(_ chip: Mention) {
        if let attachment = attachment(for: chip) { removeAttachment(attachment.id) } else { removeMention(chip) }
    }

    /// A chip dragged to another place in the text (`to`: a UTF-16 offset).
    func moveChip(_ chip: Mention, to: Int) {
        let moved = Mentions.moving(chip, in: text, to: to, others: chips.filter { $0 != chip })
        guard moved.text != text else { return }
        text = moved.text
        caret = moved.caret
        placeCaret = moved.caret
    }

    /// A chip's ×: the mention and a space go, the caret where it was.
    func removeMention(_ mention: Mention) {
        let removed = Mentions.removing(mention, from: text)
        text = removed.text
        caret = removed.caret
        placeCaret = removed.caret
    }

    func accept(_ item: CompletionTrigger.Item) {
        guard let trigger else { return }
        let applied = trigger.applying(item, to: text)
        text = applied.text
        caret = applied.caret
        placeCaret = caret
        suggestions = []
    }
}
