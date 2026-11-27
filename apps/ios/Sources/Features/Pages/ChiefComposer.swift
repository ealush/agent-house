import SwiftUI

/// A Chief of Staff's box on its Space's home: the session's own composer, kept lean. Its draft,
/// @files, # sessions and / commands, pasted and attached pictures and files, and dictation are
/// the session screen's (`ComposerView`), and what's sent goes as it would from there; only the
/// settings, the queue and the larger editor stay in the session.
struct ChiefComposer: View {
    @Bindable var session: SessionModel
    let scene: SceneModel
    /// The chief's name, for what's said once it's sent.
    let title: String
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 40
    @ScaledMetric(relativeTo: .body) private var corner: CGFloat = 20
    /// A file is being dragged over the box.
    @State private var dropTargeted = false

    private var composer: ComposerModel { session.composer }
    private var dictating: Bool { session.dictation.isDictating }
    /// Dictating with words in the box: they sit over the row of ✕, the waves and ✓.
    private var overRow: Bool { dictating && (!composer.text.isEmpty || DictationPending.shows(session.dictation)) }

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
            box
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: composer.suggestions.isEmpty)
        .onChange(of: composer.text) { _, _ in
            if composer.suggestionIndex != 0 { composer.suggestionIndex = 0 }
            composer.updateSuggestions()
        }
        .onChange(of: composer.events.count) { _, count in if count > 0 { deliverEvents() } }
        // The host's Voice settings, read as the box shows, so the first tap knows who hears it.
        .task(id: session.key) { await session.dictation.refresh() }
        .onChange(of: session.dictation.last) { _, last in
            if last != nil {
                Haptics.selection()
                AccessibilityNotification.Announcement("Dictation added to the message").post()
            }
        }
        // Left while listening, what was said goes into the box; a start still waiting stops.
        .onDisappear {
            if session.dictation.isListening { Task { await session.dictation.finish(into: composer) } }
            else if session.dictation.phase == .starting { Task { await session.dictation.cancel(in: composer) } }
        }
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !composer.attachments.isEmpty {
                AttachmentTiles(composer: composer)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("attachments")
            }
            // At rest, + and the microphone and Send on the text's last line; dictating, the box's
            // foot is ✕, the waves and ✓, in one place from the tap on, the words going in above.
            DictationBoxLayout(stacked: dictating, row: control, textShown: overRow) {
                // While dictating, + is Cancel: the same size in the same place.
                Group {
                    if dictating { DictationCancel(dictation: session.dictation, composer: composer) } else { AttachMenu(composer: composer, recall: true) }
                }
                .frame(height: control)
                .dictationBoxRole(.leading)
                ComposerTextField(composer: composer, role: .session(session), scene: scene, maxHeight: 160)
                    .frame(minHeight: control)
                    // Dictating with nothing in it yet: unseen under the waves, the placeholder gone.
                    .opacity(dictating && !overRow ? 0 : 1)
                    .dictationBoxRole(.text)
                // Held to start: what you're saying now, under what's in, over the waves.
                if DictationPending.shows(session.dictation) {
                    DictationPending(dictation: session.dictation)
                        .padding(.horizontal, 7)
                        .transition(.opacity)
                        .dictationBoxRole(.pending)
                }
                if dictating {
                    DictationWaves(levels: session.dictation.levels, count: session.dictation.levelCount, color: theme.accent)
                        .frame(height: 20)
                        .padding(.horizontal, 6)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                        .dictationBoxRole(.waves)
                }
                HStack(spacing: ButtonGroup.corner) {
                    DictationMic(dictation: session.dictation, composer: composer)
                    if session.dictation.isWriting {
                        // What was said is being written down: Send, held back, the ring around it.
                        WaitingSend(size: control - 10).transition(.opacity)
                    } else if !dictating && !composer.isEmpty { sendButton }
                }
                .frame(height: control)
                .animation(.snappy(duration: 0.22), value: composer.isEmpty)
                .animation(.snappy(duration: 0.22), value: session.dictation.isWriting)
                .dictationBoxRole(.trailing)
            }
            .animation(DictationBoxLayout.motion(dictating: dictating), value: dictating)
            .animation(DictationBoxLayout.motion(dictating: dictating), value: overRow)
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 2)
        .background(theme.raised, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(theme.accent, lineWidth: 2)
                    .transition(.opacity)
            }
        }
        .animation(.snappy(duration: 0.15), value: dropTargeted)
        .onDrop(of: [.image, .fileURL, .item], isTargeted: $dropTargeted) { AttachDrop.attach($0, to: composer) }
    }

    /// Send, or Queue while the chief is in a turn: the message waits for it, as in its session.
    private var sendButton: some View {
        let queues = session.working
        return Button {
            if composer.submit(working: session.working) { Haptics.tap() }
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: control * 0.34, weight: .bold))
                .foregroundStyle(theme.accentInk)
                .frame(width: control - 10, height: control - 10)
                .background(theme.accentStrong, in: Circle())
                .opacity(composer.canSend ? 1 : 0.45)
                .touchTarget()
        }
        .buttonStyle(.ahPress)
        .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
        .accessibilityLabel(queues ? "Queue for \(title)" : "Send to \(title)")
        .accessibilityHint(composer.isUploading ? "Goes once the attachment is up" : "")
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
