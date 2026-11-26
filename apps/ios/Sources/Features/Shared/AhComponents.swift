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
                    // Counts change in place, as numbers do, not as two sentences ghosting
                    // over each other.
                    .contentTransition(.numericText())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
        .padding(.bottom, 6)
    }
}

/// A list section's overline: small tracked capitals and a count.
struct AhSectionHeader: View {
    let title: String
    var count: Int? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title.uppercased()).font(.ah(.caption).weight(.semibold)).tracking(1.1).foregroundStyle(theme.text)
            if let count { Text("\(count)").font(.ah(.caption)).foregroundStyle(theme.faint).contentTransition(.numericText(value: Double(count))) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A round control that gives under the finger, as the system's own do: a touch shrinks it a
/// little, and letting go springs it back.
struct AhPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.88 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.6), value: configuration.isPressed)
            // An iPad pointer finds it, as it does the system buttons around it (Send, Stop,
            // Queue, the agent tiles).
            .hoverEffect(.highlight)
    }
}

extension ButtonStyle where Self == AhPressStyle {
    static var ahPress: AhPressStyle { AhPressStyle() }
}

extension View {
    /// Touches land a little past a small control's edge, to the 44 points a finger needs,
    /// without the control taking more room.
    func touchTarget(_ size: CGFloat = 44) -> some View { modifier(TouchTarget(size: size)) }
}

/// Buttons that share one capsule of glass (a note's tools and actions): each takes a
/// finger's whole width, with room between them, as Notes' bar has it.
/// At 32 points with 2 between, the touch areas overlapped and a thumb hit the button beside it.
enum ButtonGroup {
    /// Between two buttons in the capsule.
    static let spacing: CGFloat = 10
    /// From the capsule's rounded end to the first button.
    static let inset: CGFloat = 6
    /// Between two bare glyphs in a box's corner (the microphone and Send): 32 points drawn,
    /// 44 to touch, so their touch areas meet but don't overlap.
    static let corner: CGFloat = 12
}

private struct TouchTarget: ViewModifier {
    let size: CGFloat
    @State private var drawn = CGSize.zero

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGSize.self) { $0.size } action: { drawn = $0 }
            .contentShape(Rectangle().inset(by: -max(0, (size - min(drawn.width, drawn.height)) / 2)))
    }
}

/// Something still loading, by its shape: it fades in and out (and holds still with Reduce Motion).
/// Its own keyframes (see `PulseRing`), so what else changes as it appears isn't repeated with it.
struct Breathing: ViewModifier {
    var low: Double = 0.5
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.keyframeAnimator(initialValue: 1.0, repeating: true) { view, opacity in
                view.opacity(opacity)
            } keyframes: { _ in
                LinearKeyframe(low, duration: 0.9, timingCurve: .easeInOut)
                LinearKeyframe(1, duration: 0.9, timingCurve: .easeInOut)
            }
        }
    }
}

extension View {
    func breathing(low: Double = 0.5) -> some View { modifier(Breathing(low: low)) }
}

/// A session's row before the host has said what sessions there are: its shape, breathing.
/// A cold launch showed "No sessions running" for the second it took to ask.
struct SessionRowPlaceholder: View {
    /// How much of the title's line this one fills (rows differ, as real ones do).
    var title: CGFloat = 0.6
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9, style: .continuous).fill(theme.text.opacity(0.08)).frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 8) {
                Capsule().fill(theme.text.opacity(0.1)).frame(width: 220 * title, height: 11)
                Capsule().fill(theme.text.opacity(0.06)).frame(width: 140, height: 8)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .breathing()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading sessions")
    }
}

/// A page's filter field, under its large title as iOS keeps one (the bar's own search sits
/// above a title that lives in the page).
struct AhSearchField: View {
    @Binding var text: String
    let prompt: String
    /// Whose focus it is: the page decides when the field takes the keyboard.
    var focused: FocusState<Bool>.Binding
    /// Shown, a Cancel beside the field, as iOS's search bars have once a search is open.
    var onCancel: (() -> Void)? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.muted).accessibilityHidden(true)
                TextField(prompt, text: $text)
                    .focused(focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("inbox-search")
                if !text.isEmpty {
                    Button {
                        text = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(theme.faint)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
                    .transition(.opacity.combined(with: .scale(scale: 0.6)))
                }
            }
            .font(.ah(.body))
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(theme.tile, in: Capsule())
            .contentShape(Capsule())
            .onTapGesture { focused.wrappedValue = true }
            if let onCancel {
                Button("Cancel", action: onCancel)
                    .font(.ah(.body))
                    .buttonStyle(.borderless)
                    .tint(theme.accent)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.18), value: text.isEmpty)
        .animation(.snappy(duration: 0.25), value: onCancel == nil)
    }
}

/// A root page in ah's layers: rows on the panel's surface over the ground, the large title
/// in the content, and the bar left to its buttons.
struct AhPage: ViewModifier {
    let title: String
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var width: CGFloat = 0

    /// A page wider than a reading column (an iPad with the sidebar hidden) keeps its rows in
    /// one, as a session keeps its conversation: across the whole screen, a row's time sat a
    /// foot from its title.
    static func readableMargin(_ width: CGFloat) -> CGFloat? {
        let column = SessionScreen.readableWidth
        return width > column + 80 ? (width - column) / 2 : nil
    }

    func body(content: Content) -> some View {
        content
            .contentMargins(.horizontal, sizeClass == .compact ? nil : Self.readableMargin(width), for: .scrollContent)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .scrollContentBackground(.hidden)
            // Rows fade out under the bar's buttons and the status bar, as iOS 26 pages do:
            // unasked, a page's list ran its text straight through them.
            .scrollEdgeEffectStyle(.soft, for: .top)
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

extension View {
    /// Asks before `item` goes for good: its name in the question, a destructive button over
    /// Cancel. A swipe or a row's button sets it; nothing is removed until the answer.
    func confirmingRemoval<Item>(_ item: Binding<Item?>, title: @escaping (Item) -> String, message: String, verb: String = "Remove", remove: @escaping (Item) -> Void) -> some View {
        confirmationDialog(item.wrappedValue.map(title) ?? "", isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }), titleVisibility: .visible, presenting: item.wrappedValue) { asked in
            Button(verb, role: .destructive) { remove(asked) }
        } message: { _ in
            Text(message)
        }
    }
}

/// Shown only once it has lasted a beat: a status that's over in a moment ("Catching up",
/// "Attaching…") flashed for a frame. It comes in with a fade (and a small scale, unless
/// Reduce Motion is on).
private struct AfterABeat: ViewModifier {
    let delay: Duration
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .scaleEffect(shown || reduceMotion ? 1 : 0.9)
            .accessibilityHidden(!shown)
            .task {
                try? await Task.sleep(for: delay)
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { shown = true }
            }
    }
}

extension View {
    func afterABeat(_ delay: Duration = .milliseconds(800)) -> some View { modifier(AfterABeat(delay: delay)) }
}
