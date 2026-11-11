import Foundation
import GRDB

/// Per-device choices (never host-wide state, never secrets): appearance, reading
/// preferences, the key bar, notification opt-ins, this device's name and shortcuts.
struct DevicePreferences: Codable, Equatable, Sendable {
    enum Appearance: String, Codable, Sendable, CaseIterable {
        case system, dark, light
        /// Follow the host's Omarchy theme colors.
        case omarchy

        var label: String {
            switch self {
            case .system: return "System"
            case .dark: return "Dark"
            case .light: return "Light"
            case .omarchy: return "Omarchy"
            }
        }
    }

    enum InboxGrouping: String, Codable, Sendable, CaseIterable {
        case status, project, host
    }

    struct Notifications: Codable, Equatable, Sendable {
        var enabled = false
        var needsYou = true
        var finished = false
        /// Keep titles and questions off the lock screen.
        var privatePreview = false
    }

    var appearance: Appearance = .system
    /// What other devices call this one; nil uses the model name.
    var deviceName: String? = nil
    var stepsHidden = false
    /// The terminal's on-screen key row: on touch only (auto), always, or never.
    var keyBar: KeyBarMode = .auto
    var terminalFontSize: Double = TerminalTextSize.standard
    var inboxGrouping: InboxGrouping = .status
    var notifications = Notifications()
    /// Agents chosen recently in New session, newest first.
    var recentAgents: [String] = []
    /// With a trackpad or mouse, hovering over a pane focuses it.
    var focusFollowsPointer = true
    /// Palette rows run recently (`PaletteAction.recentKey`), newest first.
    var recentPalette: [String] = []
    /// New session's last choices for each agent, by preset id.
    var launchMemory: [String: LaunchMemory] = [:]
    /// The sidebar's blocks as dragged on this device (`../ah/web/groupOrder.ts`); empty
    /// until a block is moved. Session order lives on the host.
    var groupOrder = GroupOrder()

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
        /// "Skip startup confirmations" was on.
        var trust: Bool? = nil
    }

    init() {}

    private enum CodingKeys: String, CodingKey { case appearance, deviceName, stepsHidden, keyBar, terminalFontSize, inboxGrouping, notifications, recentAgents, focusFollowsPointer, recentPalette, launchMemory, groupOrder }

    private enum LegacyKeys: String, CodingKey { case keyBarVisible }

    /// Fields added later decode with their defaults, so older rows keep working.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let legacy = try decoder.container(keyedBy: LegacyKeys.self)
        appearance = (try? c.decode(Appearance.self, forKey: .appearance)) ?? .system
        deviceName = try? c.decodeIfPresent(String.self, forKey: .deviceName)
        stepsHidden = (try? c.decode(Bool.self, forKey: .stepsHidden)) ?? false
        // Older rows stored a switch: on meant "when it helps", off meant never.
        keyBar = (try? c.decode(KeyBarMode.self, forKey: .keyBar)) ?? ((try? legacy.decode(Bool.self, forKey: .keyBarVisible)) == false ? .off : .auto)
        terminalFontSize = TerminalTextSize.clamped((try? c.decode(Double.self, forKey: .terminalFontSize)) ?? TerminalTextSize.standard)
        inboxGrouping = (try? c.decode(InboxGrouping.self, forKey: .inboxGrouping)) ?? .status
        notifications = (try? c.decode(Notifications.self, forKey: .notifications)) ?? Notifications()
        recentAgents = (try? c.decode([String].self, forKey: .recentAgents)) ?? []
        focusFollowsPointer = (try? c.decode(Bool.self, forKey: .focusFollowsPointer)) ?? true
        recentPalette = (try? c.decode([String].self, forKey: .recentPalette)) ?? []
        launchMemory = (try? c.decode([String: LaunchMemory].self, forKey: .launchMemory)) ?? [:]
        groupOrder = (try? c.decode(GroupOrder.self, forKey: .groupOrder)) ?? GroupOrder()
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
