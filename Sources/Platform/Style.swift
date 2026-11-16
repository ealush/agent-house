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

    /// A color that follows the window's light/dark appearance between two palettes, made once
    /// per pair. A new one each time was never equal to the last: every pass gave each window
    /// a "new" tint, and UIKit told every view in it, as often as the host's state ticked.
    static func dynamic(dark: String, light: String) -> UIColor {
        HexColors.shared.dynamic(dark: dark, light: light)
    }

    /// The color for a hex string, made once: a theme's colors are asked for by every row
    /// on every pass, and each ask used to read the string's digits and make a color again
    /// (and, following the system, once more each time the color was drawn).
    static func cached(hex: String, fallback: UIColor = .label) -> UIColor {
        HexColors.shared.color(hex) ?? fallback
    }
}

/// Every hex string the app has painted with, and its color. Asked from any thread (a
/// dynamic color resolves where it's drawn), so behind a lock.
private final class HexColors: @unchecked Sendable {
    static let shared = HexColors()
    private let lock = NSLock()
    private var colors: [String: UIColor] = [:]
    private var pairs: [String: UIColor] = [:]

    func dynamic(dark: String, light: String) -> UIColor {
        let key = dark + "|" + light
        lock.lock()
        defer { lock.unlock() }
        if let kept = pairs[key] { return kept }
        let color = UIColor { traits in .cached(hex: traits.userInterfaceStyle == .dark ? dark : light) }
        pairs[key] = color
        return color
    }

    func color(_ hex: String) -> UIColor? {
        lock.lock()
        defer { lock.unlock() }
        if let kept = colors[hex] { return kept }
        guard let c = hexComponents(hex) else { return nil }
        let color = UIColor(red: c.r, green: c.g, blue: c.b, alpha: c.a)
        colors[hex] = color
        return color
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
        // A palette the app carries has its own light or dark look; one that's gone (a row
        // from a build that had it) falls back to ah's.
        case .palette(let id): return BuiltinPalette.named(id).map { Theme(palette: $0.palette, followsSystem: false) } ?? .system
        }
    }

    /// The interface style to force on windows, or nil to follow the system.
    var interfaceStyle: UIUserInterfaceStyle {
        followsSystem ? .unspecified : (palette.isDark ? .dark : .light)
    }

    private func pair(_ key: KeyPath<ThemePalette, String>) -> Color { Color(uiColor: uiPair(key)) }

    private func uiPair(_ key: KeyPath<ThemePalette, String>) -> UIColor {
        if followsSystem { return .dynamic(dark: ThemePalette.dark[keyPath: key], light: ThemePalette.light[keyPath: key]) }
        return .cached(hex: palette[keyPath: key])
    }

    /// The accent for UIKit's own controls (the tab bar, bar buttons), which don't read SwiftUI's tint.
    var uiAccent: UIColor { uiPair(\.accent) }
    /// The ground for UIKit's own views (the window behind everything).
    var uiBackground: UIColor { uiPair(\.background) }
    /// A warning for UIKit's own controls (a bar button's glyph).
    var uiDanger: UIColor { uiPair(\.danger) }
    /// A status word's color for UIKit text (a bar's subtitle); nil where it rests (idle).
    func uiStatus(_ word: StatusWord) -> UIColor? {
        switch word {
        // Words, so the accent (4.5:1 on the ground), not the brand pink a fill uses.
        case .needsYou: return uiPair(\.accent)
        case .working: return uiPair(\.run)
        case .done, .newOutput: return uiPair(\.done)
        case .limited: return uiPair(\.limited)
        case .idle: return nil
        }
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
    /// What's written on an accent fill: white on ah's pink, the ground on an Omarchy theme's
    /// light accent (white on it couldn't be read).
    var accentInk: Color { pair(\.accentInk) }
    var run: Color { pair(\.run) }
    var done: Color { pair(\.done) }
    var limited: Color { pair(\.limited) }
    var danger: Color { pair(\.danger) }

    /// A swipe action's fill: the palette's color, deep enough for the system's white label
    /// (`ThemePalette.underWhite`).
    func swipe(_ key: KeyPath<ThemePalette, String>) -> Color {
        if followsSystem {
            return Color(uiColor: .dynamic(dark: ThemePalette.underWhite(ThemePalette.dark[keyPath: key]), light: ThemePalette.underWhite(ThemePalette.light[keyPath: key])))
        }
        return Color(uiColor: .cached(hex: ThemePalette.underWhite(palette[keyPath: key])))
    }

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
        return .ahMono(.callout)
    }

    // ah's layers (the design system's names): hairlines, what needs you, status grounds, glass.
    var line: Color { pair(\.line) }
    var lineStrong: Color { pair(\.lineStrong) }
    var accentTint: Color { pair(\.accentTint) }
    var accentLine: Color { pair(\.accentLine) }
    var glassTint: Color { pair(\.glassTint) }
    var card: Color { pair(\.card) }
    var tile: Color { pair(\.tile) }
    /// Data in charts: blue, never the signal pink.
    var chart: Color { appearance(dark: UIColor(red: 0.43, green: 0.61, blue: 0.96, alpha: 1), light: UIColor(red: 0.18, green: 0.37, blue: 0.82, alpha: 1)) }
    /// ah's elevation shadow: deep on the dark ground, soft and blue-grey on the light one.
    var shadow: Color { appearance(dark: UIColor.black.withAlphaComponent(0.42), light: UIColor(red: 0.14, green: 0.16, blue: 0.21, alpha: 0.16)) }

    /// A color for the appearance in force: the theme's own when it sets one, else the system's.
    private func appearance(dark: UIColor, light: UIColor) -> Color {
        if !followsSystem { return Color(uiColor: palette.isDark ? dark : light) }
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
    func tint(_ word: StatusWord) -> Color {
        switch word {
        case .needsYou: return accentTint
        case .working: return pair(\.runTint)
        case .done, .newOutput: return pair(\.doneTint)
        case .limited: return pair(\.limitedTint)
        case .idle: return Color.clear
        }
    }
}

