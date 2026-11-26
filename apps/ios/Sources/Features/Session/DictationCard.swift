import SwiftUI
import UIKit

/// Dictation's word over the conversation, just above the box (`ComposerFloat`), only when it
/// went wrong: everything else is the box's own (✕, the waves and ✓ along its foot while you
/// speak, the words above them; a ring around Send while they're written down).
struct DictationCard: View {
    let dictation: DictationModel
    let composer: ComposerModel
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL

    /// It failed, or the microphone is off.
    static func shows(_ dictation: DictationModel) -> Bool {
        switch dictation.phase {
        case .failed, .denied: true
        default: false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch dictation.phase {
            case .failed(let message, let retry):
                Text(message).font(.ah(.callout)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Spacer(minLength: 0)
                    Button("Dismiss") { dictation.dismiss() }.foregroundStyle(theme.muted)
                    if retry {
                        Button("Try Again") { Task { await dictation.retry(into: composer) } }.buttonStyle(.glassProminent)
                    }
                }
            case .denied:
                Text("Agent House can’t use the microphone. Turn it on in Settings to dictate.").font(.ah(.callout)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Spacer(minLength: 0)
                    Button("Dismiss") { dictation.dismiss() }.foregroundStyle(theme.muted)
                    Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }.buttonStyle(.glassProminent)
                }
            default:
                EmptyView()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dictation")
    }
}

/// Held to start: what you're saying now, in the box just over the waves, only the part that
/// isn't in it yet, so the two never say the same thing twice, or differently.
struct DictationPending: View {
    let dictation: DictationModel
    @Environment(\.theme) private var theme

    /// Something to show: held to start, and words heard that aren't in the box yet.
    static func shows(_ dictation: DictationModel) -> Bool {
        dictation.isDictating && dictation.preview && !dictation.pending.isEmpty
    }

    var body: some View {
        Text(dictation.pending)
            .font(.ah(.body))
            .foregroundStyle(theme.muted)
            .lineLimit(3)
            .truncationMode(.head)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("dictation-pending")
    }
}

/// Around Send while what was said is written down (and tidied): it's at work, and Send waits
/// for it. In the box, on the button it holds back, not a line of its own over the conversation.
struct WritingRing: View {
    @Environment(\.theme) private var theme

    var body: some View {
        TimelineView(.animation) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9
            ZStack {
                Circle().stroke(theme.accent.opacity(0.18), lineWidth: 2)
                Circle().trim(from: 0, to: 0.28)
                    .stroke(theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(turn * 360))
            }
        }
        // Just clear of the button, and of the box's edge beside it.
        .padding(-3)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Send while what was said is written down (and tidied), where the box has nothing in it to
/// send yet or has the words going in: there, held back, the ring turning around it.
struct WaitingSend: View {
    /// How wide the button is drawn (Send's own, in its box).
    let size: CGFloat
    @Environment(\.theme) private var theme

    var body: some View {
        Image(systemName: "arrow.up")
            .font(.system(size: size * 0.47, weight: .bold))
            .foregroundStyle(theme.accentInk)
            .frame(width: size, height: size)
            .background(theme.accentStrong, in: Circle())
            .opacity(0.45)
            .overlay { WritingRing() }
            .touchTarget()
            .accessibilityElement()
            .accessibilityLabel("Send")
            .accessibilityValue("Writing down what you said")
            .accessibilityIdentifier("dictation-writing")
    }
}

/// A box with its controls on the text's last line (+ at the leading end, the microphone and
/// Send at the trailing one, as an `HStack(alignment: .bottom)` has them) that, while dictating,
/// puts the text up over a row of its own: ✕, the waves the width of the box, ✓. The row stays
/// where it is as the words come in above it (the box grows up), and every view keeps who it is
/// either way: the text its keyboard and caret, the microphone a hold under way.
struct DictationBoxLayout: Layout {
    /// Dictating: the text over the row.
    var stacked: Bool
    /// The row's height, stacked: the box's at rest, so it doesn't move as the text comes in.
    var row: CGFloat
    /// Stacked with no words yet, the text waits unseen in the row, under the waves (a tap
    /// there still finds it), and the box is the row alone.
    var textShown = true
    var spacing: CGFloat = 0

