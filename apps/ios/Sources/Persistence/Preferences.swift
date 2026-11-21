import Foundation
import GRDB

/// Per-device choices (never host-wide state, never secrets): appearance, reading
/// preferences, the key bar, notification opt-ins, this device's name and shortcuts.
struct DevicePreferences: Codable, Equatable, Sendable {
    enum Appearance: Codable, Equatable, Hashable, Sendable {
        case system, dark, light
        /// Follow the host's Omarchy theme colors.
        case omarchy
        /// One of the palettes the app carries (`BuiltinPalette`), by id.
        case palette(String)

        /// ah's own looks and the host's, in the order the settings show them.
        static let looks: [Appearance] = [.system, .dark, .light, .omarchy]

        var label: String {
            switch self {
            case .system: return "System"
            case .dark: return "Dark"
            case .light: return "Light"
            case .omarchy: return "Omarchy"
            case .palette(let id): return BuiltinPalette.named(id)?.name ?? id
            }
        }

        /// Stored as one word, as before ("dark"), or "palette:<id>".
        var key: String {
            switch self {
            case .system: return "system"
            case .dark: return "dark"
            case .light: return "light"
            case .omarchy: return "omarchy"
            case .palette(let id): return "palette:" + id
            }
        }

        init?(key: String) {
            switch key {
            case "system": self = .system
            case "dark": self = .dark
            case "light": self = .light
            case "omarchy": self = .omarchy
            default:
                guard key.hasPrefix("palette:"), BuiltinPalette.named(String(key.dropFirst(8))) != nil else { return nil }
                self = .palette(String(key.dropFirst(8)))
            }
        }