// MARK: Type

/// ah's type (the design system): Rubik for what people read, JetBrains Mono for what machines
/// read, at the iOS text styles' sizes so Dynamic Type scales both.
enum AhType {
    static let ui = "Rubik"
    static let mono = "JetBrains Mono"

    /// iOS's own sizes for each style at the default text size (body 17, callout 16, ...),
    /// so the app reads as the system does, and grows and shrinks with it from there. Body,
    /// callout and subheadline were a point smaller.
    static func size(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline: 17
        case .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        default: 17
        }
    }

    static func weight(_ style: Font.TextStyle) -> Font.Weight {
        switch style {
        case .largeTitle, .title: .bold
        case .title2, .title3, .headline: .semibold
        case .caption: .medium
        default: .regular
        }
    }

    static func uiStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .callout: .callout
        case .subheadline: .subheadline
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }

    /// The terminal's face: JetBrains Mono (glyphs it lacks, like a Nerd Font's, fall back).
    static func terminalFont(_ size: CGFloat) -> UIFont {
        UIFont(name: "JetBrainsMono-Regular", size: size) ?? UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// Bars and tabs in ah's face, everywhere in the app (SwiftUI's bars are UIKit's too).
    @MainActor
    static func applyToBars() {
        let nav = UINavigationBar.appearance()
        nav.titleTextAttributes = [.font: uiFont(.headline)]
        nav.largeTitleTextAttributes = [.font: uiFont(.largeTitle)]
        UITabBarItem.appearance().setTitleTextAttributes([.font: uiFont(.caption2, weight: .medium)], for: .normal)
        UIBarButtonItem.appearance().setTitleTextAttributes([.font: uiFont(.body, weight: .medium)], for: .normal)
    }

    /// The same face for UIKit text (the composer, bar titles), scaled by Dynamic Type.
    static func uiFont(_ style: Font.TextStyle, weight: UIFont.Weight? = nil, mono: Bool = false) -> UIFont {
        let size = size(style)
        let w: UIFont.Weight = weight ?? {
            switch Self.weight(style) {
            case .bold: return .bold
            case .semibold: return .semibold
            case .medium: return .medium
            default: return .regular
            }
        }()
        let descriptor = UIFontDescriptor(fontAttributes: [.family: mono ? Self.mono : Self.ui])
            .addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: w]])
        let base = UIFont(descriptor: descriptor, size: size)
        let font = base.familyName == (mono ? Self.mono : Self.ui) ? base : (mono ? UIFont.monospacedSystemFont(ofSize: size, weight: w) : UIFont.systemFont(ofSize: size, weight: w))
        return UIFontMetrics(forTextStyle: uiStyle(style)).scaledFont(for: font)
    }
}

