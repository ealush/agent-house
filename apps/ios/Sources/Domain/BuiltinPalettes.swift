import Foundation

/// Palettes the app carries, for a look of one's own without a host's Omarchy theme: the
/// editor and terminal schemes people already live in, each given in Omarchy's colors.toml
/// vocabulary and mapped the way a host's theme is (`ThemePalette.omarchy`), so ah's layers,
/// status colors and terminal come out of each the same way.
struct BuiltinPalette: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let palette: ThemePalette

    static let all: [BuiltinPalette] = [
        dark("tokyo-night", "Tokyo Night", bg: "#1a1b26", dark: "#16161e", darker: "#13131a", lighter: "#292e42", selection: "#283457",
             fg: "#c0caf5", bright: "#c0caf5", dim: "#565f89", accent: "#7aa2f7",
             red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff"),
        dark("catppuccin-mocha", "Catppuccin Mocha", bg: "#1e1e2e", dark: "#181825", darker: "#11111b", lighter: "#313244", selection: "#45475a",
             fg: "#cdd6f4", bright: "#cdd6f4", dim: "#6c7086", accent: "#cba6f7",
             red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5"),
        light("catppuccin-latte", "Catppuccin Latte", bg: "#eff1f5", dark: "#e6e9ef", darker: "#dce0e8", lighter: "#ccd0da", selection: "#bcc0cc",
              fg: "#4c4f69", bright: "#4c4f69", dim: "#9ca0b0", accent: "#8839ef",
              red: "#d20f39", green: "#40a02b", yellow: "#df8e1d", blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299"),
        dark("nord", "Nord", bg: "#2e3440", dark: "#272c36", darker: "#242933", lighter: "#3b4252", selection: "#434c5e",
             fg: "#d8dee9", bright: "#eceff4", dim: "#616e88", accent: "#88c0d0",
             red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#8fbcbb"),
        dark("dracula", "Dracula", bg: "#282a36", dark: "#21222c", darker: "#1e1f29", lighter: "#44475a", selection: "#44475a",
             fg: "#f8f8f2", bright: "#ffffff", dim: "#6272a4", accent: "#bd93f9",
             red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd"),
        dark("gruvbox-dark", "Gruvbox Dark", bg: "#282828", dark: "#1d2021", darker: "#1d2021", lighter: "#3c3836", selection: "#504945",
             fg: "#ebdbb2", bright: "#fbf1c7", dim: "#928374", accent: "#fabd2f",
             red: "#fb4934", green: "#b8bb26", yellow: "#fabd2f", blue: "#83a598", magenta: "#d3869b", cyan: "#8ec07c"),
        light("gruvbox-light", "Gruvbox Light", bg: "#fbf1c7", dark: "#f2e5bc", darker: "#ebdbb2", lighter: "#ebdbb2", selection: "#d5c4a1",
              fg: "#3c3836", bright: "#282828", dim: "#928374", accent: "#d65d0e",
              red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588", magenta: "#b16286", cyan: "#689d6a"),
        dark("solarized-dark", "Solarized Dark", bg: "#002b36", dark: "#00212b", darker: "#001e26", lighter: "#073642", selection: "#073642",
             fg: "#93a1a1", bright: "#eee8d5", dim: "#586e75", accent: "#268bd2",
             red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198"),
        light("solarized-light", "Solarized Light", bg: "#fdf6e3", dark: "#eee8d5", darker: "#e8e1cd", lighter: "#eee8d5", selection: "#e0dbc6",
              fg: "#586e75", bright: "#073642", dim: "#93a1a1", accent: "#268bd2",
              red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198"),
        dark("one-dark", "One Dark", bg: "#282c34", dark: "#21252b", darker: "#1e2227", lighter: "#3e4451", selection: "#3e4451",
             fg: "#abb2bf", bright: "#dcdfe4", dim: "#5c6370", accent: "#61afef",
             red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2"),
        dark("monokai", "Monokai", bg: "#272822", dark: "#1e1f1c", darker: "#1b1c18", lighter: "#3e3d32", selection: "#49483e",
             fg: "#f8f8f2", bright: "#ffffff", dim: "#75715e", accent: "#a6e22e",
             red: "#f92672", green: "#a6e22e", yellow: "#e6db74", blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4"),
        dark("github-dark", "GitHub Dark", bg: "#0d1117", dark: "#010409", darker: "#010409", lighter: "#161b22", selection: "#264f78",
             fg: "#c9d1d9", bright: "#f0f6fc", dim: "#8b949e", accent: "#58a6ff",
             red: "#ff7b72", green: "#3fb950", yellow: "#d29922", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf"),
        dark("rose-pine", "Rosé Pine", bg: "#191724", dark: "#1f1d2e", darker: "#16141f", lighter: "#26233a", selection: "#403d52",
             fg: "#e0def4", bright: "#e0def4", dim: "#6e6a86", accent: "#c4a7e7",
             red: "#eb6f92", green: "#31748f", yellow: "#f6c177", blue: "#9ccfd8", magenta: "#c4a7e7", cyan: "#ebbcba"),
        dark("everforest", "Everforest", bg: "#2d353b", dark: "#272e33", darker: "#232a2e", lighter: "#3d484d", selection: "#475258",
             fg: "#d3c6aa", bright: "#d3c6aa", dim: "#859289", accent: "#a7c080",
             red: "#e67e80", green: "#a7c080", yellow: "#dbbc7f", blue: "#7fbbb3", magenta: "#d699b6", cyan: "#83c092"),
        dark("kanagawa", "Kanagawa", bg: "#1f1f28", dark: "#16161d", darker: "#16161d", lighter: "#2a2a37", selection: "#363646",
             fg: "#dcd7ba", bright: "#dcd7ba", dim: "#727169", accent: "#7e9cd8",
             red: "#c34043", green: "#76946a", yellow: "#c0a36e", blue: "#7e9cd8", magenta: "#957fb8", cyan: "#6a9589"),
    ]

    static func named(_ id: String) -> BuiltinPalette? { all.first { $0.id == id } }

    private static func dark(_ id: String, _ name: String, bg: String, dark: String, darker: String, lighter: String, selection: String, fg: String, bright: String, dim: String, accent: String, red: String, green: String, yellow: String, blue: String, magenta: String, cyan: String) -> BuiltinPalette {
        make(id, name, mode: "dark", bg: bg, dark: dark, darker: darker, lighter: lighter, selection: selection, fg: fg, bright: bright, dim: dim, accent: accent, red: red, green: green, yellow: yellow, blue: blue, magenta: magenta, cyan: cyan)
    }

    private static func light(_ id: String, _ name: String, bg: String, dark: String, darker: String, lighter: String, selection: String, fg: String, bright: String, dim: String, accent: String, red: String, green: String, yellow: String, blue: String, magenta: String, cyan: String) -> BuiltinPalette {
        make(id, name, mode: "light", bg: bg, dark: dark, darker: darker, lighter: lighter, selection: selection, fg: fg, bright: bright, dim: dim, accent: accent, red: red, green: green, yellow: yellow, blue: blue, magenta: magenta, cyan: cyan)
    }

    private static func make(_ id: String, _ name: String, mode: String, bg: String, dark: String, darker: String, lighter: String, selection: String, fg: String, bright: String, dim: String, accent: String, red: String, green: String, yellow: String, blue: String, magenta: String, cyan: String) -> BuiltinPalette {
        let theme = OmarchyTheme(name: name, mode: mode, colors: [
            "background": bg, "dark_background": dark, "darker_background": darker, "lighter_background": lighter, "selection": selection,
            "foreground": fg, "bright_foreground": bright, "dark_foreground": dim, "muted": dim, "accent": accent,
            "red": red, "green": green, "yellow": yellow, "blue": blue, "magenta": magenta, "cyan": cyan,
        ], font: nil)
        // Every entry names the essentials, so the mapping never comes back empty.
        return BuiltinPalette(id: id, name: name, palette: ThemePalette.omarchy(theme) ?? (mode == "light" ? .light : .dark))
    }
}
