import Foundation

/// How far the on-screen keyboard pushes a window's bottom bar up (`KeyboardFrame`), from the
/// keyboard's frame and the window's, in the window's coordinates.
enum KeyboardRise {
    /// Only a keyboard docked along the window's bottom, across its width, takes room from it.
    /// A floating one (the small iPad keyboard, or the pill iPadOS leaves in a corner with a
    /// hardware keyboard attached) reports a frame too: counted, it lifted the screen by
    /// however far that frame reached up, leaving a gap under the box with nothing in it, or
    /// the box in the middle of the screen.
    static func rise(keyboard: CGRect, window: CGRect, safeBottom: CGFloat) -> CGFloat {
        guard !keyboard.isNull, keyboard.width > 0, keyboard.height > 0 else { return 0 }
        let docked = keyboard.minX <= window.minX + 1 && keyboard.maxX >= window.maxX - 1 && keyboard.maxY >= window.maxY - 1
        guard docked else { return 0 }
        let overlap = max(0, window.maxY - keyboard.minY)
        return max(0, overlap - safeBottom)
    }
}
