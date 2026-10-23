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
    private(set) var hub = StateUpdate(state: nil, phase: .connecting)
    private(set) var peers: [String: StateUpdate] = [:]
    /// Optimistically hidden rows (just terminated): gone until the host stops listing them.
    private(set) var hidden: Set<String> = []
    /// The newest validated hub state seen this run, kept through a disconnect so the UI can
    /// say "as of …" instead of going blank.
    private(set) var lastUpdated: Date?
    var onSignedOut: (@MainActor () -> Void)?

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

    /// After our own action: the stream's next snapshot reflects it at once.
    func refresh(host: String? = nil) {
        if let host, host != hostname, let peer = peerStreams[host] {
            let stream = peer.stream
            Task { await stream.resync() }
        } else if let stream = hubStream {
            Task { await stream.resync() }
        }
    }

    private func apply(hub update: StateUpdate) {
        hub = update
        if update.state != nil { lastUpdated = Date() }
        if update.phase == .signedOut {
            onSignedOut?()
            return
        }
        syncPeers()
        // Forget a hidden key once the host stops listing it, so a resume under the same uid shows.
        if !hidden.isEmpty {
            let live = Set(allRows.map(\.key))
            hidden = hidden.filter { live.contains($0) }
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
                    self.peers[name] = update
                }
            }
            peerStreams[name] = (stream, task)
        }
    }

    // MARK: Reading

    var hostname: String? { hub.state?.hostname }
    var phase: ConnectionPhase { hub.phase }
    var hosts: [HostDTO] { hub.state?.hosts ?? [] }
    var multiHost: Bool { hosts.count > 1 }
    var focus: FocusDTO? { hub.state?.focus }
    var reviewAlerts: [ReviewStateDTO.Alert] { hub.state?.review?.alerts ?? [] }
    var review: ReviewStateDTO? { hub.state?.review }

    /// Every live session across hosts, before optimistic hides.
    private var allRows: [SessionRow] {
        guard let local = hub.state else { return [] }
        var rows = local.windows.map { SessionRow(key: $0.uid, host: local.hostname, isLocal: true, dto: $0) }
        for host in hosts where !host.isSelf {
            guard let state = peers[host.name]?.state else { continue }
            rows += state.windows.map { SessionRow(key: "\(host.name)/\($0.uid)", host: host.name, isLocal: false, dto: $0) }
        }
        return rows
    }

    var rows: [SessionRow] {
        let all = allRows
        return hidden.isEmpty ? all : all.filter { !hidden.contains($0.key) }
    }

    var history: [HistoryRow] {
        guard let local = hub.state else { return [] }
        var rows = local.history.map { HistoryRow(host: local.hostname, isLocal: true, dto: $0) }
        for host in hosts where !host.isSelf {
            guard let state = peers[host.name]?.state else { continue }
            rows += state.history.map { HistoryRow(host: host.name, isLocal: false, dto: $0) }
        }
        return rows.sorted { a, b in a.dto.pinned != b.dto.pinned ? a.dto.pinned : a.dto.at > b.dto.at }
    }

    func row(_ key: String) -> SessionRow? { rows.first { $0.key == key } }

    /// The host a key lives on (nil for an unknown peer).
    func host(of key: String) -> String? {
        guard let parsed = SessionKey(key) else { return nil }
        return parsed.host ?? hostname
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
        guard let host, host != hostname else { return hub.state?.presets ?? [] }
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
        return .gone
    }

    func inbox(narrow: Bool) -> InboxSections {
        InboxSections(rows: rows, reviews: reviewAlerts, hostsOnline: hosts.filter(\.online).count, hostsTotal: hosts.count, narrow: narrow)
    }

    func hide(_ key: String, _ on: Bool) {
        if on { hidden.insert(key) } else { hidden.remove(key) }
    }
}
