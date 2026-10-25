import Foundation

/// A key pressed while a waiting agent's answer controls have the keyboard
/// (`../ah/web/AskPanel.tsx`): digits pick, arrows and Tab move, Space and Return choose the
/// row, ⌘Return sends the form, Esc goes back to the input. Anything else (⌘K…) is the
/// window's.
enum AskKey: Equatable, Sendable {
    case up, down, left, right
    /// Space or Return: the row the cursor is on.
    case choose
    /// ⌘Return: send the form.
    case submit
    /// Esc: back to the composer or terminal.
    case leave
    case digit(Int)
    /// A row's own hotkey ("(y)es").
    case letter(String)

    init?(_ press: KeyPress) {
        let plain = press.modifiers.isEmpty
        switch press.key {
        case "Enter" where press.modifiers == [.command]: self = .submit
        case "Enter" where plain, " " where plain: self = .choose
        case "ArrowUp" where plain: self = .up
        case "ArrowDown" where plain: self = .down
        case "ArrowLeft" where plain: self = .left
        case "ArrowRight" where plain: self = .right
        case "Tab" where plain: self = .down
        case "Tab" where press.modifiers == [.shift]: self = .up
        case "Escape" where plain: self = .leave
        case let key? where plain:
            if let digit = Int(key), (1...9).contains(digit) {
                self = .digit(digit)
            } else if key.count == 1, key.first?.isLetter == true {
                self = .letter(key)
            } else {
                return nil
            }
        default:
            return nil
        }
    }
}
