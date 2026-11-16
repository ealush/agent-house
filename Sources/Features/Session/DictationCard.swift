import SwiftUI
import UIKit

/// Dictation over the conversation, just above the box (`ComposerFloat`): while you speak,
/// how long (how loud is the box's own waves, `DictationWaves`), and the words so far when
/// this device writes them; Cancel and Done. Then a word if it went wrong, and, for words that were tidied, a way back to
/// them as said. Over the transcript, not in the bar, so nothing moves while it comes and goes.
struct DictationCard: View {
    let dictation: DictationModel
    let composer: ComposerModel
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL

    static func shows(_ dictation: DictationModel, in composer: ComposerModel) -> Bool {
        dictation.phase != .idle || dictation.canUseWhatWasSaid(in: composer.text)
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
            if dictation.phase == .starting {
                Button("Cancel") { Task { await dictation.cancel(in: composer) } }.foregroundStyle(theme.muted)
            }
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
                DictationWaves(levels: dictation.levels, color: theme.accent).frame(height: 18).frame(maxWidth: 140)
            }
            Spacer(minLength: 0)
            Button("Cancel") {
                Haptics.selection()
                Task { await dictation.cancel(in: composer) }
            }
            .foregroundStyle(theme.muted)
            .accessibilityIdentifier("dictation-cancel")
            .accessibilityHint("Nothing goes into the box")
            Button {
                Task { await dictation.finish(into: composer) }
            } label: {
                Label("Done", systemImage: "checkmark").labelStyle(.titleAndIcon)
            }
            .buttonStyle(.glassProminent)
            .accessibilityIdentifier("dictation-done")
            .accessibilityHint("Puts what you said into the box")
        }
        // The words so far when this device writes them, the newest in view; else who will.
        Group {
            if !dictation.partial.isEmpty {
                Text(dictation.partial).lineLimit(3).truncationMode(.head).foregroundStyle(theme.text)
            } else if case .host(let speech) = dictation.route {
                Text(dictation.live ? "Speak. Each part goes into the box as \(speech) hears it." : "Speak. \(speech) writes it down when you tap Done.").foregroundStyle(theme.muted)
            } else {
                Text("Speak. Your words show here as \(dictation.thisDevice) hears them.").foregroundStyle(theme.muted)
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
/// (its size never changes for it), in a canvas: about twenty new lines a second.
struct DictationWaves: View {
    let levels: [Float]
    let color: Color
    /// One line and the gap after it.
    private static let pitch: CGFloat = 4.5
    private static let line: CGFloat = 2.5

    var body: some View {
        Canvas { context, size in
            let count = max(1, Int(size.width / Self.pitch))
            let recent = Array(levels.suffix(count))
            let middle = size.height / 2
            for slot in 0..<count {
                // Slot 0 is the newest, at the trailing end.
                let level = slot < recent.count ? recent[recent.count - 1 - slot] : 0
                // Quiet stays a dot; speech rises fast (the meter is linear in dB).
                let shaped = CGFloat(pow(max(0, (level - 0.18) / 0.82), 1.3))
                let height = max(Self.line, shaped * size.height)
                let x = size.width - CGFloat(slot) * Self.pitch - Self.line
                guard x >= 0 else { break }
                let fade = 1 - 0.75 * CGFloat(slot) / CGFloat(count)
                let rect = CGRect(x: x, y: middle - height / 2, width: Self.line, height: height)
                context.fill(Capsule().path(in: rect), with: .color(color.opacity(fade)))
            }
        }
        .accessibilityHidden(true)
    }
}
