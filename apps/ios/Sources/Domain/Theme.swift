import Foundation

/// ah's design system as color tokens (`apps/server/web/tokens.css`), for dark, light and a host's
/// Omarchy theme (`web/theme.ts`): a ground behind floating panels, surfaces, raised cards and
/// sunken fields, hairlines, and pink only for what needs you. Hex strings here; the platform
/// layer makes colors. Status semantics stay the same everywhere: needs you is the brand mark,
/// working is cyan, done is green, limited is amber.
struct ThemePalette: Equatable, Sendable {
    var background: String
    var surface: String
    var raised: String
    var sunken: String
    var line: String
    var text: String
    var text2: String
    var muted: String
    var faint: String
    var brand: String
    var accent: String
    var accentStrong: String
    var accentInk: String
    var run: String
    var done: String
    var limited: String
    var danger: String
    var monoFont: String?
    var isDark: Bool
    var terminal: TerminalPalette

    static let dark = ThemePalette(
        background: "#191a25", surface: "#202231", raised: "#2a2c3e", sunken: "#15161f", line: "#ffffff14",
        text: "#ffffff", text2: "#c9cad3", muted: "#a2a4b3", faint: "#8d8fa3",
        brand: "#e91e63", accent: "#f47199", accentStrong: "#d81b60", accentInk: "#ffffff",
        run: "#4dd9ea", done: "#81d88a", limited: "#f5b84b", danger: "#ff8a80", monoFont: nil, isDark: true,
        terminal: .dark
    )

    static let light = ThemePalette(
        background: "#eef0f4", surface: "#ffffff", raised: "#f5f6f9", sunken: "#eceef3", line: "#00000014",
        text: "#1c1d27", text2: "#474a58", muted: "#5f6272", faint: "#686b7a",
        brand: "#e91e63", accent: "#c2185b", accentStrong: "#d81b60", accentInk: "#ffffff",
        run: "#00737d", done: "#276b2b", limited: "#8a5a00", danger: "#c62828", monoFont: nil, isDark: false,
        terminal: .light
    )

    /// ah's tokens from an Omarchy colors.toml (`omarchyVars`), or nil when it lacks the essentials.
    static func omarchy(_ theme: OmarchyTheme) -> ThemePalette? {
        let c = theme.colors
        guard let bg = c["background"], let fg = c["foreground"], let accent = c["accent"] else { return nil }
        func pick(_ keys: String...) -> String { keys.lazy.compactMap { c[$0] }.first ?? fg }
        return ThemePalette(
            background: bg, surface: pick("dark_background", "background"), raised: pick("lighter_background", "selection"),
            sunken: pick("darker_background", "dark_background"), line: fg + "1a",
            text: pick("bright_foreground", "foreground"), text2: fg, muted: pick("dark_foreground", "muted"), faint: pick("muted", "dark_foreground"),
            brand: accent, accent: accent, accentStrong: accent, accentInk: bg,
            run: pick("cyan", "blue"), done: pick("green"), limited: pick("yellow", "accent"), danger: pick("red"),
            monoFont: theme.font, isDark: theme.mode != "light",
            terminal: TerminalPalette.omarchy(theme)
        )
    }

    // The design system's derived layers, from the palette (so a host's Omarchy theme gets them too).
    var lineStrong: String { isDark ? "#ffffff29" : "#00000029" }
    var accentTint: String { Self.alpha(brand, isDark ? 0.12 : 0.07) }
    var accentLine: String { Self.alpha(brand, isDark ? 0.45 : 0.35) }
    var runTint: String { Self.alpha(run, isDark ? 0.12 : 0.08) }
    var doneTint: String { Self.alpha(done, isDark ? 0.12 : 0.08) }
    var limitedTint: String { Self.alpha(limited, isDark ? 0.12 : 0.08) }
    var glassTint: String { Self.alpha(raised, isDark ? 0.62 : 0.66) }
    /// The card a list's rows sit on over the ground: the first of surface and raised that rises
    /// a step off it. ah's own surface does; an Omarchy theme's (its dark_background) sits below
    /// the ground, so its rows take the lighter background. A theme with neither (raised falls
    /// back to the foreground) gets a card mixed from its ground.
    var card: String {
        [surface, raised].first { rises($0, over: background) } ?? Self.mix(background, isDark ? text : "#ffffff", isDark ? 0.06 : 0.6)
    }
    /// A tile on a card (an agent's mark): raised, or a step above the card when raised is the
    /// card itself or no step at all.
    var tile: String {
        let darkJump = isDark && Self.luminance(raised) > Self.luminance(card) + Self.step
        return raised != card && !darkJump ? raised : Self.mix(card, isDark ? text : "#000000", isDark ? 0.08 : 0.05)
    }

    /// How far a dark layer may rise over the one below it and still read as a layer.
    private static let step = 0.08
    private func rises(_ layer: String, over ground: String) -> Bool {
        let l = Self.luminance(layer), g = Self.luminance(ground)
        return l > g && (!isDark || l < g + Self.step)
    }