        init(from decoder: any Decoder) throws {
            let key = try decoder.singleValueContainer().decode(String.self)
            guard let value = Appearance(key: key) else {
                throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "No appearance named \(key)"))
            }
            self = value
        }

        func encode(to encoder: any Encoder) throws {
            var c = encoder.singleValueContainer()
            try c.encode(key)
        }
    }

    /// The Inbox by status (what needs you, what's working, the rest), or in the session
    /// list's own blocks (per project, or per host with more than one), as Sessions was.
    enum InboxGrouping: String, Codable, Sendable, CaseIterable {
        case status, project

        init(from decoder: any Decoder) throws {
            // "host" was its own choice; the blocks are per host already when there are hosts.
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = raw == "status" ? .status : .project
        }
    }

    /// How the sidebar (and the Inbox in blocks) lists sessions: in blocks per project, each
    /// in the order they were opened, or as one list with the latest active first, as chats.
    enum SessionSort: String, Codable, Sendable, CaseIterable {
        case project, recent
    }

    /// How several pictures in a message sit in the conversation: in a pile, the first on top
    /// (it says there are more under it), or side by side as tiles.
    enum PictureLook: String, Codable, Sendable, CaseIterable {
        case stack, grid
    }

    struct Notifications: Codable, Equatable, Sendable {
        var enabled = false
        var needsYou = true
        var finished = false
        /// Keep titles and questions off the lock screen.
        var privatePreview = false
        /// Hosts (account origins) this device hears nothing from: the host is told to stop
        /// alerting it, and the app posts nothing for it either.
        var mutedHosts: [String] = []
        /// A session you send to shows on the Lock Screen and in the Dynamic Island while it works.
        var liveActivities = true

        init() {}

        // Each one on its own: a preference added later mustn't reset the ones saved before it.
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
            needsYou = try c.decodeIfPresent(Bool.self, forKey: .needsYou) ?? true
            finished = try c.decodeIfPresent(Bool.self, forKey: .finished) ?? false
            privatePreview = try c.decodeIfPresent(Bool.self, forKey: .privatePreview) ?? false
            mutedHosts = try c.decodeIfPresent([String].self, forKey: .mutedHosts) ?? []
            liveActivities = try c.decodeIfPresent(Bool.self, forKey: .liveActivities) ?? true
        }
    }

    var appearance: Appearance = .system
    /// What other devices call this one; nil uses the model name.
    var deviceName: String? = nil
    var stepsHidden = false
    /// Transcripts show the conversation only: the agent's steps and thinking are out of the
    /// way until asked for (a session's working line, or Show Steps).
    var focusMode = false
    /// The terminal's on-screen key row: on touch only (auto), always, or never.
    var keyBar: KeyBarMode = .auto
    var terminalFontSize: Double = TerminalTextSize.standard
    var inboxGrouping: InboxGrouping = .status
    var sessionSort: SessionSort = .project
    var pictureLook: PictureLook = .stack
    /// The queue above the box folded to its one line (what's next), on this device.
    var queueFolded = false
    /// Dictation puts each part into the box as soon as it's heard, and shows the phone's
    /// words for what you're saying now (Settings → Voice); off, the words go in when you're done.
    var wordsAsYouSpeak = true
    var notifications = Notifications()
    /// Agents chosen recently in New session, newest first.
    var recentAgents: [String] = []
    /// With a trackpad or mouse, hovering over a pane focuses it.
    var focusFollowsPointer = true
    /// Palette rows run recently (`PaletteAction.recentKey`), newest first.
    var recentPalette: [String] = []
    /// New session's last choices for each agent, by preset id.
    var launchMemory: [String: LaunchMemory] = [:]
    /// Where the last new session started (its host, nil for the hub, and folder): the next
    /// one starts there too.
    var lastPlace: Place?

    struct Place: Codable, Equatable, Sendable {
        var host: String?
        var cwd: String
    }
    /// The sidebar's blocks as dragged on this device (`apps/server/web/groupOrder.ts`); empty
    /// until a block is moved. Session order lives on the host.
    var groupOrder = GroupOrder()
    /// The sidebar's blocks folded on this device (by project, or host), so the ones below
    /// come into view; empty until one is folded.
    var collapsedGroups: [String] = []

    struct GroupOrder: Codable, Equatable, Sendable {
        var project: [String] = []
        var host: [String] = []

        func saved(multiHost: Bool) -> [String] { multiHost ? host : project }

        mutating func set(_ order: [String], multiHost: Bool) {
            if multiHost { host = order } else { project = order }
        }
    }

    struct LaunchMemory: Codable, Equatable, Sendable {
        var mode: String?
        var model: String?
        var effort: String?
        /// The effort last started with each model, by model id ("default" for the agent's
        /// own model, and as the value for Default effort).
        var efforts: [String: String]? = nil
        /// "Skip startup confirmations" was on.
        var trust: Bool? = nil

        /// The effort for each model; older rows kept only the last model's.
        var effortsByModel: [String: String] { efforts ?? effort.map { [model ?? "default": $0] } ?? [:] }
    }

    init() {}

    private enum CodingKeys: String, CodingKey { case appearance, deviceName, stepsHidden, focusMode, keyBar, terminalFontSize, inboxGrouping, notifications, recentAgents, focusFollowsPointer, recentPalette, launchMemory, lastPlace, groupOrder, collapsedGroups, sessionSort, queueFolded, wordsAsYouSpeak, pictureLook }

    private enum LegacyKeys: String, CodingKey { case keyBarVisible }

    /// Fields added later decode with their defaults, so older rows keep working.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let legacy = try decoder.container(keyedBy: LegacyKeys.self)
        appearance = (try? c.decode(Appearance.self, forKey: .appearance)) ?? .system
        deviceName = try? c.decodeIfPresent(String.self, forKey: .deviceName)
        stepsHidden = (try? c.decode(Bool.self, forKey: .stepsHidden)) ?? false
        focusMode = (try? c.decode(Bool.self, forKey: .focusMode)) ?? false
        // Older rows stored a switch: on meant "when it helps", off meant never.
        keyBar = (try? c.decode(KeyBarMode.self, forKey: .keyBar)) ?? ((try? legacy.decode(Bool.self, forKey: .keyBarVisible)) == false ? .off : .auto)
        terminalFontSize = TerminalTextSize.clamped((try? c.decode(Double.self, forKey: .terminalFontSize)) ?? TerminalTextSize.standard)
        inboxGrouping = (try? c.decode(InboxGrouping.self, forKey: .inboxGrouping)) ?? .status
        notifications = (try? c.decode(Notifications.self, forKey: .notifications)) ?? Notifications()
        recentAgents = (try? c.decode([String].self, forKey: .recentAgents)) ?? []
        focusFollowsPointer = (try? c.decode(Bool.self, forKey: .focusFollowsPointer)) ?? true
        recentPalette = (try? c.decode([String].self, forKey: .recentPalette)) ?? []
        launchMemory = (try? c.decode([String: LaunchMemory].self, forKey: .launchMemory)) ?? [:]
        lastPlace = try? c.decodeIfPresent(Place.self, forKey: .lastPlace)
        groupOrder = (try? c.decode(GroupOrder.self, forKey: .groupOrder)) ?? GroupOrder()
        collapsedGroups = (try? c.decode([String].self, forKey: .collapsedGroups)) ?? []
        sessionSort = (try? c.decode(SessionSort.self, forKey: .sessionSort)) ?? .project
        queueFolded = (try? c.decode(Bool.self, forKey: .queueFolded)) ?? false
        wordsAsYouSpeak = (try? c.decode(Bool.self, forKey: .wordsAsYouSpeak)) ?? true
        pictureLook = (try? c.decode(PictureLook.self, forKey: .pictureLook)) ?? .stack
    }

    enum KeyBarMode: String, Codable, Sendable, CaseIterable {
        case auto, on, off
    }

    /// Whether the key row shows, given whether a hardware keyboard is attached.
    func showsKeyBar(hardwareKeyboard: Bool) -> Bool {
        keyBar == .on || (keyBar == .auto && !hardwareKeyboard)
    }

    mutating func notePalette(_ key: String) {
        recentPalette = Array(([key] + recentPalette.filter { $0 != key }).prefix(12))
    }

    mutating func noteAgent(_ id: String) {
        recentAgents = [id] + recentAgents.filter { $0 != id }
        recentAgents = Array(recentAgents.prefix(8))
    }
}

