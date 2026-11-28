import Foundation
import Observation

/// Working changes beside a session (`apps/server/web/Git.tsx`), polled while shown, with a
/// line-anchored comment that goes to the agent as an ordinary message.
@MainActor
@Observable
final class DiffModel {
    let api: APIClient
    let uid: String
    private(set) var changes: Changes?
    private(set) var files: [FileDiff] = []
    private(set) var error: String?
    private(set) var branches: BranchList?
    private(set) var pull: PullInfo?
    @ObservationIgnored private var poll: Task<Void, Never>?

    init(api: APIClient, uid: String) {
        self.api = api
        self.uid = uid
    }

    var untracked: [Changes.File] { changes?.files.filter { $0.code == "??" || $0.code == "?" } ?? [] }
    var totals: (add: Int, del: Int) { files.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) } }

    func load() async {
        do {
            let c = try await settled { [api, uid] in try await api.changes(uid) }
            changes = c
            files = FileDiff.files(in: c.patch)
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    func watch() {
        guard poll == nil else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.load()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func stop() {
        poll?.cancel()
        poll = nil
    }

    /// "Comment on src/a.ts:12 (removed line):\n> code\n\nyour words" (`Git.tsx submit`).
    nonisolated static func comment(file: String, line: DiffLine, text: String) -> String {
        let where_ = line.number.map { "\(file):\($0)" } ?? file
        let removed = line.kind == .del ? " (removed line)" : ""
        return "Comment on \(where_)\(removed):\n> \(line.text.trimmingCharacters(in: .whitespaces))\n\n\(text.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    func send(comment: String, file: String, line: DiffLine) async -> SendResult? {
        guard !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        do {
            return try await api.send(uid, text: Self.comment(file: file, line: line, text: comment))
        } catch {
            self.error = "Couldn’t send the comment: \(APIError.wrap(error).message)"
            return nil
        }
    }

    func loadBranches() async {
        do {
            async let b = api.branches(uid)
            async let p = api.pull(uid)
            branches = try await b
            pull = try? await p
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// The branch being switched to, while it happens.
    private(set) var switching: String?

    /// Switch to a branch, or create it when it doesn't exist.
    func switchBranch(_ name: String) async -> Bool {
        guard switching == nil else { return false }
        switching = name
        defer { switching = nil }
        do {
            _ = try await api.switchBranch(uid, branch: name.trimmingCharacters(in: .whitespaces))
            await loadBranches()
            return true
        } catch {
            self.error = APIError.wrap(error).message
            return false
        }
    }
}

/// The host's files under its configured roots (`apps/server/web/Files.tsx`): browse, preview,
/// download, upload into a folder, make folders, and put a path into the conversation.
@MainActor
@Observable
final class FilesModel {
    let api: APIClient
    private(set) var listing: FsListing?
    private(set) var error: String?
    var showHidden = false
    private(set) var uploading: [String] = []

    init(api: APIClient) { self.api = api }

    func open(_ path: String?) async {
        do {
            listing = try await api.list(path: path, hidden: showHidden)
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func reload() async { await open(listing?.path) }

    func up() async {
        guard let parent = listing?.parent else { return }
        await open(parent)
    }

    func child(_ entry: FsEntry) -> String {
        guard let base = listing?.path else { return entry.name }
        return base.hasSuffix("/") ? base + entry.name : base + "/" + entry.name
    }

    func data(_ path: String) async -> Data? {
        do { return try await api.file(path) } catch {
            self.error = APIError.wrap(error).message
            return nil
        }
    }

    func upload(name: String, data: Data) async {
        guard let dir = listing?.path else { return }
        uploading.append(name)
        defer { uploading.removeAll { $0 == name } }
        do {
            _ = try await api.uploadFile(into: dir, name: name, data: data)
            await reload()
        } catch {
            self.error = "Couldn’t upload \(name): \(APIError.wrap(error).message)"
        }
    }

    func makeFolder(_ name: String) async {
        guard let dir = listing?.path, !name.isEmpty else { return }
        do {
            _ = try await api.mkdir(dir.hasSuffix("/") ? dir + name : dir + "/" + name)
            await reload()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// How a path goes into a prompt: an @-mention for agents, shell-quoted for a shell,
    /// relative to the session's folder when it's inside it (`apps/server/web/Files.tsx`).
    nonisolated static func mention(_ path: String, shell: Bool, cwd: String? = nil) -> String {
        let shown = cwd.map { relative(path, to: $0) } ?? path
        return (shell ? Uploads.shellQuote(shown) : "@\(shown)") + " "
    }

    /// `path` from `cwd`: "." for the folder itself, the rest of the path inside it, or the
    /// path unchanged outside it.
    nonisolated static func relative(_ path: String, to cwd: String) -> String {
        let base = cwd.hasSuffix("/") && cwd.count > 1 ? String(cwd.dropLast()) : cwd
        if path == base { return "." }
        return path.hasPrefix(base + "/") ? String(path.dropFirst(base.count + 1)) : path
    }

    /// The folders from the root down to `path`, for a breadcrumb bar.
    nonisolated static func crumbs(_ path: String) -> [(name: String, path: String)] {
        var out: [(String, String)] = [("/", "/")]
        var walked = ""
        for part in path.split(separator: "/") {
            walked += "/" + part
            out.append((String(part), walked))
        }
        return out
    }

    /// What a file is, by its name: how it's drawn and how it previews.
    enum Kind: Equatable, Sendable {
        case folder, image, pdf, code, text, archive, media, other

        nonisolated init(_ entry: FsEntry) {
            guard entry.type != .dir else { self = .folder; return }
            self.init(file: entry.name)
        }

        /// A file's, by its name alone (an attachment's).
        nonisolated init(file: String) {
            let name = file.lowercased()
            let ext = name.split(separator: ".").count > 1 ? String(name.split(separator: ".").last!) : ""
            switch ext {
            case "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "svg", "ico", "bmp", "tif", "tiff": self = .image
            case "pdf": self = .pdf
            case "swift", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "c", "h", "cc", "cpp", "hpp", "m", "mm",
                 "java", "kt", "kts", "cs", "php", "sh", "bash", "zsh", "fish", "lua", "sql", "html", "htm", "css", "scss", "vue",
                 "svelte", "json", "jsonl", "yaml", "yml", "toml", "xml", "ini", "conf", "gradle", "dockerfile", "zig", "ex", "exs", "hs":
                self = .code
            case "md", "markdown", "txt", "log", "csv", "tsv", "rst", "env", "lock", "gitignore", "diff", "patch": self = .text
            case "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "deb", "rpm": self = .archive
            case "mp3", "m4a", "wav", "aac", "flac", "mp4", "mov", "m4v", "webm", "mkv": self = .media
            default:
                let plain = ["makefile", "dockerfile", "license", "readme", "procfile", "gemfile", "podfile", ".gitignore", ".env"]
                self = plain.contains(name) || name.hasPrefix(".") ? .text : .other
            }
        }

        var symbol: String {
            switch self {
            case .folder: return "folder.fill"
            case .image: return "photo"
            case .pdf: return "doc.richtext"
            case .code: return "chevron.left.forwardslash.chevron.right"
            case .text: return "doc.text"
            case .archive: return "archivebox"
            case .media: return "play.rectangle"
            case .other: return "doc"
            }
        }

        /// Shown as text in the app (Quick Look takes `.ts` for a video, for one).
        var readsAsText: Bool { self == .code || self == .text }
    }

    /// Text to show for a file's bytes, or nil when they aren't text: UTF-8 without NULs.
    nonisolated static func text(_ data: Data) -> String? {
        guard !data.prefix(8192).contains(0) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Larger files open in Quick Look or download instead.
    nonisolated static let previewLimit = 1024 * 1024
}

/// Full-text search over transcripts and side chats, on every host (`apps/server/web/SearchView.tsx`).
@MainActor
@Observable
final class SearchModel {
    let api: APIClient
    var query = SearchQuery(q: "")
    var allHosts = true
    /// Search's status chip: the lists keep the sessions in any of these (none: every one).
    var statuses: Set<SessionStatusFilter> = []
    private(set) var response: SearchResponse?
    private(set) var status: SearchStatus?
    private(set) var searching = false
    private(set) var error: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Bumped by each new search: a page asked for under an older one is dropped.
    @ObservationIgnored private var generation = 0
    /// A next page on its way (More Results shows it).
    private(set) var loadingMore = false

    init(api: APIClient) { self.api = api }

    /// Runs after typing pauses; a newer query cancels an older one.
    func search(debounce: Duration = .milliseconds(250)) {
        task?.cancel()
        generation += 1
        let q = query
        guard !q.q.trimmingCharacters(in: .whitespaces).isEmpty else {
            response = nil
            error = nil
            return
        }
        task = Task { [weak self, api, allHosts] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            self?.searching = true
            defer { self?.searching = false }
            do {
                var request = q
                request.limit = request.limit ?? 20
                let result = try await api.search(request, allHosts: allHosts)
                guard !Task.isCancelled else { return }
                self?.response = result
                self?.error = nil
            } catch {
                guard !Task.isCancelled else { return }
                self?.error = APIError.wrap(error).message
            }
        }
    }

    /// The next page, once at a time, and only onto the results it follows: a query changed
    /// meanwhile got the old one's results back, and two taps added the same page twice.
    func more() async {
        guard !loadingMore, let current = response, current.results.count < current.total else { return }
        loadingMore = true
        defer { loadingMore = false }
        let asked = generation
        var request = query
        request.offset = current.results.count
        request.limit = 20
        do {
            let page = try await api.search(request, allHosts: allHosts)
            guard asked == generation, response == current else { return }
            response = SearchResponse(enabled: page.enabled, building: page.building, results: current.results + page.results, total: page.total, tookMs: page.tookMs, notes: page.notes)
        } catch {
            guard asked == generation else { return }
            self.error = APIError.wrap(error).message
        }
    }

    func loadStatus() async { status = try? await api.searchStatus() }
}

/// Where a session stands, for Search's status chip: running ones as the Inbox sorts them
/// (needs you, working, idle and done), past ones cut off (to restore) or ended.
enum SessionStatusFilter: String, CaseIterable, Hashable, Sendable {
    case needsYou, working, idle, interrupted, ended

    var label: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "Working"
        case .idle: "Idle"
        case .interrupted: "Interrupted"
        case .ended: "Ended"
        }
    }

    static func of(_ row: SessionRow) -> Self {
        switch row.dto.status {
        case .waiting: .needsYou
        case .busy: .working
        case .idle, .attention: .idle
        }
    }

    static func of(_ row: HistoryRow) -> Self { row.dto.interrupted == nil ? .ended : .interrupted }

    /// The chip's words: what's picked, or how many.
    static func label(_ picked: Set<Self>) -> String {
        let named = allCases.filter(picked.contains)
        if named.isEmpty { return "Any status" }
        return named.count <= 2 ? named.map(\.label).joined(separator: ", ") : "\(named.count) statuses"
    }
}

/// What Search lists before a word is typed and narrows as one is (`web/SearchView.tsx`):
/// every live session and every past conversation (History lives here now). Each word typed
/// has to be somewhere in a row's title, project, agent, folder, host or model; Search's host
/// and since-when chips narrow the lists as they narrow what the index finds, and its status
/// chip narrows the lists alone.
enum HistoryFilter {
    private static func words(_ query: String) -> [String] {
        query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    }

    private static func matches(_ fields: [String], _ query: String) -> Bool {
        let hay = fields.joined(separator: " ").lowercased()
        return words(query).allSatisfy { hay.contains($0) }
    }

    static func matches(_ row: HistoryRow, _ query: String) -> Bool {
        matches([row.dto.title, row.dto.project, row.dto.harness, row.dto.cwd, row.host, row.dto.model ?? ""], query)
    }

    static func matches(_ row: SessionRow, _ query: String) -> Bool {
        matches([row.title, row.dto.project, row.dto.agent ?? "shell", row.dto.cwd, row.host, row.dto.model ?? "", row.dto.branch ?? ""], query)
    }

    /// Live sessions for Search: the latest active first (pins on top), as the query narrows them.
    static func live(_ rows: [SessionRow], _ query: SearchQuery, statuses: Set<SessionStatusFilter> = []) -> [SessionRow] {
        SessionOrdering.byRecency(rows.filter { row in
            (statuses.isEmpty || statuses.contains(.of(row))) && matches(row, query.q) && (query.host == nil || row.host == query.host) && (query.from.map { max(row.lastActive, row.dto.createdAt) * 1000 >= $0 } ?? true)
        })
    }

    /// Past conversations for Search, in the host's order (pinned, then newest), as the query narrows them.
    static func past(_ rows: [HistoryRow], _ query: SearchQuery, statuses: Set<SessionStatusFilter> = []) -> [HistoryRow] {
        rows.filter { row in
            (statuses.isEmpty || statuses.contains(.of(row))) && matches(row, query.q) && (query.host == nil || row.host == query.host) && (query.from.map { row.dto.at * 1000 >= $0 } ?? true)
        }
    }

    /// Grouped by day for the list ("Today", "Yesterday", a date), newest day first as the
    /// rows come. One formatter for the lot: a new one per row made filtering History slow.
    static func byDay(_ rows: [HistoryRow], now: Date = Date(), calendar: Calendar = .current) -> [(day: String, rows: [HistoryRow])] {
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now)
        var formatters: [String: DateFormatter] = [:]
        func label(_ seconds: Double) -> String {
            let date = Date(timeIntervalSince1970: seconds)
            if calendar.isDate(date, inSameDayAs: now) { return "Today" }
            if let yesterday, calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
            let template = calendar.isDate(date, equalTo: now, toGranularity: .year) ? "EEEEdMMMM" : "dMMMMyyyy"
            let formatter = formatters[template] ?? {
                let formatter = DateFormatter()
                formatter.calendar = calendar
                formatter.setLocalizedDateFormatFromTemplate(template)
                formatters[template] = formatter
                return formatter
            }()
            return formatter.string(from: date)
        }
        var days: [(day: String, rows: [HistoryRow])] = []
        var index: [String: Int] = [:]
        for row in rows {
            let day = label(row.dto.at)
            if let i = index[day] { days[i].rows.append(row) } else {
                index[day] = days.count
                days.append((day, [row]))
            }
        }
        return days
    }
}

/// A session's side chat with another model, outside the agent's context (`web/SideChat.tsx`).
@MainActor
@Observable
final class SideChatModel {
    let api: APIClient
    let uid: String
    private(set) var messages: [ChatMessage] = []
    private(set) var subscriptionId: String?
    private(set) var subscriptions: [Subscription] = []
    private(set) var followups: [Followup] = []
    private(set) var sending = false
    private(set) var error: String?
    /// The thread and the models came back: until then nothing is "none" (no chat model, no
    /// messages), only on its way.
    private(set) var loaded = false

    init(api: APIClient, uid: String) {
        self.api = api
        self.uid = uid
    }

    func load() async {
        do {
            async let thread = api.chat(uid)
            async let subs = api.subscriptions()
            let t = try await thread
            messages = t.messages
            subscriptionId = t.subscriptionId
            subscriptions = try await subs
            error = nil
            loaded = true
        } catch {
            self.error = APIError.shown(error)
        }
    }

    var activeSubscription: Subscription? {
        subscriptions.first { $0.id == subscriptionId } ?? subscriptions.first { $0.isDefault }
    }

    func pick(_ id: String) async {
        do {
            try await api.pickChatSubscription(uid, id: id)
            subscriptionId = id
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// False when it didn't go: the question is out of the chat again, for the field to keep.
    @discardableResult
    func send(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sending else { return false }
        sending = true
        defer { sending = false }
        messages.append(ChatMessage(role: .user, text: trimmed, at: Date().timeIntervalSince1970 * 1000, id: nil))
        do {
            let reply = try await api.sendChat(uid, text: trimmed, subscriptionId: subscriptionId)
            messages.append(reply.message)
            followups = reply.followups
            error = nil
            return true
        } catch {
            messages.removeLast()
            self.error = APIError.wrap(error).message
            return false
        }
    }

    func clear() async {
        do {
            try await api.clearChat(uid)
            messages = []
            followups = []
        } catch {
            self.error = APIError.wrap(error).message
        }
    }
}

/// Per-turn snapshots and restore (`web/Snapshots.tsx`): restoring takes a safety snapshot first.
@MainActor
@Observable
final class SnapshotsModel {
    let api: APIClient
    let uid: String
    private(set) var list: SnapshotList?
    private(set) var error: String?
    private(set) var restoring: Int?
    /// Said after a restore the agent couldn't be told about.
    private(set) var notice: String?

    /// How a restore went: a working agent has to be stopped first, and the caller asks.
    enum Outcome: Equatable, Sendable {
        case restored(SnapshotRestore)
        case agentWorking
        case failed
    }

    init(api: APIClient, uid: String) {
        self.api = api
        self.uid = uid
    }

    func load() async {
        do {
            list = try await settled { [api, uid] in try await api.snapshots(uid) }
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    /// Keeps the list current while the panel shows: a new turn adds a row.
    func watch(every interval: Duration = .seconds(3)) async {
        while !Task.isCancelled {
            if restoring == nil { await load() }
            try? await Task.sleep(for: interval)
        }
    }

    func setEnabled(_ enabled: Bool) async {
        do {
            try await api.toggleSnapshots(uid, enabled: enabled)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// Restore the files to before `turn`; `interrupt` stops a working agent first.
    func restore(turn: Int, interrupt: Bool) async -> Outcome {
        restoring = turn
        defer { restoring = nil }
        do {
            let result = try await api.restoreSnapshot(uid, turn: turn, interrupt: interrupt)
            notice = result.notified ? nil : Self.unnotified
            await load()
            return .restored(result)
        } catch {
            let message = APIError.wrap(error).message
            if !interrupt, Self.isAgentWorking(message) { return .agentWorking }
            self.error = message
            return .failed
        }
    }

    func dismissNotice() { notice = nil }

    nonisolated static let unnotified = "Restored, but the agent couldn’t be told. Ask it to run git status and re-read the changed files before it goes on."

    nonisolated static func isAgentWorking(_ message: String) -> Bool {
        message.range(of: "agent is working", options: .caseInsensitive) != nil
    }

    /// Newest first, as a timeline reads.
    nonisolated static func timeline(_ list: SnapshotList) -> [SnapshotInfo] {
        list.snapshots.sorted { ($0.turn, $0.id) > ($1.turn, $1.id) }
    }

    /// The host keeps a prompt's first 120 characters: say when it was cut.
    nonisolated static func excerpt(_ snap: SnapshotInfo) -> String {
        snap.promptExcerpt.count >= 120 ? snap.promptExcerpt + "…" : snap.promptExcerpt
    }

    nonisolated static func title(_ snap: SnapshotInfo) -> String {
        snap.kind == "safety" ? "Safety copy" : "Before turn \(snap.turn)"
    }

    /// What changed between the snapshot before this one and this one.
    nonisolated static func stats(_ snap: SnapshotInfo, oldest: Bool = false) -> String {
        if snap.filesChanged == 0 { return oldest ? "The first one kept" : "No changes" }
        return "\(snap.filesChanged) file\(snap.filesChanged == 1 ? "" : "s") changed"
    }

    /// The snapshot taken before `prompt` was sent (the host keeps its first 120 characters,
    /// whitespace collapsed): the newest, if the same words went more than once.
    nonisolated static func match(prompt: String, in list: SnapshotList) -> SnapshotInfo? {
        let words = prompt.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let key = String(words.prefix(120))
        guard !key.isEmpty else { return nil }
        return timeline(list).first { $0.kind == "turn" && $0.promptExcerpt == key }
    }

    /// What a restore of `snap` would do, said before it's done.
    nonisolated static func confirmation(_ snap: SnapshotInfo, in list: SnapshotList) -> (title: String, message: String) {
        let later = list.snapshots.filter { $0.turn > snap.turn && $0.kind == "turn" }.count
        var parts: [String]
        if snap.kind == "safety" {
            parts = ["Files go back to how they were when this safety copy was taken."]
        } else {
            parts = ["Files go back to how they were before turn \(snap.turn)."]
        }
        if later > 0 { parts.append("Changes from \(later) later turn\(later == 1 ? "" : "s") are undone.") }
        parts.append("The current files are saved first, so you can come back.")
        if !snap.branch.isEmpty, let branch = list.branch, snap.branch != branch {
            parts.append("It was taken on \(snap.branch); you’re on \(branch) now.")
        }
        let title = snap.kind == "safety" ? "Restore this safety copy?" : "Restore to before turn \(snap.turn)?"
        return (title, parts.joined(separator: " "))
    }
}

/// A session's dev server, previewed through ah's own authenticated proxy (`web/Preview.tsx`).
@MainActor
@Observable
final class PreviewModel {
    let api: APIClient
    let uid: String
    private(set) var info: PreviewInfo?
    private(set) var error: String?

    init(api: APIClient, uid: String) {
        self.api = api
        self.uid = uid
    }

    func load() async {
        do {
            info = try await settled { [api, uid] in try await api.preview(uid) }
            error = nil
        } catch {
            self.error = APIError.shown(error)
        }
    }

    private(set) var busy = false

    func start(_ port: Int) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.startPreview(uid, target: port)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// Keeps the offered ports fresh while the panel is up: a dev server takes a moment to
    /// start listening (the web refreshes every 4 s too).
    func watch(every interval: Duration = .seconds(4)) async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: interval)
        }
    }

    /// A typed port, when it is one.
    nonisolated static func port(_ typed: String) -> Int? {
        guard let n = Int(typed.trimmingCharacters(in: .whitespaces)), (1...65535).contains(n) else { return nil }
        return n
    }

    func stop() async {
        do {
            try await api.stopPreview(uid)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// Where the web view loads the preview: the proxy's port on the same host name.
    /// Never the dev server's own port, and never anything but the host itself.
    nonisolated static func url(origin: URL, port: Int) -> URL? {
        guard var c = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        c.port = port
        c.path = "/"
        return c.url
    }

    /// The web view may navigate only within the preview's own origin.
    nonisolated static func allows(_ url: URL, preview: URL) -> Bool {
        url.scheme == preview.scheme && url.host == preview.host && (url.port ?? (url.scheme == "https" ? 443 : 80)) == (preview.port ?? (preview.scheme == "https" ? 443 : 80))
    }
}

/// Managed worktrees: dirty, ahead, in use, size; safe removal and bulk cleanup (`web/Git.tsx`).
@MainActor
@Observable
final class WorktreesModel {
    let api: APIClient
    private(set) var trees: [WorktreeInfo] = []
    private(set) var error: String?
    private(set) var results: [BulkRemoveResult] = []
    var selected: Set<String> = []
    /// The host has listed them once: before that, "No Worktrees" would be a guess.
    private(set) var loaded = false

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            trees = try await settled { [api] in try await api.worktrees() }
            error = nil
            loaded = true
        } catch {
            self.error = APIError.shown(error)
        }
    }

    /// In use by a running session: never removable here.
    nonisolated static func inUse(_ tree: WorktreeInfo) -> Bool { !tree.live.isEmpty }
    /// Uncommitted or unpushed work: removing needs an explicit force.
    nonisolated static func needsForce(_ tree: WorktreeInfo) -> Bool { tree.dirty > 0 || tree.ahead > 0 }

    func remove(_ tree: WorktreeInfo, force: Bool) async {
        do {
            try await api.removeWorktree(tree.path, force: force)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// The host re-checks every path; what it refused comes back per path.
    func removeSelected(forcing: Set<String>) async {
        let paths = Array(selected)
        guard !paths.isEmpty else { return }
        do {
            results = try await api.removeWorktrees(paths, force: paths.filter { forcing.contains($0) })
            selected = []
            cleaningUp = false
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    /// Refreshes while shown: sizes are measured in the background and arrive later, and
    /// sessions come and go (the web polls every 2 s too).
    func watch(every interval: Duration = .seconds(2)) async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: interval)
        }
    }

    /// Largest first instead of most recently active first.
    var bySize = false
    /// Choosing orphans to remove together.
    private(set) var cleaningUp = false

    /// Worktrees a running session works in, then the rest.
    var sections: (inUse: [WorktreeInfo], free: [WorktreeInfo]) {
        let sorted = Self.sorted(trees, bySize: bySize)
        return (sorted.filter(Self.inUse), sorted.filter { !Self.inUse($0) })
    }

    /// By size: measured ones largest first, unmeasured or partial ones last (their place
    /// is unknown); otherwise the most recently active first.
    nonisolated static func sorted(_ trees: [WorktreeInfo], bySize: Bool) -> [WorktreeInfo] {
        trees.sorted { a, b in
            if bySize {
                let ua = a.sizePartial || a.sizeBytes == nil, ub = b.sizePartial || b.sizeBytes == nil
                if ua != ub { return !ua }
                return (a.sizeBytes ?? -1) > (b.sizeBytes ?? -1)
            }
            return a.lastActivityAt > b.lastActivityAt
        }
    }

    var orphans: [WorktreeInfo] { trees.filter(\.orphan) }

    /// Clean orphans start checked; dirty ones are listed unchecked, so removing one is a
    /// deliberate choice (and forces only that one).
    func startCleanup() {
        selected = Self.cleanupSelection(trees)
        results = []
        cleaningUp = true
    }

    func endCleanup() {
        selected = []
        cleaningUp = false
    }

    func toggle(_ tree: WorktreeInfo) {
        if selected.contains(tree.path) { selected.remove(tree.path) } else { selected.insert(tree.path) }
    }

    nonisolated static func cleanupSelection(_ trees: [WorktreeInfo]) -> Set<String> {
        Set(trees.filter { $0.orphan && $0.dirty == 0 && $0.ahead == 0 }.map(\.path))
    }

    nonisolated static func bytes(_ trees: [WorktreeInfo], in paths: Set<String>) -> Double {
        trees.filter { paths.contains($0.path) }.reduce(0) { $0 + ($1.sizeBytes ?? 0) }
    }

    /// What removing the chosen ones frees.
    var selectedBytes: Double { Self.bytes(trees, in: selected) }
    var totalBytes: Double { trees.reduce(0) { $0 + ($1.sizeBytes ?? 0) } }

    nonisolated static func size(_ bytes: Double?) -> String {
        guard let bytes else { return "measuring…" }
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
