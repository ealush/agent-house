import SwiftUI

// ah's design system, the pieces every page shares (claude.ai design "ah": LargeTitle,
// SectionHeader, the page's ground and surfaces).

/// A root page's title with the brand's full stop ("Inbox."), and the line that states the
/// page under it.
struct AhLargeTitle: View {
    let title: String
    var tagline: String? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            (Text(title).foregroundStyle(theme.text) + Text(".").foregroundStyle(theme.brand))
                .font(.ah(.largeTitle))
                .tracking(-0.6)
                .accessibilityAddTraits(.isHeader)
                .accessibilityLabel(title)
            if let tagline, !tagline.isEmpty {
                Text(tagline).font(.custom(AhType.ui, size: 17, relativeTo: .headline)).foregroundStyle(theme.text2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
        .padding(.bottom, 6)
    }
}

/// A list section's overline: small tracked capitals, a count, and the brand's underline.
struct AhSectionHeader: View {
    let title: String
    var count: Int? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title.uppercased()).font(.ah(.caption).weight(.semibold)).tracking(1.1).foregroundStyle(theme.text)
            if let count { Text("\(count)").font(.ah(.caption)).foregroundStyle(theme.faint) }
        }
        .padding(.bottom, 6)
        .overlay(alignment: .bottomLeading) { Capsule().fill(theme.brand).frame(height: 2).frame(maxWidth: .infinity) }
        .fixedSize()
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A root page in ah's layers: rows on the panel's surface over the ground, the large title
/// in the content, and the bar left to its buttons.
struct AhPage: ViewModifier {
    let title: String
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            // A phone's page is the ground; an iPad's sits in the main panel.
            .background(sizeClass == .compact ? theme.background : theme.surface)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            // The title lives in the page (with its full stop); the bar keeps only its buttons.
            .toolbar { ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) } }
    }
}

extension View {
    func ahPage(_ title: String) -> some View { modifier(AhPage(title: title)) }

    /// A row on the theme's card (lists on ah's ground), its separators in the theme's hairline.
    /// Off, the row keeps the list's own ground (an iPad sidebar's glass).
    func ahRow(_ on: Bool = true) -> some View { modifier(AhRowGround(on: on)) }
}

/// A form in ah's layers: on the page's ground, its rows on the theme's card.
struct AhForm<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        Form { Group { content }.ahRow() }.ahFormGround()
    }
}

private struct AhFormGround: ViewModifier {
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(sizeClass == .compact ? theme.background : theme.surface)
    }
}

extension View {
    /// What `AhForm` puts behind a form, for a list that reads as one.
    func ahFormGround() -> some View { modifier(AhFormGround()) }
}

private struct AhRowGround: ViewModifier {
    let on: Bool
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass
    func body(content: Content) -> some View {
        if on {
            content
                .listRowBackground(sizeClass == .compact ? theme.card : theme.raised)
                .listRowSeparatorTint(theme.line)
        } else {
            content
        }
    }
}

/// ah's main panel on a big screen: the surface, rounded, inset from the window over the
/// ground (a phone's content fills the screen).
struct AhPanel: ViewModifier {
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        if sizeClass == .compact {
            content
        } else {
            content
                .background(theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(theme.line, lineWidth: 1))
                .shadow(color: theme.shadow, radius: 20, y: 10)
                .padding(8)
        }
    }
}
