import Foundation

/// One reducer per host stream. The stream owner must reset on disconnect,
/// foreground resync and account revocation. No merging across connections.
struct HubStateReducer: Sendable {
    private(set) var state: HubStateDTO?

    mutating func reset() {
        state = nil
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
/// this is neither JSON Patch nor a recursive merge.
private struct HubStatePatchDTO: Decodable {
    let api: PatchField<Int>
    let hostname: PatchField<String>
    let hosts: PatchField<[HostDTO]>
    let windows: PatchField<[SessionDTO]>
    let focus: PatchField<FocusDTO>

    private enum CodingKeys: String, CodingKey { case api, hostname, hosts, windows, focus }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        api = try container.patch(.api)
        hostname = try container.patch(.hostname)
        hosts = try container.patch(.hosts)
        windows = try container.patch(.windows)
        focus = try container.patch(.focus)
    }

    func applying(to previous: HubStateDTO) throws -> HubStateDTO {
        var next = previous
        next.api = try api.replacing(previous.api)
        next.hostname = try hostname.replacing(previous.hostname)
        next.hosts = try hosts.replacing(previous.hosts)
        next.windows = try windows.replacing(previous.windows)
        switch focus {
        case .unchanged: break
        case .null: next.focus = nil
        case .value(let value): next.focus = value
        }
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
