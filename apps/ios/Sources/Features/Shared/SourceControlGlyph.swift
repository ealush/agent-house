import SwiftUI

/// A session's source control at a glance (`SourceControlMark`): a small amber dot for
/// uncommitted changes, and its pull request's arrows, faint while open, fainter as a draft, red
/// when its checks fail, green once merged. Beside a row's time, on the Commits chip, by a
/// branch in the Commits list.
struct SourceControlGlyph: View {
    let mark: SourceControlMark
    /// On a selected row's accent fill: white, as the row's other marks go.
    var onAccent = false
    @ScaledMetric(relativeTo: .caption2) private var dot: CGFloat = 6
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 3) {
            if mark.dirty > 0 {
                Circle().fill(onAccent ? AnyShapeStyle(.white.opacity(0.8)) : AnyShapeStyle(theme.limited)).frame(width: dot, height: dot)
            }
            if let pull = mark.pull {
                Image(systemName: pull.symbol)
                    .font(.ah(.caption2).weight(.semibold))
                    .foregroundStyle(onAccent ? AnyShapeStyle(.white.opacity(0.8)) : AnyShapeStyle(color(pull)))
                    .opacity(pull == .draft ? 0.55 : 1)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mark.spoken)
        .accessibilityIdentifier("scm")
    }

    private func color(_ pull: SourceControlMark.Pull) -> Color {
        switch pull {
        case .open, .draft: theme.faint
        case .failing: theme.danger
        case .merged: theme.done
        }
    }
}
