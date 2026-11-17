import SwiftUI
import UIKit

/// Dictation over the conversation, just above the box (`ComposerFloat`): while you speak, when
/// the microphone was held to start, how long and what you're saying now (only what isn't in
/// the box yet); the box's ✕ and ✓ are Cancel and Done. Then a word if it went wrong, and, for
/// words that were tidied, a way back to them as said. Over the transcript, not in the bar, so nothing moves while it comes and goes.
struct DictationCard: View {
    let dictation: DictationModel
    let composer: ComposerModel
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL

    /// While listening only when held to start (the box's ✕ and ✓ are the controls); after,
    /// a word on how it went.
    static func shows(_ dictation: DictationModel, in composer: ComposerModel) -> Bool {
        switch dictation.phase {
        case .starting, .listening: dictation.preview
        case .idle: dictation.canUseWhatWasSaid(in: composer.text)
        default: true
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch dictation.phase {
            case .starting:
                status("Getting ready…")
            case .listening(let since):
                listening(since: since)
            case .writing:
                status(writing)
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
                Text("Agent Hub can’t use the microphone. Turn it on in Settings to dictate.").font(.ah(.callout)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Spacer(minLength: 0)
                    Button("Dismiss") { dictation.dismiss() }.foregroundStyle(theme.muted)
                    Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }.buttonStyle(.glassProminent)
                }
            case .idle:
                tidied
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dictation")
    }

    private func status(_ words: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(words).font(.ah(.callout)).foregroundStyle(theme.muted)
            Spacer(minLength: 0)
        }
    }

    private var writing: String {
        switch dictation.route {
        case .host(let speech) where !dictation.placed.isEmpty:
            dictation.settings?.cleanup.map { "Tidying it with \($0.name)…" } ?? "Writing down the rest with \(speech)…"
        case .host(let speech): "Writing it down with \(speech)…"
        case .device(let cleanup?): "Tidying it with \(cleanup)…"
        case .device(nil): "Writing it down…"
        }
    }

    @ViewBuilder
    private func listening(since: Date) -> some View {
        HStack(spacing: 10) {
            Circle().fill(theme.danger).frame(width: 8, height: 8).accessibilityHidden(true)
            TimelineView(.periodic(from: since, by: 1)) { context in
                Text(Self.clock(context.date.timeIntervalSince(since)))
                    .font(.ahMono(.subheadline))
                    .monospacedDigit()
                    .foregroundStyle(theme.text)
            }
            .accessibilityLabel("Listening")
            // The words are in the box as you speak: the waves are here instead.
            if dictation.live && !dictation.placed.isEmpty {
                // What's left of the row once the buttons have theirs.
                DictationWaves(levels: dictation.levels, count: dictation.levelCount, color: theme.accent).frame(height: 18).frame(maxWidth: 110).layoutPriority(-1)
            }
            Spacer(minLength: 0)
        }
        // What you're saying now: this device's words for what isn't in the box yet, so the two
        // never say the same thing twice, or differently.
        Group {
            if !dictation.pending.isEmpty {
                Text(dictation.pending).lineLimit(3).truncationMode(.head).foregroundStyle(theme.text)
            } else if case .host = dictation.route {
                Text(dictation.live ? "Listening… your words go into the box as they’re heard." : "Listening… tap ✓ when you’re finished.").foregroundStyle(theme.muted)
            } else {
                Text("Listening…").foregroundStyle(theme.muted)
            }
        }
        .font(.ah(.callout))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var tidied: some View {
        if let last = dictation.last {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").foregroundStyle(theme.accent).accessibilityHidden(true)
                Text(last.cleanedBy.map { "Tidied by \($0)" } ?? "Tidied").font(.ah(.callout)).foregroundStyle(theme.muted).lineLimit(1)
                Spacer(minLength: 0)
                Button("Use What I Said") {
                    Haptics.selection()
                    dictation.useWhatWasSaid(in: composer)
                }
                .accessibilityIdentifier("dictation-as-said")
                .accessibilityHint("Puts your words back as you said them")
                Button {
                    dictation.keepTidied()
                } label: {
                    Image(systemName: "xmark").font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.muted).frame(width: 28, height: 28).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Keep the tidied words")
            }
        }
    }

    /// "0:07", "1:42".
    static func clock(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
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