    /// The relative luminance of "#rrggbb" (WCAG), 0 for anything unreadable.
    static func luminance(_ hex: String) -> Double {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst().prefix(6)) : String(hex.prefix(6))
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return 0 }
        let channel = { (shift: UInt32) -> Double in
            let c = Double((value >> shift) & 0xff) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    /// "#rrggbb" a fraction of the way from one color to another.
    static func mix(_ from: String, _ to: String, _ t: Double) -> String {
        func rgb(_ hex: String) -> [Double] {
            let digits = hex.hasPrefix("#") ? String(hex.dropFirst().prefix(6)) : String(hex.prefix(6))
            let value = UInt32(digits, radix: 16) ?? 0
            return [16, 8, 0].map { Double((value >> UInt32($0)) & 0xff) }
        }
        let mixed = zip(rgb(from), rgb(to)).map { Int(($0 + ($1 - $0) * t).rounded()) }
        return String(format: "#%02x%02x%02x", mixed[0], mixed[1], mixed[2])
    }

    /// A fill the system's white words and glyphs read on (a row's swipe actions): the color
    /// itself where white on it reaches 4.5:1, else darkened until it does. A dark palette's
    /// statuses are pale (salmon, amber, mint) to read on its dark ground, and white on them
    /// was under 2.3:1.
    static func underWhite(_ hex: String) -> String {
        var color = String(hex.prefix(7))
        var t = 0.0
        while contrastWithWhite(color) < 4.5, t < 0.9 {
            t += 0.05
            color = mix(hex, "#000000", t)
        }
        return color
    }

    static func contrastWithWhite(_ hex: String) -> Double { 1.05 / (luminance(hex) + 0.05) }

    /// "#rrggbb" with an alpha: "#rrggbbaa".
    static func alpha(_ hex: String, _ a: Double) -> String {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst().prefix(6)) : String(hex.prefix(6))
        return "#" + digits + String(format: "%02x", Int((a * 255).rounded()))
    }
}

/// The terminal's 16 colors plus ground, cursor and selection.
struct TerminalPalette: Equatable, Sendable {
    var background: String
    var foreground: String
    var cursor: String
    var selection: String
    /// black, red, green, yellow, blue, magenta, cyan, white, then the bright eight.
    var ansi: [String]

    /// A dark background (relative luminance under a half): bars over it go dark too.
    var isDark: Bool {
        let hex = background.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard hex.count == 6, UInt32(hex, radix: 16) != nil else { return true }
        return ThemePalette.luminance(background) < 0.5
    }

    // ah's sunken ground: the terminal sits in its panel like a code block.
    static let dark = TerminalPalette(
        background: "#15161f", foreground: "#e6e6ef", cursor: "#f47199", selection: "#3a3d55",
        ansi: ["#15161f", "#ff8a80", "#81d88a", "#f5b84b", "#82aaff", "#f47199", "#4dd9ea", "#c9cad3",
               "#5c5f77", "#ffa49c", "#a4e6ab", "#ffd27f", "#a6c3ff", "#ff9fbe", "#86e8f3", "#ffffff"]
    )

    static let light = TerminalPalette(
        background: "#fbfbfd", foreground: "#1c1d27", cursor: "#c2185b", selection: "#d6d8e3",
        ansi: ["#1c1d27", "#c62828", "#276b2b", "#8a5a00", "#1d4fb8", "#c2185b", "#00737d", "#5f6272",
               "#686b7a", "#e53935", "#2e7d32", "#a66d00", "#2962ff", "#d81b60", "#00838f", "#1c1d27"]
    )

    /// The way Omarchy maps colors.toml for its own terminals (`omarchyTerminal`).
    static func omarchy(_ theme: OmarchyTheme) -> TerminalPalette {
        let c = theme.colors
        let fg = c["foreground"] ?? "#ffffff"
        let bg = c["background"] ?? "#000000"
        func or(_ k: String, _ f: String) -> String { c[k] ?? c[f] ?? fg }
        return TerminalPalette(
            background: bg, foreground: fg, cursor: or("bright_foreground", "foreground"), selection: or("selection", "lighter_background"),
            ansi: [bg, or("red", "foreground"), or("green", "foreground"), or("yellow", "foreground"), or("blue", "foreground"), or("magenta", "foreground"), or("cyan", "foreground"), fg,
                   or("muted", "dark_foreground"), or("bright_red", "red"), or("bright_green", "green"), or("bright_yellow", "yellow"), or("bright_blue", "blue"), or("bright_magenta", "magenta"), or("bright_cyan", "cyan"), or("bright_foreground", "foreground")]
        )
    }
}

/// "#rrggbb" or "#rrggbbaa" to 0…1 components; nil when malformed.
func hexComponents(_ hex: String) -> (r: Double, g: Double, b: Double, a: Double)? {
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard digits.count == 6 || digits.count == 8, let value = UInt64(digits, radix: 16) else { return nil }
    if digits.count == 6 {
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255, 1)
    }
    return (Double((value >> 24) & 0xFF) / 255, Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
}
