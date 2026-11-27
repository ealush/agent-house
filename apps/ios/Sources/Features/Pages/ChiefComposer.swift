import SwiftUI

/// A Chief of Staff's box on its Space's home: the session's own box (`ComposerBox`), its draft,
/// chips, @files, # sessions and / commands, pasted and attached pictures and files, and dictation
/// the session screen's, and what's sent goes as it would from there; only the settings, the queue
/// and the larger editor stay in the session.
struct ChiefComposer: View {
    @Bindable var session: SessionModel
    let scene: SceneModel
    /// The chief's name, for what's said once it's sent.
    let title: String
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44

    private var composer: ComposerModel { session.composer }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // What a session's box floats over the transcript, here over the box: the / @ #
            // suggestions, or dictation's word when it went wrong.
            if !composer.suggestions.isEmpty {
                // Three rows: more, and the box went under the keyboard below them.
                SuggestionList(items: composer.suggestions, index: composer.suggestionIndex, pick: { composer.accept($0) }, rows: 3)
                    .transition(.opacity)
            } else if DictationCard.shows(session.dictation) {
                DictationCard(dictation: session.dictation, composer: composer)
                    .transition(.opacity)
            }
            ComposerBox(composer: composer, role: .session(session), scene: scene, maxTextHeight: 160, recall: true) {
                ZStack { sendButton }
                    .animation(.snappy(duration: 0.22), value: session.dictation.isWriting)
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: composer.suggestions.isEmpty)
        .onChange(of: composer.events.count) { _, count in if count > 0 { deliverEvents() } }
    }

    /// Send, or Queue while the chief is in a turn: the message waits for it, as in its session.
    @ViewBuilder
    private var sendButton: some View {
        if session.dictation.isDictating {
            // ✓ beside it ends dictation; sending waits until it's done.
            EmptyView()
        } else if session.dictation.isWriting {
            // What was said is being written down: Send, held back, the ring around it.
            WaitingSend(size: control - 12).transition(.opacity)
        } else if !composer.isEmpty {
            let queues = session.working
            Button {
                if composer.submit(working: session.working) { Haptics.tap() }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: control * 0.34, weight: .bold))
                    .foregroundStyle(theme.accentInk)
                    .frame(width: control - 12, height: control - 12)
                    .background(theme.accentStrong, in: Circle())
                    .opacity(composer.canSend ? 1 : 0.45)
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            .accessibilityLabel(queues ? "Queue for \(title)" : "Send to \(title)")
            .accessibilityHint(composer.isUploading ? "Goes once the attachment is up" : "")
        }
    }

    /// What the box says once it's sent, or why it wasn't: the conversation it went to isn't on
    /// screen, so it's said here.
    private func deliverEvents() {
        for event in composer.takeEvents() {
            switch event {
            case .sent(let result):
                if result.resumed { scene.toast("Resumed \(title)") }
                else if let held = result.held { scene.toast(ComposerView.heldText(held)) }
                else { scene.toast(session.working ? "Queued for \(title)" : "Sent to \(title)") }
                session.stateChanged()
            case .failed(let message):
                Haptics.failure()
                scene.toast(message, error: true)
            case .requeue(let id, let before):
                Task { await session.queue.place(id, before: before) }
            case .interrupted:
                scene.toast("Interrupted")
            case .notice(let text):
                scene.toast(text)
            }
        }
    }
}
