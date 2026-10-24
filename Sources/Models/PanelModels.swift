import Foundation
import Observation

/// Working changes beside a session (`../ah/web/Git.tsx`), polled while shown, with a
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
            let c = try await api.changes(uid)
            changes = c
            files = FileDiff.files(in: c.patch)
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
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

    /// Switch to a branch, or create it when it doesn't exist.
    func switchBranch(_ name: String) async -> Bool {
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

/// The host's files under its configured roots (`../ah/web/Files.tsx`): browse, preview,
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
    /// relative to the session's folder when it's inside it (`../ah/web/Files.tsx`).
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
            let name = entry.name.lowercased()
            let ext = name.split(separator: ".").count > 1 ? String(name.split(separator: ".").last!) : ""
            switch ext {
            case "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "svg", "ico", "bmp", "tiff": self = .image
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

/// Full-text search over transcripts and side chats, on every host (`../ah/web/SearchView.tsx`).
@MainActor
@Observable
final class SearchModel {
    let api: APIClient
    var query = SearchQuery(q: "")
    var allHosts = true
    private(set) var response: SearchResponse?
    private(set) var status: SearchStatus?
    private(set) var searching = false
    private(set) var error: String?
    @ObservationIgnored private var task: Task<Void, Never>?

    init(api: APIClient) { self.api = api }

    /// Runs after typing pauses; a newer query cancels an older one.
    func search(debounce: Duration = .milliseconds(250)) {
        task?.cancel()
        let q = query
        guard !q.q.trimmingCharacters(in: .whitespaces).isEmpty else {
            response = nil
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

    func more() async {
        guard let current = response, current.results.count < current.total else { return }
        var request = query
        request.offset = current.results.count
        request.limit = 20
        if let page = try? await api.search(request, allHosts: allHosts) {
            response = SearchResponse(enabled: page.enabled, building: page.building, results: current.results + page.results, total: page.total, tookMs: page.tookMs, notes: page.notes)
        }
    }

    func loadStatus() async { status = try? await api.searchStatus() }
}

/// History: ended and discovered conversations, filter, resume, fork, hide (`web/HistoryView.tsx`).
enum HistoryFilter {
    static func matches(_ row: HistoryRow, _ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return true }
        return [row.dto.title, row.dto.project, row.dto.harness, row.dto.cwd, row.host, row.dto.model ?? ""].contains { $0.lowercased().contains(q) }
    }

    /// Grouped by day for the list ("Today", "Yesterday", a date).
    static func dayLabel(_ seconds: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: seconds)
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.setLocalizedDateFormatFromTemplate(calendar.isDate(date, equalTo: now, toGranularity: .year) ? "EEEEdMMMM" : "dMMMMyyyy")
        return formatter.string(from: date)
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
            subscriptions = (try? await subs) ?? []
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
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

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }
        messages.append(ChatMessage(role: .user, text: trimmed, at: Date().timeIntervalSince1970 * 1000, id: nil))
        do {
            let reply = try await api.sendChat(uid, text: trimmed, subscriptionId: subscriptionId)
            messages.append(reply.message)
            followups = reply.followups
            error = nil
        } catch {
            messages.removeLast()
            self.error = APIError.wrap(error).message
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

    init(api: APIClient, uid: String) {
        self.api = api
        self.uid = uid
    }

    func load() async {
        do {
            list = try await api.snapshots(uid)
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
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
    func restore(turn: Int, interrupt: Bool) async -> SnapshotRestore? {
        restoring = turn
        defer { restoring = nil }
        do {
            let result = try await api.restoreSnapshot(uid, turn: turn, interrupt: interrupt)
            await load()
            return result
        } catch {
            self.error = APIError.wrap(error).message
            return nil
        }
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
            info = try await api.preview(uid)
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    func start(_ port: Int) async {
        do {
            _ = try await api.startPreview(uid, target: port)
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
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

    init(api: APIClient) { self.api = api }

    func load() async {
        do {
            trees = try await api.worktrees()
            error = nil
        } catch {
            self.error = APIError.wrap(error).message
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
            await load()
        } catch {
            self.error = APIError.wrap(error).message
        }
    }

    nonisolated static func size(_ bytes: Double?) -> String {
        guard let bytes else { return "measuring…" }
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