extension Font {
    /// Rubik at a text style's size and weight, scaled with Dynamic Type.
    static func ah(_ style: Font.TextStyle) -> Font {
        .custom(AhType.ui, size: AhType.size(style), relativeTo: style).weight(AhType.weight(style))
    }

    /// JetBrains Mono, for commands, paths, code and the terminal.
    static func ahMono(_ style: Font.TextStyle) -> Font {
        .custom(AhType.mono, size: AhType.size(style) - 1, relativeTo: style)
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
    /// The dot alone (compact rows, the sidebar).
    var compact = false
    @Environment(\.theme) private var theme
    /// Increased on a selected row filled with the accent (a focused list): status colors
    /// would vanish into it, so the pill turns white there.
    @Environment(\.backgroundProminence) private var prominence
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if compact { StatusDot(word: word, onAccent: prominence == .increased) } else { pill }
        }
        // Working to done, idle to needs you: the pill changes as it's watched, not between frames.
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: word)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(word.label)
    }

    /// ah's StatusPill: the word in its status color on its tint; only "needs you" is filled,
    /// the loudest thing on screen. Idle is quiet.
    private var pill: some View {
        let filled = word == .needsYou
        return HStack(spacing: 5) {
            // Working is alive: its dot beats in the pill, as it does on its own in the sidebar.
            if word == .working {
                Circle().fill(theme.status(word)).frame(width: 6, height: 6).overlay { PulseRing(color: theme.status(word)) }
            }
            Text(word.rawValue)
        }
        .font(.ah(.caption).weight(.semibold))
        .foregroundStyle(filled ? theme.accentInk : word == .idle ? theme.text2 : theme.status(word))
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(filled ? theme.accentStrong : word == .idle ? theme.text.opacity(0.06) : theme.tint(word), in: Capsule())
    }
}

/// The pill's short form: pink with a halo for needs you, a cyan ring for working, green for
/// done, amber for limited, nothing for idle.
struct StatusDot: View {
    let word: StatusWord
    var onAccent = false
    @Environment(\.theme) private var theme

    var body: some View {
        let color = onAccent ? Color.white : theme.status(word)
        Group {
            switch word {
            case .working:
                Circle().strokeBorder(color, lineWidth: 2).overlay { PulseRing(color: color) }
            case .needsYou:
                Circle().fill(color).background(Circle().fill(color.opacity(0.25)).padding(-3))
            case .idle:
                Color.clear
            default:
                Circle().fill(color)
            }
        }
        .frame(width: 8, height: 8)
    }
}

