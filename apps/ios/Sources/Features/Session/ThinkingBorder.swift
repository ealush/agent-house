import SwiftUI

/// While the agent works, a soft light runs around the composer's edge, the way Apple
/// Intelligence's glow does: the box itself says a turn is under way, wherever the eye is.
/// It draws over the glass and takes no room or touches, so the bar never changes height. With
/// Reduce Motion the light stays put and breathes instead.
struct ThinkingBorder: View {
    let corner: CGFloat
    let active: Bool
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    /// One turn around the box.
    private static let lap: TimeInterval = 2.6

    var body: some View {
        // Paused (and drawing nothing) when idle: no frames are spent on a box at rest.
        TimelineView(.animation(minimumInterval: 1 / 60, paused: !active)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let shape = RoundedRectangle(cornerRadius: corner, style: .continuous)
            // Dark glass swallows a tinted line: there it's brighter, and adds light.
            let dark = scheme == .dark
            ZStack {
                // The whole edge, faintly lit.
                shape.strokeBorder(theme.accent.opacity(dark ? 0.45 : 0.3), lineWidth: 1)
                if reduceMotion {
                    shape.strokeBorder(theme.accent, lineWidth: 1.5)
                        .opacity(0.35 + 0.35 * (0.5 + 0.5 * sin(t * 2 * .pi / Self.lap)))
                } else {
                    // Along the edge at one speed: placed by the share of the way round, not by
                    // its angle from the middle (turned at a steady angle, it crawled along the
                    // long top and bottom of a wide box and sped round its ends).
                    let head = (t / Self.lap).truncatingRemainder(dividingBy: 1)
                    // A close glow under the light, then the light itself: a thin bright line,
                    // not a wash spread out from the edge.
                    comet(shape, head: head, width: dark ? 3 : 2.5).blur(radius: dark ? 2.5 : 2).opacity(dark ? 0.9 : 0.75)
                    comet(shape, head: head, width: 1.5)
                }
            }
            .blendMode(dark ? .plusLighter : .normal)
        }
        .opacity(active ? 1 : 0)
        .animation(.easeInOut(duration: 0.45), value: active)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// How much of the way round the tail reaches, and in how many pieces it fades.
    private static let tail = 0.25
    private static let pieces = 20

    /// A light with a short fading tail (a quarter of the way round), from the theme's accent
    /// into its brand: pieces of the edge itself, each a little fainter than the one ahead,
    /// measured along the edge's length so every part of it moves at the same speed.
    private func comet(_ shape: RoundedRectangle, head: Double, width: CGFloat) -> some View {
        ZStack {
            ForEach(0..<Self.pieces, id: \.self) { piece in
                let near = Double(piece) / Double(Self.pieces), far = Double(piece + 1) / Double(Self.pieces)
                // Brand at the head, fading through the accent to nothing at the tail's end.
                let color = near < 0.12 ? theme.brand : theme.accent.opacity(0.8 * pow(1 - near, 1.6))
                // Each a hair into the next, so no seam shows between them.
                Self.slice(shape, from: head - Self.tail * far, to: head - Self.tail * near + 0.0015, color: color, width: width)
            }
        }
    }

    /// The edge between two shares of the way round (inside it, as a border), in two parts
    /// where it crosses the point the outline starts from.
    @ViewBuilder
    private static func slice(_ shape: RoundedRectangle, from: Double, to: Double, color: Color, width: CGFloat) -> some View {
        let start = from - floor(from)
        let end = start + (to - from)
        let edge = shape.inset(by: width / 2)
        let style = StrokeStyle(lineWidth: width, lineCap: .butt)
        if end <= 1 {
            edge.trim(from: start, to: end).stroke(color, style: style)
        } else {
            edge.trim(from: start, to: 1).stroke(color, style: style)
            edge.trim(from: 0, to: end - 1).stroke(color, style: style)
        }
    }
}