    enum Role { case leading, text, pending, waves, trailing }
    struct RoleKey: LayoutValueKey { static let defaultValue = Role.text }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        plan(proposal, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let plan = plan(ProposedViewSize(width: bounds.width, height: proposal.height), subviews)
        // Each in the middle of its place: the waves are shorter than their row.
        for (index, frame) in plan.frames.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.midX, y: bounds.minY + frame.midY), anchor: .center, proposal: ProposedViewSize(frame.size))
        }
    }

    private func plan(_ proposal: ProposedViewSize, _ subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        let roles = subviews.map { $0[RoleKey.self] }
        func size(_ role: Role) -> CGSize { roles.firstIndex(of: role).map { subviews[$0].sizeThatFits(.unspecified) } ?? .zero }
        let lead = size(.leading)
        let trail = size(.trailing)
        let width = proposal.width ?? lead.width + 240 + trail.width
        let middle = max(0, width - lead.width - trail.width)
        let text = roles.firstIndex(of: .text).map { subviews[$0] }
        var frames = Array(repeating: CGRect.zero, count: subviews.count)
        func put(_ role: Role, _ frame: CGRect) { for (index, each) in roles.enumerated() where each == role { frames[index] = frame } }

        guard stacked else {
            let textHeight = text?.sizeThatFits(ProposedViewSize(width: middle, height: proposal.height)).height ?? 0
            let height = max(lead.height, textHeight, trail.height)
            put(.leading, CGRect(x: 0, y: height - lead.height, width: lead.width, height: lead.height))
            put(.text, CGRect(x: lead.width, y: height - textHeight, width: middle, height: textHeight))
            put(.trailing, CGRect(x: width - trail.width, y: height - trail.height, width: trail.width, height: trail.height))
            put(.pending, CGRect(x: lead.width, y: height, width: middle, height: 0))
            put(.waves, CGRect(x: lead.width, y: height, width: middle, height: 0))
            return (CGSize(width: width, height: height), frames)
        }

        let row = max(self.row, lead.height, trail.height)
        let pending = roles.firstIndex(of: .pending).map { subviews[$0].sizeThatFits(ProposedViewSize(width: middle, height: nil)).height } ?? 0
        let pendingRoom = pending > 0 ? pending + spacing : 0
        var top: CGFloat = 0
        if textShown, let text {
            let room = proposal.height.map { max(0, $0 - row - pendingRoom - spacing) }
            let textHeight = text.sizeThatFits(ProposedViewSize(width: middle, height: room)).height
            put(.text, CGRect(x: lead.width, y: 0, width: middle, height: textHeight))
            top = textHeight + spacing
        }
        put(.pending, CGRect(x: lead.width, y: top, width: middle, height: pending))
        top += pendingRoom
        if !textShown { put(.text, CGRect(x: lead.width, y: top, width: middle, height: row)) }
        put(.leading, CGRect(x: 0, y: top + (row - lead.height) / 2, width: lead.width, height: lead.height))
        put(.trailing, CGRect(x: width - trail.width, y: top + (row - trail.height) / 2, width: trail.width, height: trail.height))
        put(.waves, CGRect(x: lead.width, y: top, width: middle, height: row))
        return (CGSize(width: width, height: top + row), frames)
    }
}

extension DictationBoxLayout {
    /// Into dictation, the box eases to its row; out of it, it's back as it was in one step:
    /// eased, the row faded out below the box as the box shrank away from it.
    static func motion(dictating: Bool) -> Animation? { dictating ? .snappy(duration: 0.22) : nil }
}

extension View {
    /// Which part of a `DictationBoxLayout` this is.
    func dictationBoxRole(_ role: DictationBoxLayout.Role) -> some View { layoutValue(key: DictationBoxLayout.RoleKey.self, value: role) }
}

