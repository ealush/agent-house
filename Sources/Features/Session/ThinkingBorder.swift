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
                    let gradient = comet(at: .degrees((t / Self.lap).truncatingRemainder(dividingBy: 1) * 360))
                    // A glow under the light, then the light itself.
                    shape.strokeBorder(gradient, lineWidth: dark ? 5 : 4).blur(radius: dark ? 6 : 5).opacity(dark ? 1 : 0.85)
                    shape.strokeBorder(gradient, lineWidth: 2)
                }
            }
            .blendMode(dark ? .plusLighter : .normal)
        }
        .opacity(active ? 1 : 0)
        .animation(.easeInOut(duration: 0.45), value: active)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// A light with a fading tail, from the theme's accent into its brand.
    private func comet(at angle: Angle) -> AngularGradient {
        AngularGradient(
            stops: [
                .init(color: theme.accent.opacity(0), location: 0),
                .init(color: theme.accent.opacity(0), location: 0.5),
                .init(color: theme.accent.opacity(0.75), location: 0.82),
                .init(color: theme.brand, location: 0.96),
                .init(color: theme.brand.opacity(0), location: 1),
            ],
            center: .center,
            angle: angle
        )
    }
}