/// The working dot's slow pulse; still under Reduce Motion.
///
/// Its own keyframes, not a repeating animation begun as it appears: that one was the
/// transaction of everything else changing in the same update, so a navigation bar's height
/// or the scroll view's inset, laid out as a dot came on screen, went on growing back from
/// where it was every 1.4 s, and the transcript under it shook for as long as the screen
/// was open.
struct PulseRing: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            ring(0)
        } else {
            KeyframeAnimator(initialValue: 0.0, repeating: true) { phase in
                ring(phase)
            } keyframes: { _ in
                LinearKeyframe(1, duration: 1.4, timingCurve: .easeOut)
            }
        }
    }

    private func ring(_ phase: Double) -> some View {
        Circle()
            .stroke(color.opacity(0.6 * (1 - phase)), lineWidth: 2)
            .scaleEffect(1 + 1.2 * phase)
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
                if index > 0 { Text("then").font(.ah(.caption2)).foregroundStyle(theme.faint) }
                HStack(spacing: 3) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        Text(part)
                            .font(.ah(.caption2).weight(.semibold))
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

/// An agent's mark (`../ah/web/logos.tsx`): its own logo on a small mat, an app-icon logo edge
/// to edge, an agent without one its initial in its tint; a shell is a terminal.
struct AgentMark: View {
    let agent: String?
    var size: CGFloat = 22
    @Environment(\.theme) private var theme
    /// Grows with the text beside it (Dynamic Type), as list icons do.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        let size = (self.size * min(scale, 2)).rounded()
        let shape = RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        Group {
            if let agent, let key = AgentLogo.key(agent) {
                if AgentLogo.tiles.contains(key) {
                    Image("Agents/\(key)").resizable().scaledToFill().clipShape(shape)
                } else {
                    // White single-color marks are template images: drawn in ink.
                    Image("Agents/\(key)").resizable().scaledToFit()
                        .foregroundStyle(theme.text)
                        .padding(size * 0.17)
                        .background(theme.tile, in: shape)
                }
            } else if let agent {
                let tint = AgentLogo.tint(agent)
                Text(AgentLogo.initial(agent))
                    .font(.system(size: size * 0.52, weight: .bold, design: .rounded))
                    .foregroundStyle(theme.followsSystem ? Color(uiColor: .dynamic(dark: tint.dark, light: tint.light)) : Color(uiColor: UIColor(hex: theme.palette.isDark ? tint.dark : tint.light)))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(theme.tile, in: shape)
            } else {
                Image(systemName: "terminal")
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(theme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(theme.tile, in: shape)
            }
        }
        .frame(width: size, height: size)
        .overlay(shape.strokeBorder(theme.text.opacity(0.06), lineWidth: 0.5))
        .accessibilityHidden(true)
    }
}

/// "3m ago", "just now": relative time that keeps itself fresh.
struct Elapsed: View {
    let seconds: Double
    /// "3m", "2h", "5d": for a list's rows, where the time sits beside a title (as Mail and
    /// Messages keep theirs), with the long form spoken.
    var short = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let date = Date(timeIntervalSince1970: seconds)
            if short {
                Text(ElapsedWords.short(since: seconds, now: context.date.timeIntervalSince1970))
                    .accessibilityLabel(Elapsed.format(date, now: context.date))
            } else {
                Text(Elapsed.format(date, now: context.date))
            }
        }
    }

    /// One formatter for every row and every tick: making one a time was most of what a
    /// long list's rows cost to draw.
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    static func format(_ date: Date, now: Date) -> String {
        let delta = now.timeIntervalSince(date)
        if delta < 45 { return "just now" }
        return relative.localizedString(for: date, relativeTo: now)
    }
}

/// A full-width notice row (errors from the host, offline state).
struct Banner: View {
    enum Tone { case info, warning, error }
    let text: String
    var tone: Tone = .info
    var action: (title: String, run: () -> Void)?
    /// A glyph of its own (a connection's), else the tone's.
    var symbol: String? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol ?? (tone == .error ? "exclamationmark.triangle.fill" : tone == .warning ? "exclamationmark.circle.fill" : "info.circle"))
                .foregroundStyle(tone == .error ? theme.danger : tone == .warning ? theme.limited : theme.muted)
            // Backticked names (a config key) read as code, as everywhere else in the app.
            Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
                .font(.ah(.callout)).foregroundStyle(theme.text2).frame(maxWidth: .infinity, alignment: .leading)
            if let action {
                Button(action.title, action: action.run).buttonStyle(.bordered).controlSize(.small)
            }
        }
        .padding(12)
        .background(theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

extension View {
    /// A banner as a form's own row: on the page's ground, not a card in a card.
    func formBanner() -> some View {
        listRowBackground(Color.clear).listRowInsets(EdgeInsets())
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
            Banner(text: "Live updates are reconnecting; showing what the host said a moment ago.", tone: .warning, symbol: "wifi.exclamationmark")
        case .offline(let message):
            Banner(text: lastUpdated.map { "Offline. Shown as of \(Elapsed.format($0, now: .now)). \(message)" } ?? message, tone: .error, action: ("Retry", retry), symbol: "wifi.slash")
        }
    }
}
