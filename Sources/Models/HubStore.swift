import Foundation
import Observation

/// Live state for every host an account reaches (`../ah/web/useHosts.ts`): the hub itself,
/// plus each online peer it proxies under `/h/<peer>`. One stream per host for the whole
/// app (every window observes this store, none opens its own), merged into one list with
/// keys unique across machines: the uid on the hub, "peer/uid" elsewhere.
@MainActor
@Observable
final class HubStore {
    let api: APIClient
    private(set) var hub = StateUpdate(state: nil, phase: .connecting) { didSet { derived = Derived(); refreshSlots() } }
    private(set) var peers: [String: StateUpdate] = [:] { didSet { derived = Derived(); refreshSlots() } }
    /// Optimistically hidden rows (just terminated): gone until the host stops listing them.
    private(set) var hidden: Set<String> = [] {
        didSet {
            derived.rows = nil
            derived.index = nil
            refreshSlots()
        }
    }
    /// The newest validated hub state seen this run, kept through a disconnect so the UI can
    /// say "as of …" instead of going blank. Not observed: it changes on every tick, and is
    /// only shown once the connection's phase (which is) says it's offline.
    @ObservationIgnored private(set) var lastUpdated: Date?
    /// The hub's session list as it was last time, sealed for this sign-in: shown until the
    /// host answers, so a cold launch isn't blank. Never used to decide what still exists.
    private(set) var cachedState: HubStateDTO? { didSet { derived = Derived(); refreshSlots() } }
    var onSignedOut: (@MainActor () -> Void)?
    /// The host's notes changed (its cursor moved) or it's reachable again: time to sync.
    @ObservationIgnored var onNotes: (@MainActor () -> Void)?
    @ObservationIgnored private var notesSeen: (cursor: Int?, usable: Bool) = (nil, false)

    struct StateCache {
        let load: @MainActor () -> HubStateDTO?
        let store: @MainActor (HubStateDTO) -> Void
    }

    /// The lists every screen reads, made once per change to what they're made from: a
    /// session's screen asks for its row dozens of times a pass, and each ask used to map
    /// every window on every host again (and sort the whole history).
    private struct Derived {
        var all: [SessionRow]?
        var rows: [SessionRow]?
        var index: [String: SessionRow]?
        var history: [HistoryRow]?
    }
    @ObservationIgnored private var derived = Derived()

    /// One session's row and its agent, observed on their own. Read through the store, a
    /// session's screen drew again whenever anything changed on any host (every tick of the
    /// state, while any agent anywhere works); through its slot, only when its own row does.
    @MainActor
    @Observable
    final class Slot {
        fileprivate(set) var row: SessionRow?
        fileprivate(set) var preset: PresetDTO?
    }
    @ObservationIgnored private var slots: [String: Slot] = [:]

    func slot(_ key: String) -> Slot {
        if let kept = slots[key] { return kept }
        let slot = Slot()
        slot.row = row(key)
        slot.preset = slot.row.flatMap(preset)
        slots[key] = slot
        return slot
    }

    private func refreshSlots() {
        for (key, slot) in slots {
            let row = row(key)
            if slot.row != row { slot.row = row }
            let preset = row.flatMap(preset)
            if slot.preset != preset { slot.preset = preset }
        }
    }

    @ObservationIgnored private var stateCache: StateCache?
    @ObservationIgnored private var lastCached = Date.distantPast
    static let cacheInterval: TimeInterval = 10

    @ObservationIgnored private var hubStream: StateStream?
    @ObservationIgnored private var hubTask: Task<Void, Never>?
    @ObservationIgnored private var peerStreams: [String: (stream: StateStream, task: Task<Void, Never>)] = [:]

    init(api: APIClient) {
        self.api = api
    }

    // MARK: Lifecycle

    func start() {
        guard hubStream == nil else { return }
        let stream = StateStream(api: api)
        hubStream = stream
        hubTask = Task { [weak self] in
            let updates = await stream.updates()
            await stream.start()
            for await update in updates {
                guard let self else { return }
                self.apply(hub: update)
            }
        }
    }

