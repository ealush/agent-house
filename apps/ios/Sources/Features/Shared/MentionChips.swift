import SwiftUI
import UIKit

/// An @file's chip, wherever it's drawn: in the box as you type (`ComposerTextView`), in an
/// agent's selectable words (`ProseTextView`) and in your sent message (`MentionChipRenderer`).
/// A tinted fill with a border off the letters, the same room on every side, round corners. A
/// chip has only the room its letters take: nothing in the line moves for it.
enum MentionChip {
    static let radius: CGFloat = 6

    /// Whether a link in rendered markdown is a chip's: an @file, a #session, a pull request's review.
    static func isChip(_ url: String) -> Bool {
        url.hasPrefix(Mentions.scheme) || url.hasPrefix(SessionMentions.scheme) || url.hasPrefix(PullLinks.scheme)
    }
    static let fill: CGFloat = 0.12
    static let border: CGFloat = 0.4

    /// The room inside a chip, round its letters (and the composer's ×): little enough that
    /// chips on lines one under the other barely meet.
    static func pad(_ size: CGFloat) -> CGFloat { size * 0.12 + 1 }

    /// The composer's chip is wider at its sides than over and under its letters (the ×
    /// crowded its edge): the letters make that room, the @ kerned for twice it and the name's
    /// last letter for once (`ComposerTextView.styleMentions`), so the line moves aside for it.
    static func extra(_ size: CGFloat) -> CGFloat { size * 0.16 }
    static func side(_ size: CGFloat) -> CGFloat { pad(size) + extra(size) }

    /// Between two chips side by side, a little more than a space: two boxes that meet read as
    /// one.
    static func gap(_ size: CGFloat) -> CGFloat { size * 0.3 }

    /// How far a first letter's ink starts past its advance, and a last letter's ends short of
    /// it: about a sixteenth of the size in Rubik ("@" 0.061, "g" 0.082).
    static func bearing(_ size: CGFloat) -> CGFloat { size * 0.06 }

    /// How far a chip reaches past its letters' advance into the space beside it: what that
    /// space gets back as kerning in sent words, so a chip stands a space from its neighbours.
    static func reach(_ size: CGFloat) -> CGFloat { pad(size) - bearing(size) }

    /// A chip's box on one line, its letters' ink from `left` to `right` on `baseline`: from the
    /// capitals' tops to the descenders' bottoms (a line's own box has the font's ascent over
    /// the capitals, and next to nothing under a "g"), with the room round it. The border is
    /// drawn inside the box, so it's room too.
    /// `side`: the room left and right, when it isn't `pad` (the composer's).
    static func box(baseline: CGFloat, left: CGFloat, right: CGFloat, font: UIFont, side: CGFloat? = nil) -> CGRect {
        let pad = pad(font.pointSize)
        let side = side ?? pad
        let top = baseline - font.capHeight - pad
        let bottom = baseline - font.descender * 0.97 + pad
        return CGRect(x: left - side, y: top, width: right - left + 2 * side, height: bottom - top)
    }

    /// The leading between lines of text that can hold chips. A chip stands past its line, over
    /// the capitals and under the descenders, so chips on lines one under the other met, and the
    /// caret on a line ran into the chip under it: as much as they reach past their lines, and a
    /// little more to keep them apart.
    static func leading(_ font: UIFont) -> CGFloat {
        let pad = pad(font.pointSize)
        let over = max(0, pad - (font.ascender - font.capHeight))
        let under = max(0, pad + font.descender * 0.03)
        return (over + under + font.pointSize * 0.2).rounded()
    }

    /// The baseline of a line of text in `font`, from the line's rect: the font's line sits in
    /// the middle of the text's line. A rect that takes in the line's `leading` too (it's added
    /// under the letters) is measured without it.
    static func baseline(_ line: CGRect, font: UIFont, leading: CGFloat = 0) -> CGFloat {
        let face = font.ascender - font.descender
        let height = leading > 0 && line.height - leading >= face - 1 ? line.height - leading : line.height
        return line.minY + (height - face) / 2 + font.ascender
    }

    /// A chip to lay behind a text view's letters.
    @MainActor
    static func view(_ frame: CGRect, tint: UIColor) -> UIView {
        let chip = UIView(frame: frame)
        chip.isUserInteractionEnabled = false
        chip.backgroundColor = tint.withAlphaComponent(fill)
        chip.layer.cornerRadius = radius
        chip.layer.cornerCurve = .continuous
        chip.layer.borderWidth = 1
        chip.layer.borderColor = tint.withAlphaComponent(border).cgColor
        return chip
    }
}

extension UITextView {
    /// A range's letters on each line it's on: as wide as they are (a selection's rect for a
    /// line it wraps from runs on to the line's end).
    func chipLines(_ range: NSRange) -> [CGRect] {
        var lines: [CGRect] = []
        var from = 0
        var y: CGFloat?
        for i in 0...range.length {
            let here = i < range.length ? position(from: beginningOfDocument, offset: range.location + i).map { caretRect(for: $0).midY } : nil
            if i > 0, i == range.length || here.map({ abs($0 - (y ?? $0)) > 1 }) == true {
                if let a = position(from: beginningOfDocument, offset: range.location + from),
                   let b = position(from: beginningOfDocument, offset: range.location + i),
                   let span = textRange(from: a, to: b) {
                    let rect = firstRect(for: span)
                    if !rect.isNull, !rect.isInfinite, rect.width > 0 { lines.append(rect) }
                }
                from = i
            }
            if let here { y = here }
        }
        return lines
    }
}

/// Marks an @file's words in a `Text` for `MentionChipRenderer`.
struct MentionChipAttribute: TextAttribute {}

/// Draws a chip behind each run marked `MentionChipAttribute`, then the text: SwiftUI's own
/// background on a run is a square band as tall as the line, with no room round the letters.
struct MentionChipRenderer: TextRenderer {
    let font: UIFont
    let tint: Color

    var displayPadding: EdgeInsets {
        let room = MentionChip.pad(font.pointSize) + 1
        return EdgeInsets(top: room, leading: room, bottom: room, trailing: room)
    }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let bearing = MentionChip.bearing(font.pointSize)
        for line in layout {
            // A mention's runs on this line (a bold word inside it is a run of its own).
            var ink: (left: CGFloat, right: CGFloat, baseline: CGFloat)?
            func chip() {
                guard let found = ink else { return }
                ink = nil
                let box = MentionChip.box(baseline: found.baseline, left: found.left, right: found.right, font: font)
                let shape = RoundedRectangle(cornerRadius: MentionChip.radius, style: .continuous)
                context.fill(shape.path(in: box), with: .color(tint.opacity(MentionChip.fill)))
                context.stroke(shape.path(in: box.insetBy(dx: 0.5, dy: 0.5)), with: .color(tint.opacity(MentionChip.border)), lineWidth: 1)
            }
            for run in line {
                guard run[MentionChipAttribute.self] != nil else {
                    chip()
                    continue
                }
                let bounds = run.typographicBounds
                let rect = bounds.rect
                if let found = ink {
                    ink = (found.left, rect.maxX - bearing, found.baseline)
                } else {
                    ink = (rect.minX + bearing, rect.maxX - bearing, bounds.origin.y)
                }
            }
            chip()
        }
        for line in layout { context.draw(line) }
    }
}
