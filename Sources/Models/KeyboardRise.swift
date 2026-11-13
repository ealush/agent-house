import Foundation

/// How far the on-screen keyboard pushes a window's bottom bar up (`KeyboardFrame`), from the
/// keyboard's frame and the window's, in the window's coordinates.
enum KeyboardRise {
    /// Only a keyboard along the window's bottom takes room from it: one docked across its
    /// width, or the bar iPadOS floats along the bottom with a hardware keyboard while you type
    /// (a good part of the width, over the box). Something small reports a frame too: the pill
    /// that bar shrinks to in a corner, or the small floating keyboard; counted, they lifted the
    /// screen by however far that frame reached up, leaving a gap under the box with nothing
    /// in it, or the box in the middle of the screen.
    static func rise(keyboard: CGRect, window: CGRect, safeBottom: CGFloat) -> CGFloat {
        guard !keyboard.isNull, keyboard.width > 0, keyboard.height > 0 else { return 0 }
        let docked = keyboard.minX <= window.minX + 1 && keyboard.maxX >= window.maxX - 1 && keyboard.maxY >= window.maxY - 1
        let barAlongTheBottom = keyboard.width >= window.width / 3 && keyboard.maxY >= window.maxY - 100
        guard docked || barAlongTheBottom else { return 0 }
        let overlap = max(0, window.maxY - keyboard.minY)
        return max(0, overlap - safeBottom)
    }
}