    func stop() {
        hubTask?.cancel()
        hubTask = nil
        if let stream = hubStream { Task { await stream.stop() } }
        hubStream = nil
        for (_, peer) in peerStreams {
            peer.task.cancel()
            let stream = peer.stream
            Task { await stream.stop() }
        }
        peerStreams = [:]
        peers = [:]
    }

    /// Foreground, network back, or pull to refresh: every stream reconnects now.
    func resync() {
        if let stream = hubStream { Task { await stream.resync() } }
        for (_, peer) in peerStreams {
            let stream = peer.stream
            Task { await stream.resync() }
        }
    }

    /// Pull to refresh: reconnect, and come back once the host has answered (or a few seconds
    /// on), so the spinner lasts as long as the asking. It snapped back at once, before
    /// anything new had come.
    func resyncAndWait(limit: Duration = .seconds(4)) async {
        let before = lastUpdated
        resync()
        let end = ContinuousClock.now + limit
        while ContinuousClock.now < end, lastUpdated == before, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// Back in the foreground: every stream not just opened reconnects.
    func wake() {
        if let stream = hubStream { Task { await stream.wake() } }
        for (_, peer) in peerStreams {
            let stream = peer.stream
            Task { await stream.wake() }
        }
    }

    /// After our own action: shown as soon as the host says so.
    func refresh(host: String? = nil) {
        if let host, host != hostname, let peer = peerStreams[host] {
            let stream = peer.stream
            Task { await stream.refresh() }
        } else if let stream = hubStream {
            Task { await stream.refresh() }
        }
    }

    private func apply(hub update: StateUpdate) {
        if let state = update.state { lastUpdated = Date(); saveCache(state) }
        // The same state again changes nothing on screen: every view reading a row would
        // have drawn again.
        guard update != hub else { return }
        hub = update
        if update.state != nil, cachedState != nil { cachedState = nil }
        if update.phase == .signedOut {
            onSignedOut?()
            return
        }
        syncPeers()
        if let state = update.state {
            let seen = (cursor: state.notes?.cursor, usable: update.phase.isUsable)
            if seen.cursor != notesSeen.cursor || (seen.usable && !notesSeen.usable) {
                notesSeen = seen
                if state.supports("notes") { onNotes?() }
            } else {
                notesSeen.usable = seen.usable
            }
        }
        // Forget a hidden key once the host stops listing it, so a resume under the same uid shows.
        if !hidden.isEmpty {
            let live = Set(allRows.map(\.key))
            let kept = hidden.filter { live.contains($0) }
            if kept != hidden { hidden = kept }
        }
    }

    private func syncPeers() {
        guard let state = hub.state else { return }
        let wanted = Set(state.hosts.filter { !$0.isSelf && $0.online }.map(\.name))
        for (name, peer) in peerStreams where !wanted.contains(name) {
            peer.task.cancel()
            let stream = peer.stream
            Task { await stream.stop() }
            peerStreams[name] = nil
            peers[name] = nil
        }
        for name in wanted where peerStreams[name] == nil {
            let stream = StateStream(api: api.peer(name))
            let task = Task { [weak self] in
                let updates = await stream.updates()
                await stream.start()
                for await update in updates {
                    guard let self else { return }
                    // A peer's sign-in is the hub's own token: only the hub's 401 signs out.
                    if self.peers[name] != update { self.peers[name] = update }
                }
            }
            peerStreams[name] = (stream, task)
        }
    }

    // MARK: Sealed session list

    /// The sign-in's cache is ready: paint last time's list now if the host hasn't answered.
    func useCache(_ cache: StateCache) {
        stateCache = cache
        if let live = hub.state {
            saveCache(live, force: true)
        } else {
            cachedState = cache.load()
        }
    }

    /// Seal the newest state, at most every `cacheInterval` unless forced (backgrounding).
    func saveCache(_ state: HubStateDTO? = nil, force: Bool = false, now: Date = Date()) {
        guard let stateCache, let state = state ?? hub.state else { return }
        guard force || now.timeIntervalSince(lastCached) >= Self.cacheInterval else { return }
        lastCached = now
        stateCache.store(state)
    }

    /// What the screens show: the live state, or last time's until it arrives.
    var shownState: HubStateDTO? { hub.state ?? cachedState }
    var showingCached: Bool { hub.state == nil && cachedState != nil }
    /// Nothing known yet: the host hasn't answered and there's no list from last time. A page
    /// says it's still asking, rather than that there are no sessions.
    var awaitingState: Bool { shownState == nil && hub.phase == .connecting }

    // MARK: Reading

    var hostname: String? { shownState?.hostname }
    var phase: ConnectionPhase { hub.phase }
    var hosts: [HostDTO] { shownState?.hosts ?? [] }
    var multiHost: Bool { hosts.count > 1 }
    var focus: FocusDTO? { hub.state?.focus }
    var reviewAlerts: [ReviewStateDTO.Alert] { shownState?.review?.alerts ?? [] }
    var review: ReviewStateDTO? { shownState?.review }

    struct SessionReviewMatch: Equatable, Sendable {
        let stackId: String
        let stackTitle: String
        let pr: Int?
        let role: String
        let relation: String
        let status: String?
        let openFindings: Int
        let readyToMerge: Bool
        let needsYou: Int
        let fixingCount: Int
        let merging: Bool

        var label: String {
            let tag = role.isEmpty ? (pr.map { "#\($0)" } ?? "Review") : role
            if relation == "fixing" {
                if merging { return "Merging · \(tag)" }
                return fixingCount > 0 ? "Fixing \(fixingCount) · \(tag)" : "Fixing · \(tag)"
            }
            if readyToMerge { return "Ready · \(tag)" }
            if status == "rereview" { return "Re-review · \(tag)" }
            if openFindings > 0 { return "\(openFindings) comment\(openFindings == 1 ? "" : "s") · \(tag)" }
            return "Review · \(tag)"
        }
    }

    /// Finds the linked review for a session on the hub (fixing, exact repo+branch, owner, or origin).
    func reviewLink(for uid: String, branch: String?, project: String?) -> SessionReviewMatch? {
        guard let review else { return nil }
        if let f = review.fixing.first(where: { $0.uid == uid }) {
            let link = review.sessionLinks.first(where: { $0.uid == uid && $0.stackId == f.stackId })
            return SessionReviewMatch(
                stackId: f.stackId,
                stackTitle: link?.stackTitle ?? "Review",
                pr: f.pr,
                role: f.role,
                relation: "fixing",
                status: link?.status ?? "fixing",
                openFindings: link?.openFindings ?? f.count,
                readyToMerge: false,
                needsYou: link?.needsYou ?? 0,
                fixingCount: f.count,
                merging: f.merge == true
            )
        }
        if let link = review.sessionLinks.first(where: { $0.uid == uid }) {
            return SessionReviewMatch(
                stackId: link.stackId,
                stackTitle: link.stackTitle,
                pr: link.pr,
                role: link.role,
                relation: link.relation,
                status: link.status,
                openFindings: link.openFindings,
                readyToMerge: link.readyToMerge,
                needsYou: link.needsYou,
                fixingCount: 0,
                merging: false
            )
        }
        if let branch, !branch.isEmpty,
           let b = review.branches.first(where: { $0.branch == branch && (project == nil || $0.repo.hasSuffix("/\(project!)") || $0.repo == project) }) {
            return SessionReviewMatch(
                stackId: b.stackId,
                stackTitle: b.stackTitle,
                pr: b.pr,
                role: b.role,
                relation: "branch",
                status: nil,
                openFindings: 0,
                readyToMerge: false,
                needsYou: 0,
                fixingCount: 0,
                merging: false
            )
        }
        return nil
    }

    /// Every live session across hosts, before optimistic hides (last time's on the hub
    /// itself until it answers).
    private var allRows: [SessionRow] {
        // Read even when the answer is kept: whoever asks is told when these change.
        let local = shownState, peers = peers
        if let kept = derived.all { return kept }
        guard let local else { return [] }
        var rows = local.windows.map { SessionRow(key: $0.uid, host: local.hostname, isLocal: true, dto: $0) }
        for host in local.hosts where !host.isSelf {
            guard let state = peers[host.name]?.state else { continue }
            rows += state.windows.map { SessionRow(key: "\(host.name)/\($0.uid)", host: host.name, isLocal: false, dto: $0) }
        }
        derived.all = rows
        return rows
    }

    var rows: [SessionRow] {
        let all = allRows, hidden = hidden
        if let kept = derived.rows { return kept }
        let rows = hidden.isEmpty ? all : all.filter { !hidden.contains($0.key) }
        derived.rows = rows
        return rows
    }

    var history: [HistoryRow] {
        let local = shownState, peers = peers
        if let kept = derived.history { return kept }
        guard let local else { return [] }
        var rows = local.history.map { HistoryRow(host: local.hostname, isLocal: true, dto: $0) }
        for host in local.hosts where !host.isSelf {
            guard let state = peers[host.name]?.state else { continue }
            rows += state.history.map { HistoryRow(host: host.name, isLocal: false, dto: $0) }
        }
        rows.sort { a, b in a.dto.pinned != b.dto.pinned ? a.dto.pinned : a.dto.at > b.dto.at }
        derived.history = rows
        return rows
    }

    func row(_ key: String) -> SessionRow? {
        let rows = rows
        if let index = derived.index { return index[key] }
        // The first of a key, as a search down the list found it.
        let index = Dictionary(rows.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        derived.index = index
        return index[key]
    }

    /// The API for a host: the hub's for itself, `/h/<peer>` for a peer.
    func client(host: String?) -> APIClient {
        guard let host, host != hostname else { return api }
        return api.peer(host)
    }

    func client(forKey key: String) -> APIClient {
        client(host: SessionKey(key)?.host)
    }

    func presets(host: String?) -> [PresetDTO] {
        guard let host, host != hostname else { return shownState?.presets ?? [] }
        return peers[host]?.state?.presets ?? []
    }

    func preset(for row: SessionRow) -> PresetDTO? {
        guard let agent = row.dto.agent else { return nil }
        return presets(host: row.isLocal ? nil : row.host).first { $0.id == agent }
    }

    func state(host: String?) -> HubStateDTO? {
        guard let host, host != hostname else { return hub.state }
        return peers[host]?.state
    }

    /// Whether a restored key still means something, for restoration (`RestorationReconciler`).
    func presence(of key: String) -> RestorationReconciler.Presence {
        if row(key) != nil { return .live }
        guard let parsed = SessionKey(key) else {
            // A history ref ("harness:id") is fine as long as the record is listed.
            if let item = history.first(where: { $0.dto.ref == key }) { return .ended(ref: item.id, title: item.dto.title) }
            return .gone
        }
        if let item = history.first(where: { $0.dto.ref == parsed.uid && ($0.isLocal ? parsed.host == nil : $0.host == parsed.host) }) {
            return .ended(ref: item.id, title: item.dto.title)
        }
        // On a host that's up and hasn't said what it runs yet (its stream starts with the
        // hub's state, so on every launch a window restores first): kept, not taken for gone.
        // Read as gone, every pane on another host became a chooser, with a notice, each launch.
        if let host = parsed.host, hosts.contains(where: { $0.name == host && $0.online && !$0.isSelf }), peers[host]?.state == nil {
            return .live
        }
        return .gone
    }

    /// Narrowed to one project, the sections and their summary are that project's; the badge
    /// stays everyone's (it asks `inbox(narrow:)`).
    func inbox(narrow: Bool, project: InboxProject? = nil) -> InboxSections {
        InboxSections(rows: project.map { p in rows.filter { p.holds($0) } } ?? rows, reviews: reviewAlerts, hostsOnline: hosts.filter(\.online).count, hostsTotal: hosts.count, narrow: narrow)
    }

    func hide(_ key: String, _ on: Bool) {
        if on { hidden.insert(key) } else { hidden.remove(key) }
    }
}