struct PreferenceRepository: Sendable {
    let database: AppDatabase
    private static let deviceKey = "device.v1"
    private static let bindingsKey = "keyBindings.v1"

    func device() -> DevicePreferences {
        guard let data = try? database.pool.read({ db in try Data.fetchOne(db, sql: "SELECT value FROM preference WHERE key = ?", arguments: [Self.deviceKey]) }) else { return DevicePreferences() }
        return (try? JSONDecoder().decode(DevicePreferences.self, from: data)) ?? DevicePreferences()
    }

    func save(_ preferences: DevicePreferences) throws {
        try put(Self.deviceKey, try JSONEncoder().encode(preferences))
    }

    func keyBindings() -> KeyBindings {
        KeyBindings(json: try? database.pool.read { db in try Data.fetchOne(db, sql: "SELECT value FROM preference WHERE key = ?", arguments: [Self.bindingsKey]) })
    }

    func save(_ bindings: KeyBindings) throws {
        try put(Self.bindingsKey, bindings.json())
    }

    private func put(_ key: String, _ value: Data) throws {
        try database.pool.write { db in
            try db.execute(sql: "INSERT INTO preference (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", arguments: [key, value])
        }
    }

    // MARK: GUI or terminal, per session, on this device

    static let surfaceLimit = 500

    func surface(origin: String, sessionKey: String) -> SceneSnapshot.Surface? {
        let raw = try? database.pool.read { db in
            try String.fetchOne(db, sql: "SELECT surface FROM sessionSurface WHERE origin = ? AND sessionKey = ?", arguments: [origin, sessionKey])
        }
        return raw.flatMap { SceneSnapshot.Surface(rawValue: $0) }
    }

    /// Remembered per session; bounded to the newest few hundred.
    func setSurface(_ surface: SceneSnapshot.Surface, origin: String, sessionKey: String, at time: Double = Date().timeIntervalSince1970) throws {
        try database.pool.write { db in
            try db.execute(
                sql: "INSERT INTO sessionSurface (origin, sessionKey, surface, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(origin, sessionKey) DO UPDATE SET surface = excluded.surface, updatedAt = excluded.updatedAt",
                arguments: [origin, sessionKey, surface.rawValue, time]
            )
            try db.execute(sql: "DELETE FROM sessionSurface WHERE rowid NOT IN (SELECT rowid FROM sessionSurface ORDER BY updatedAt DESC LIMIT ?)", arguments: [Self.surfaceLimit])
        }
    }
}

/// The terminal's text size on this device: pinched, stepped with ⌘= / ⌘- (⌘0 resets) or set
/// in Settings, and the same for every terminal it opens.
enum TerminalTextSize {
    static let standard: Double = 13
    static let range: ClosedRange<Double> = 8...28

    static func clamped(_ size: Double) -> Double { min(range.upperBound, max(range.lowerBound, size.rounded())) }

    /// One point bigger or smaller, within the range.
    static func step(_ size: Double, by: Int) -> Double { clamped(size + Double(by)) }
}
