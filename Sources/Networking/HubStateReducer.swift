import Foundation

/// One reducer per host stream. The stream owner must reset on disconnect,
/// foreground resync and account revocation. No merging across connections.
struct HubStateReducer: Sendable {
    private(set) var state: HubStateDTO?

    mutating func reset() {
        state = nil
    }

    /// A full state fetched over REST (polling fallback, foreground resync).
    mutating func adopt(_ next: HubStateDTO) throws {
        do {
            try next.validate()
            state = next
        } catch {
            state = nil
            throw error
        }
    }

    /// Unknown event names are ignored. Recognized events are committed atomically;
    /// a bad event invalidates the baseline until a new full snapshot arrives.
    @discardableResult
    mutating func apply(_ event: ServerSentEvent) throws -> Bool {
        guard event.name == "state" || event.name == "patch" else { return false }
        do {
            let data = Data(event.data.utf8)
            var next: HubStateDTO
            if event.name == "state" {
                next = try JSONDecoder().decode(HubStateDTO.self, from: data)
            } else {
                guard let previous = state else { throw HubStateDTO.StateError.snapshotRequired }
                let patch = try JSONDecoder().decode(HubStatePatchDTO.self, from: data)
                next = try patch.applying(to: previous)
            }
            try next.validate()
            state = next
            return true
        } catch {
            state = nil
            throw error
        }
    }
}

/// Omitted and explicit null are different on this wire. Arrays replace in full;
/// this is neither JSON Patch nor a recursive merge (`server/core.ts` tick sends the
/// top-level fields that changed). Asked for with `?delta=1`, the sessions come as a
/// `windowsDelta` instead: the ones that changed, and every uid in order.
private struct HubStatePatchDTO: Decodable {
    let api: PatchField<Int>
    let hostname: PatchField<String>
    let hosts: PatchField<[HostDTO]>
    let home: PatchField<String>
    let defaultSession: PatchField<String>
    let sessions: PatchField<[String]>
    let windows: PatchField<[SessionDTO]>
    let history: PatchField<[HistoryItemDTO]>
    let presets: PatchField<[PresetDTO]>
    let omarchy: PatchField<OmarchyStampDTO>
    let focus: PatchField<FocusDTO>
    let review: PatchField<ReviewStateDTO>
    let features: PatchField<[String: Int]>
    let notes: PatchField<NotesStateDTO>
    let jobs: PatchField<JobsStateDTO>
    let windowsDelta: PatchField<WindowsDelta>

    struct WindowsDelta: Decodable {
        let changed: [SessionDTO]
        let order: [String]

        /// The list it describes: the sessions it carries, the rest as they were.
        func applying(to previous: [SessionDTO]) -> [SessionDTO] {
            var byUID = Dictionary(previous.map { ($0.uid, $0) }, uniquingKeysWith: { $1 })
            for session in changed { byUID[session.uid] = session }
            return order.compactMap { byUID[$0] }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case api, hostname, hosts, home, defaultSession, sessions, windows, history, presets, omarchy, focus, review, features, notes, jobs, windowsDelta
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        api = try container.patch(.api)
        hostname = try container.patch(.hostname)
        hosts = try container.patch(.hosts)
        home = try container.patch(.home)
        defaultSession = try container.patch(.defaultSession)
        sessions = try container.patch(.sessions)
        windows = try container.patch(.windows)
        history = try container.patch(.history)
        presets = try container.patch(.presets)
        omarchy = try container.patch(.omarchy)
        focus = try container.patch(.focus)
        review = try container.patch(.review)
        // A features map this build can't read is no change, never a broken stream.
        features = (try? container.patch(.features)) ?? .unchanged
        notes = (try? container.patch(.notes)) ?? .unchanged
        jobs = (try? container.patch(.jobs)) ?? .unchanged
        windowsDelta = try container.patch(.windowsDelta)
    }

    func applying(to previous: HubStateDTO) throws -> HubStateDTO {
        var next = previous
        next.api = try api.replacing(previous.api)
        next.hostname = try hostname.replacing(previous.hostname)
        next.hosts = try hosts.replacing(previous.hosts)
        next.home = try home.replacing(previous.home)
        next.defaultSession = try defaultSession.replacing(previous.defaultSession)
        next.sessions = try sessions.replacing(previous.sessions)
        next.windows = try windows.replacing(previous.windows)
        if case .value(let delta) = windowsDelta { next.windows = delta.applying(to: previous.windows) }
        next.history = try history.replacing(previous.history)
        next.presets = try presets.replacing(previous.presets)
        next.omarchy = omarchy.optional(previous.omarchy)
        next.focus = focus.optional(previous.focus)
        next.review = review.optional(previous.review)
        next.features = features.optional(previous.features)
        next.notes = notes.optional(previous.notes)
        next.jobs = jobs.optional(previous.jobs)
        return next
    }
}

private enum PatchField<Value: Decodable>: Decodable {
    case unchanged
    case null
    case value(Value)

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = container.decodeNil() ? .null : .value(try container.decode(Value.self))
    }

    /// A nullable field: omitted keeps it, null clears it.
    func optional(_ previous: Value?) -> Value? {
        switch self {
        case .unchanged: return previous
        case .null: return nil
        case .value(let value): return value
        }
    }

    func replacing(_ previous: Value) throws -> Value {
        switch self {
        case .unchanged: return previous
        case .null: throw HubStateDTO.StateError.nullRequiredField
        case .value(let value): return value
        }
    }
}

private extension KeyedDecodingContainer {
    func patch<Value: Decodable>(_ key: Key) throws -> PatchField<Value> {
        contains(key) ? try decode(PatchField<Value>.self, forKey: key) : .unchanged
    }
}