/// While dictation listens, across the box where the text goes: what the microphone hears, a
/// line for each moment, the newest beside the microphone and the oldest fading out at the
/// far end. Before any sound, a row of dots: it's on, and waiting for you. Drawn over the box
/// (its size never changes for it). The lines keep their own clock (`WaveTape`): one every
/// thirtieth of a second, eased, gliding left at the screen's own rate, however unevenly the
/// microphone's readings arrive.
struct DictationWaves: View {
    let levels: [Float]
    /// How many readings came in all; the newest is `levels.last`.
    let count: Int
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tape = WaveTape()

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            Canvas { gc, size in
                let glide = reduceMotion ? tape.jump(levels: levels, count: count) : tape.advance(to: context.date, levels: levels, count: count)
                tape.draw(in: &gc, size: size, color: color, glide: glide)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Multi-layer organic audio-reactive halo around the active dictation button: two counter-rotating
/// smooth closed Bezier loops whose radii breathe with low-pass-filtered microphone amplitude.
/// Renders as a static soft circle under Reduce Motion.
struct VoiceBlobHalo: View {
    let level: Float
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var smoothed: CGFloat = 0

    var body: some View {
        if reduceMotion {
            Circle()
                .fill(color.opacity(0.24))
                .scaleEffect(1.25)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        } else {
            TimelineView(.animation(minimumInterval: 1 / 60)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                Canvas { gc, size in
                    let norm = CGFloat(min(1, max(0, (level - 0.16) / 0.65)))
                    let amp = max(0.08, smoothed * 0.65 + norm * 0.35)
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    let baseR = min(size.width, size.height) * 0.5
                    let outer = Self.blobPath(center: center, baseRadius: baseR * (1.06 + amp * 0.38), wobble: baseR * (0.06 + amp * 0.12), phase: t * 2.1, points: 8, seed: 0.7)
                    let inner = Self.blobPath(center: center, baseRadius: baseR * (1.02 + amp * 0.24), wobble: baseR * (0.04 + amp * 0.08), phase: -t * 2.7, points: 8, seed: 2.3)
                    gc.fill(outer, with: .color(color.opacity(0.18)))
                    gc.fill(inner, with: .color(color.opacity(0.28)))
                }
            }
            .onChange(of: level) { _, new in
                let norm = CGFloat(min(1, max(0, (new - 0.16) / 0.65)))
                smoothed = smoothed * 0.78 + norm * 0.22
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private static func blobPath(center: CGPoint, baseRadius: CGFloat, wobble: CGFloat, phase: Double, points: Int, seed: Double) -> Path {
        let step = (2 * Double.pi) / Double(points)
        var verts: [CGPoint] = []
        verts.reserveCapacity(points)
        for i in 0..<points {
            let angle = Double(i) * step
            let wave = sin(angle * 2 + phase + seed) * 0.55 + cos(angle * 3 - phase * 1.3 + seed) * 0.45
            let r = baseRadius + wobble * CGFloat(wave)
            verts.append(CGPoint(x: center.x + cos(angle) * r, y: center.y + sin(angle) * r))
        }
        var path = Path()
        guard verts.count >= 3 else { return path }
        let start = CGPoint(x: (verts.last!.x + verts[0].x) / 2, y: (verts.last!.y + verts[0].y) / 2)
        path.move(to: start)
        for i in 0..<verts.count {
            let cur = verts[i]
            let next = verts[(i + 1) % verts.count]
            let mid = CGPoint(x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2)
            path.addQuadCurve(to: mid, control: cur)
        }
        path.closeSubpath()
        return path
    }
}

/// The waves' lines: added at a steady pace from the readings in order, each eased toward its
/// reading (quick to rise, slower to fall), and how far the newest has slid in so far.
@MainActor
final class WaveTape {
    static let rate: Double = 30
    private static let pitch: CGFloat = 4
    private static let line: CGFloat = 2.2
    /// Eased heights, 0…1, newest last.
    private var lines: [CGFloat] = []
    private var shown: CGFloat = 0
    /// Readings taken so far (of `count`).
    private var taken = 0
    private var clock: Date?

    /// Lines due since the last frame, and how far into the next step it is (0…1).
    func advance(to now: Date, levels: [Float], count: Int) -> CGFloat {
        if count < taken { reset() }
        guard let last = clock else {
            clock = now
            return 0
        }
        let step = 1 / Self.rate
        var elapsed = now.timeIntervalSince(last)
        // Back from a pause (the app away): not a burst of lines all at once.
        if elapsed > 0.5 { elapsed = step }
        while elapsed >= step {
            addLine(levels: levels, count: count)
            elapsed -= step
        }
        clock = now.addingTimeInterval(-elapsed)
        return CGFloat(elapsed / step)
    }

    /// Reduce Motion: no sliding, a line per reading as it comes.
    func jump(levels: [Float], count: Int) -> CGFloat {
        if count < taken { reset() }
        while taken < count { addLine(levels: levels, count: count) }
        return 0
    }

    private func reset() {
        lines = []
        shown = 0
        taken = 0
        clock = nil
    }

    private func addLine(levels: [Float], count: Int) {
        // Fallen behind (readings came in a burst): skip to the last few.
        if count - taken > 4 { taken = count - 2 }
        let target: CGFloat
        let index = levels.count - (count - taken)
        if taken < count, levels.indices.contains(index) {
            target = Self.shaped(levels[index])
            taken += 1
        } else {
            // No new reading yet: the last one, fading.
            target = shown * 0.8
        }
        shown += (target - shown) * (target > shown ? 0.65 : 0.3)
        lines.append(shown)
        if lines.count > 240 { lines.removeFirst(lines.count - 240) }
    }

    /// Quiet stays a dot; speech rises fast (the readings are linear in dB).
    private static func shaped(_ level: Float) -> CGFloat {
        CGFloat(pow(max(0, (level - 0.18) / 0.82), 1.3))
    }

    func draw(in gc: inout GraphicsContext, size: CGSize, color: Color, glide: CGFloat) {
        let slots = max(1, Int(size.width / Self.pitch) + 1)
        let middle = size.height / 2
        for slot in 0..<slots {
            // Slot 0 is the newest line, sliding in from the trailing edge.
            let height = slot < lines.count ? lines[lines.count - 1 - slot] : 0
            let x = size.width - (CGFloat(slot) + glide) * Self.pitch - Self.line
            guard x >= -Self.line else { break }
            let tall = max(Self.line, height * size.height)
            let fade = 1 - 0.75 * CGFloat(slot) / CGFloat(slots)
            gc.fill(Capsule().path(in: CGRect(x: x, y: middle - tall / 2, width: Self.line, height: tall)), with: .color(color.opacity(fade)))
        }
    }
}
