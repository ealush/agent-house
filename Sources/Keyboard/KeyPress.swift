import Foundation

/// A hardware key press as UIKit reports it (`UIKey`): the USB HID usage of the physical
/// key, the characters the layout produces without modifiers, and the modifiers held.
/// Platform code fills it in; matching stays here so it's tested off-device.
struct KeyPress: Equatable, Sendable {
    struct Modifiers: OptionSet, Hashable, Sendable {
        let rawValue: Int
        static let command = Modifiers(rawValue: 1 << 0)
        static let control = Modifiers(rawValue: 1 << 1)
        static let option = Modifiers(rawValue: 1 << 2)
        static let shift = Modifiers(rawValue: 1 << 3)
    }

    /// UIKeyboardHIDUsage raw value (USB HID usage page 7).
    var hidUsage: Int
    /// `UIKey.charactersIgnoringModifiers`: what the layout produces (Colemak's "k" for its K key).
    var characters: String
    var modifiers: Modifiers

    init(hidUsage: Int, characters: String, modifiers: Modifiers) {
        self.hidUsage = hidUsage
        self.characters = characters
        self.modifiers = modifiers
    }

    /// HID usages of keys with a fixed name, whatever the layout says.
    static let named: [Int: String] = [
        0x28: "Enter", 0x58: "Enter", 0x29: "Escape", 0x2A: "Backspace", 0x2B: "Tab", 0x2C: " ",
        0x4F: "ArrowRight", 0x50: "ArrowLeft", 0x51: "ArrowDown", 0x52: "ArrowUp",
        0x4A: "Home", 0x4B: "PageUp", 0x4C: "Delete", 0x4D: "End", 0x4E: "PageDown",
    ]

    /// Digits by position: Shift+1 is still "1", never "!".
    static let digits: [Int: String] = [
        0x1E: "1", 0x1F: "2", 0x20: "3", 0x21: "4", 0x22: "5", 0x23: "6", 0x24: "7", 0x25: "8", 0x26: "9", 0x27: "0",
    ]

    /// Punctuation by position (the web's KeyboardEvent.code table).
    static let punctuation: [Int: String] = [
        0x2D: "-", 0x2E: "=", 0x2F: "[", 0x30: "]", 0x31: "\\", 0x33: ";", 0x34: "'", 0x35: "`", 0x36: ",", 0x37: ".", 0x38: "/",
    ]

    /// Modifier keys alone never make a chord.
    static let modifierUsages: Set<Int> = [0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7]

    /// The web's `eventKey`: digits and punctuation by position, named keys by name, letters as produced.
    var key: String? {
        if let digit = Self.digits[hidUsage] { return digit }
        if let name = Self.named[hidUsage] { return name }
        if let mark = Self.punctuation[hidUsage], characters.count == 1 { return mark }
        guard let first = characters.first else { return nil }
        if characters.count == 1 { return String(first).lowercased() }
        return characters
    }

    var chord: Chord? {
        guard !Self.modifierUsages.contains(hidUsage), let key else { return nil }
        return Chord(key, meta: modifiers.contains(.command), ctrl: modifiers.contains(.control), alt: modifiers.contains(.option), shift: modifiers.contains(.shift))
    }
}

/// Terminal bytes for the touch key bar and physical keys (`../ah/web/keyboard.ts`,
/// `web/KeyBar.tsx`): the same sequences the web terminal sends.
enum TerminalKeys {
    private static let unshifted = Array("`1234567890-=[]\\;',./")
    private static let shifted = Array("~!@#$%^&*()_+{}|:\"<>?")

    /// The key bar, in order: label, bytes, accessibility name.
    static let bar: [(label: String, bytes: String, name: String)] = [
        ("esc", "\u{1b}", "Escape"), ("tab", "\t", "Tab"), ("⇧tab", "\u{1b}[Z", "Shift+Tab"),
        ("↑", "\u{1b}[A", "Up"), ("↓", "\u{1b}[B", "Down"), ("←", "\u{1b}[D", "Left"), ("→", "\u{1b}[C", "Right"),
    ]

    /// Sticky one-shot modifiers on a key's bytes (`applyModifiers`).
    static func applyModifiers(_ data: String, ctrl: Bool, alt: Bool, shift: Bool = false) -> String {
        let modifiers = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0)
        let scalars = Array(data.unicodeScalars)
        let letters: Set<Character> = ["A", "B", "C", "D", "H", "F"]
        // ESC [ X or ESC O X: a cursor key.
        var cursor: Character?
        var existing = 0
        if scalars.count == 3, scalars[0] == "\u{1b}", scalars[1] == "[" || scalars[1] == "O", letters.contains(Character(scalars[2])) {
            cursor = Character(scalars[2])
        } else if data.hasPrefix("\u{1b}[1;"), let last = data.last, letters.contains(last), let n = Int(data.dropFirst(4).dropLast()) {
            cursor = last
            existing = n - 1
        }
        if modifiers != 0, let letter = cursor {
            // Sticky Alt matches physical Option: Left/Right move by word.
            if alt && !ctrl && !shift && (letter == "D" || letter == "C") { return letter == "D" ? "\u{1b}b" : "\u{1b}f" }
            return "\u{1b}[1;\(1 + (existing | modifiers))\(letter)"
        }
        var out = data
        if shift {
            if out == "\t" { out = "\u{1b}[Z" }
            else if out == "\r" { out = "\n" } // agent multiline input (Ctrl+J)
            else if out.count == 1, let c = out.first {
                if let i = unshifted.firstIndex(of: c) { out = String(shifted[i]) } else { out = out.uppercased() }
            }
        }
        if ctrl, out.count == 1, let scalar = out.uppercased().unicodeScalars.first {
            if (64...95).contains(scalar.value) { out = String(UnicodeScalar(UInt8(scalar.value - 64))) }
            else if out == " " { out = "\u{0}" }
        }
        if alt { out = "\u{1b}" + out }
        return out
    }

    /// Physical arrows inside the terminal (`terminalArrow`): Command+Left/Right seek line
    /// ends, Option+Left/Right seek words. Everything else stays with the emulator.
    static func arrow(_ key: String, meta: Bool, alt: Bool, ctrl: Bool, shift: Bool) -> String? {
        guard !shift && !ctrl else { return nil }
        switch key {
        case "ArrowLeft": return meta ? "\u{1b}[H" : alt ? "\u{1b}b" : nil
        case "ArrowRight": return meta ? "\u{1b}[F" : alt ? "\u{1b}f" : nil
        default: return nil
        }
    }

    /// A paste for a terminal: bracketed when the application asked for it (ESC[?2004h).
    static func paste(_ text: String, bracketed: Bool) -> String {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r")
        return bracketed ? "\u{1b}[200~" + normalized + "\u{1b}[201~" : normalized
    }
}

/// Step through sidebar-ordered session keys with wrap-around (`cycleKey`).
func cycleKey<K: Equatable>(_ keys: [K], anchor: K?, direction: Int) -> K? {
    guard !keys.isEmpty else { return nil }
    guard let anchor, let i = keys.firstIndex(of: anchor) else { return direction > 0 ? keys.first : keys.last }
    return keys[(i + direction + keys.count) % keys.count]
}
