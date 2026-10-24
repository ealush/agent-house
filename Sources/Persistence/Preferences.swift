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
    var keyBarVisible = true
    var terminalFontSize: Double = 13
    var inboxGrouping: InboxGrouping = .status
    var notifications = Notifications()
    /// Agents chosen recently in New session, newest first.
    var recentAgents: [String] = []
    /// With a trackpad or mouse, hovering over a pane focuses it.
    var focusFollowsPointer = true
    /// Palette rows run recently (`PaletteAction.recentKey`), newest first.
    var recentPalette: [String] = []

    init() {}

    private enum CodingKeys: String, CodingKey { case appearance, deviceName, stepsHidden, keyBarVisible, terminalFontSize, inboxGrouping, notifications, recentAgents, focusFollowsPointer, recentPalette }

    /// Fields added later decode with their defaults, so older rows keep working.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appearance = (try? c.decode(Appearance.self, forKey: .appearance)) ?? .system
        deviceName = try? c.decodeIfPresent(String.self, forKey: .deviceName)
        stepsHidden = (try? c.decode(Bool.self, forKey: .stepsHidden)) ?? false
        keyBarVisible = (try? c.decode(Bool.self, forKey: .keyBarVisible)) ?? true
        terminalFontSize = (try? c.decode(Double.self, forKey: .terminalFontSize)) ?? 13
        inboxGrouping = (try? c.decode(InboxGrouping.self, forKey: .inboxGrouping)) ?? .status
        notifications = (try? c.decode(Notifications.self, forKey: .notifications)) ?? Notifications()
        recentAgents = (try? c.decode([String].self, forKey: .recentAgents)) ?? []
        focusFollowsPointer = (try? c.decode(Bool.self, forKey: .focusFollowsPointer)) ?? true
        recentPalette = (try? c.decode([String].self, forKey: .recentPalette)) ?? []
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
