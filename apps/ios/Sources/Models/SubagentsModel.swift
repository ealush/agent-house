import Foundation
import Observation

/// One session's subagents tree, as its host last said (`GET /api/sessions/:ref/subagents`).
/// Fetched when someone looks (the browser, a child's header) and again only when the row's
/// `rev` says the tree changed, coalesced, so a tree full of working agents costs one request
/// per change the host saw, not one per update; nothing polls.
@MainActor
@Observable
final class SubagentsModel {
    enum Phase: Equatable, Sendable {
        /// Not asked yet.
        case idle
        case loading
        case loaded
        /// The host reads no subagents of this session's agent (a shell, another harness), or
        /// is too old to.
        case unsupported
        /// The last ask failed; `tree` keeps what the one before brought.
        case failed(String)
    }

    /// The ref the host is asked by: the session's own (a uid, a history ref, a child's ref).
    let ref: String
    let host: String?
    private(set) var tree: SubagentTreeDTO?
    private(set) var phase: Phase = .idle
    /// Rows the browser folded, by ref: kept while the session stays open.
    var collapsed: Set<String> = []

    @ObservationIgnored private let fetch: @Sendable (String) async throws -> SubagentTreeDTO
    @ObservationIgnored private var seenRev: String?
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private let coalesce: Duration

    init(ref: String, host: String?, coalesce: Duration = .milliseconds(350), fetch: @escaping @Sendable (String) async throws -> SubagentTreeDTO) {
        self.ref = ref
        self.host = host
        self.coalesce = coalesce
        self.fetch = fetch
    }

    convenience init(ref: String, host: String?, api: APIClient) {
        self.init(ref: ref, host: host) { ref in try await api.subagents(ref) }
    }

    /// The child the tree was asked for by, when this is a child's.
    var selfNode: SubagentNodeDTO? { tree?.selfRef.flatMap { node($0) } }

    func node(_ ref: String) -> SubagentNodeDTO? { tree?.nodes.first { $0.ref == ref } }

    /// What's below this session: the whole tree for a root, a child's own descendants for a child.
    var summary: SubagentSummaryDTO { SubagentTree.summary(of: tree?.selfRef, in: tree?.nodes ?? []) }

    var rows: [SubagentTree.Row] { SubagentTree.rows(tree?.nodes ?? [], under: tree?.selfRef, collapsed: collapsed) }

    /// Asks the host now. While an ask is out, waits for it and asks again after: what it brings
    /// may predate what the caller wants to find.
    func load() async {
        pending?.cancel()
        pending = nil
        if let inflight { await inflight.value }
        await run()
    }

    /// The row's summary changed: ask again, shortly, once it has been asked at all (nobody
    /// looked yet: nothing to keep current). Many changes in a burst are one ask.
    func rowChanged(rev: String?) {
        guard let rev, rev != seenRev else { return }
        seenRev = rev
        guard phase != .idle, phase != .unsupported else { return }
        pending?.cancel()
        let wait = coalesce
        pending = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            await self?.run()
        }
    }

    /// Stop any ask on its way (the session closed).
    func stop() {
        pending?.cancel()
        pending = nil
    }

    @ObservationIgnored private var inflight: Task<Void, Never>?
    @ObservationIgnored private var again = false

    private func run() async {
        // Asked while an ask is out: once more after it, for what changed since it left.
        if let inflight {
            again = true
            await inflight.value
            return
        }
        let task = Task { await self.ask() }
        inflight = task
        await task.value
        inflight = nil
        if again {
            again = false
            await run()
        }
    }

    private func ask() async {
        if tree == nil { phase = .loading }
        do {
            let next = try await fetch(ref)
            if next != tree { tree = next }
            phase = .loaded
        } catch {
            switch APIError.wrap(error) {
            case .cancelled: if tree == nil { phase = .idle }
            case .notFound: phase = .unsupported
            case let e: phase = .failed(e.message)
            }
        }
    }
}
