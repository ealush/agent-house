import SwiftUI
import UIKit

extension UIColor {
    convenience init(hex: String, fallback: UIColor = .label) {
        guard let c = hexComponents(hex) else {
            self.init(cgColor: fallback.cgColor)
            return
        }
        self.init(red: c.r, green: c.g, blue: c.b, alpha: c.a)
    }

    /// A color that follows the window's light/dark appearance between two palettes.
    static func dynamic(dark: String, light: String) -> UIColor {
        UIColor { traits in UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light) }
    }
}

/// The palette the app paints with right now: system (light/dark following iOS), forced dark
/// or light, or the host's Omarchy colors.
struct Theme: Equatable, Sendable {
    var palette: ThemePalette
    var followsSystem: Bool

    static let system = Theme(palette: .dark, followsSystem: true)

    static func resolve(_ appearance: DevicePreferences.Appearance, omarchy: OmarchyTheme?) -> Theme {
        switch appearance {
        case .system: return .system
        case .dark: return Theme(palette: .dark, followsSystem: false)
        case .light: return Theme(palette: .light, followsSystem: false)
        case .omarchy: return Theme(palette: omarchy.flatMap(ThemePalette.omarchy) ?? .dark, followsSystem: omarchy == nil)
        }
    }

    /// The interface style to force on windows, or nil to follow the system.
    var interfaceStyle: UIUserInterfaceStyle {
        followsSystem ? .unspecified : (palette.isDark ? .dark : .light)
    }

    private func pair(_ key: KeyPath<ThemePalette, String>) -> Color {
        if followsSystem { return Color(uiColor: .dynamic(dark: ThemePalette.dark[keyPath: key], light: ThemePalette.light[keyPath: key])) }
        return Color(uiColor: UIColor(hex: palette[keyPath: key]))
    }

    var background: Color { pair(\.background) }
    var surface: Color { pair(\.surface) }
    var raised: Color { pair(\.raised) }
    var sunken: Color { pair(\.sunken) }
    var text: Color { pair(\.text) }
    var text2: Color { pair(\.text2) }
    var muted: Color { pair(\.muted) }
    var faint: Color { pair(\.faint) }
    var brand: Color { pair(\.brand) }
    var accent: Color { pair(\.accent) }
    var accentStrong: Color { pair(\.accentStrong) }
    var run: Color { pair(\.run) }
    var done: Color { pair(\.done) }
    var limited: Color { pair(\.limited) }
    var danger: Color { pair(\.danger) }

    func status(_ word: StatusWord) -> Color {
        switch word {
        case .needsYou: return brand
        case .working: return run
        case .done, .newOutput: return done
        case .limited: return limited
        case .idle: return faint
        }
    }

    var mono: Font {
        if let name = palette.monoFont, UIFont(name: name, size: 13) != nil { return .custom(name, size: 13, relativeTo: .callout) }
        return .system(.callout, design: .monospaced)
    }
}

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme.system
}

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

/// A session's status as a dot and a word, with its meaning spoken.
struct StatusPill: View {
    let word: StatusWord
    var compact = false
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(theme.status(word))
                .frame(width: 8, height: 8)
                .overlay {
                    if word == .working { PulseRing(color: theme.status(word)) }
                }
            if !compact {
                Text(word.rawValue)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(word == .idle ? theme.muted : theme.status(word))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(word.rawValue.capitalized)
    }
}

/// The working dot's slow pulse; still under Reduce Motion.
struct PulseRing: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        Circle()
            .stroke(color.opacity(on ? 0 : 0.6), lineWidth: 2)
            .scaleEffect(on ? 2.2 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true }
            }
    }
}

/// Keycaps for a chord: ⌃ ⇧ K, or both steps of a two-key chord: ⌃ K · ⌃ S.
struct Keycaps: View {
    /// One group of caps per key pressed.
    let groups: [[String]]
    private let spoken: String
    @Environment(\.theme) private var theme

    init(_ chord: Chord) {
        groups = chord.steps.map { $0.parts(mac: true) }
        spoken = chord.formatted(mac: true)
    }

    init(parts: [String]) {
        groups = [parts]
        spoken = parts.joined(separator: " ")
    }

    var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(groups.enumerated()), id: \.offset) { index, parts in
                if index > 0 { Text("then").font(.caption2).foregroundStyle(theme.faint) }
                HStack(spacing: 3) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        Text(part)
                            .font(.caption2.weight(.semibold).monospaced())
                            .foregroundStyle(theme.text2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .frame(minWidth: 18)
                            .background(theme.raised, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(theme.faint.opacity(0.4), lineWidth: 0.5))
                            .shadow(color: .black.opacity(0.12), radius: 0, y: 1)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }
}

/// An agent's mark: its SF Symbol stand-in and initial, tinted; a shell is a terminal.
struct AgentMark: View {
    let agent: String?
    var size: CGFloat = 22
    @Environment(\.theme) private var theme

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(theme.raised)
            if let agent {
                Text(String(agent.prefix(1)).uppercased())
                    .font(.system(size: size * 0.5, weight: .bold, design: .rounded))
                    .foregroundStyle(theme.accent)
            } else {
                Image(systemName: "terminal")
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(theme.muted)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// "3m ago", "just now": relative time that keeps itself fresh.
struct Elapsed: View {
    let seconds: Double
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(Elapsed.format(Date(timeIntervalSince1970: seconds), now: context.date))
        }
    }

    static func format(_ date: Date, now: Date) -> String {
        let delta = now.timeIntervalSince(date)
        if delta < 45 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

/// A full-width notice row (errors from the host, offline state).
struct Banner: View {
    enum Tone { case info, warning, error }
    let text: String
    var tone: Tone = .info
    var action: (title: String, run: () -> Void)?
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: tone == .error ? "exclamationmark.triangle.fill" : tone == .warning ? "wifi.exclamationmark" : "info.circle")
                .foregroundStyle(tone == .error ? theme.danger : tone == .warning ? theme.limited : theme.muted)
            Text(text).font(.callout).foregroundStyle(theme.text2).frame(maxWidth: .infinity, alignment: .leading)
            if let action {
                Button(action.title, action: action.run).buttonStyle(.bordered).controlSize(.small)
            }
        }
        .padding(12)
        .background(theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// How fresh a host's state is, said plainly.
struct ConnectionBanner: View {
    let phase: ConnectionPhase
    let lastUpdated: Date?
    /// Showing last time's sealed list until the host answers.
    var cached = false
    let retry: () -> Void

    var body: some View {
        switch phase {
        case .connecting where cached:
            Banner(text: "Connecting… These are your sessions from last time.", tone: .info)
        case .live, .connecting, .signedOut:
            EmptyView()
        case .polling:
            Banner(text: "Live updates are reconnecting; showing what the host said a moment ago.", tone: .warning)
        case .offline(let message):
            Banner(text: lastUpdated.map { "Offline. Shown as of \(Elapsed.format($0, now: .now)). \(message)" } ?? message, tone: .error, action: ("Retry", retry))
        }
    }
}
