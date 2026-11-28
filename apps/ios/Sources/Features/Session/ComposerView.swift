import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The message bar under a GUI session (`apps/server/web/Composer.tsx`): text, attachments, recall,
/// attach, and Send — or Stop while the agent works. What opens out of it (suggestions, the
/// settings chips) is `ComposerFloat`, over the transcript.
struct ComposerView: View {
    @Bindable var session: SessionModel
    @Bindable var composer: ComposerModel
    @Bindable var scene: SceneModel
    /// The conversation's room (under the header, down to the keyboard), from the controller
    /// that places the dock: what's over the box has to fit in it with the transcript.
    let room: ConversationRoom
    /// The room, or no limit until it's been laid out once.
    private var roomHeight: CGFloat { room.available > 0 ? room.available : .infinity }
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The settings chips are out, floating over the box (a swipe up, or the grabber); the
    /// composer's, so going back to reading the transcript can fold them.
    private var trayOpen: Bool {
        get { composer.trayOpen }
        nonmutating set { composer.trayOpen = newValue }
    }
    /// The round controls and the box's corner grow with the text, as the system's own do: at
    /// the largest sizes a fixed + sat small beside a box twice its height.
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44
    /// How tall the box is, as laid out: the queue takes what's left of the room.
    @State private var boxHeight: CGFloat = 0
    /// Where the glass field sits in global window coordinates, for the experimental send-flight arc.
    @State private var fieldGlobalFrame: CGRect = .zero
    /// Whether the active finger-drag on the settings tray has crossed its commit threshold.
    @State private var trayDragArmed = false
    /// Shakes the blocked Send/Queue control when tapped while an upload is still in flight.
    @State private var blockedSendShake = 0

    private var hasTray: Bool { ComposerFloat.hasTray(session) }
    /// The most the queue tray may take: under half the conversation's room, and never so much
    /// that the transcript keeps less than `transcriptKeeps` beside the box. Worked out from the
    /// room (the keyboard and the bars) and the box, never from the tray itself.
    private var queueRoom: CGFloat {
        guard roomHeight.isFinite else { return 320 }
        return max(0, min(roomHeight * 0.45, roomHeight - boxHeight - 16 - Self.transcriptKeeps))
    }
    /// What the transcript keeps above the dock, however long the queue or the draft.
    static let transcriptKeeps: CGFloat = 120
    /// Less room than this and the queue's line gives way to the box.
    static let roomForQueueLine: CGFloat = 170
    /// The most the text may take: its eight lines (`ComposerTextField`), and no more than the room
    /// leaves once the queue's line, the attachments and the transcript's share are counted, but
    /// always a line. Short of room, the box comes first: the transcript's share goes before it.
    private var textCap: CGFloat {
        guard roomHeight.isFinite else { return .infinity }
        let queueLine: CGFloat = session.queue.isEmpty || roomHeight < Self.roomForQueueLine ? 0 : 60
        let tiles: CGFloat = composer.attachments.isEmpty ? 0 : 76
        let chips: CGFloat = composer.snippets.isEmpty ? 0 : 54
        let keeps = roomHeight > 300 ? Self.transcriptKeeps : 0
        return max(ComposerTextView.leastHeight, roomHeight - queueLine - tiles - chips - 36 - keeps)
    }
    private var showsTray: Bool { trayOpen && hasTray && composer.suggestions.isEmpty }

    var body: some View {
        VStack(spacing: 8) {
            // Folded to its line while you ask for it, while the settings are out above the box
            // (the two together, over a long queue, left a sliver of the conversation), and
            // while the Queue panel shows the same list beside it.
            // With hardly any room (a phone on its side, the keyboard up), not even its line: the box
            // comes first, and the queue is a tap away in its panel (and the menu's Send Queued Now).
            if roomHeight >= Self.roomForQueueLine {
                QueueTrayView(queue: session.queue, composer: composer, working: session.working, held: session.awaitingGate, hardwareKeyboard: scene.hardwareKeyboard,
                              folded: scene.app.preferences.queueFolded || showsTray || session.panel == .queue,
                              maxHeight: queueRoom,
                              // Too little room to open it here: the line opens the Queue panel (a
                              // sheet on a phone), where the whole list fits.
                              toggleFold: {
                                  if queueRoom < QueueTrayView.leastOpen, SceneSnapshot.Panel.queue.applies(to: session) {
                                      session.panel = .queue
                                  } else {
                                      withAnimation(reduceMotion ? nil : QueueTrayView.motion) { scene.app.preferences.queueFolded.toggle() }
                                  }
                              },
                              showInPanel: SceneSnapshot.Panel.queue.applies(to: session) ? { session.panel = .queue } : nil)
            }
            if let from = composer.drafts.from {
                Label("Continued from \(from)", systemImage: "arrow.turn.down.right")
                    .font(.ah(.caption2)).foregroundStyle(theme.muted)
                    // Over the text it's about, which starts past the + in the box's corner.
                    .padding(.leading, 12 + (control - 12) + 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // One slim glass field the width of the bar, + in its leading corner and Send in
            // its trailing one (beside the box, + left it short, and what floated over it
            // read as loose); the settings chips wait folded away until a swipe up brings
            // them out, floating over the transcript above the box (`ComposerFloat`):
            // nothing here changes height for them, so the transcript doesn't move. A
            // dangerous permission mode is a red shield in the header: as a chip kept out
            // over the box, it took a row of the screen for as long as the mode lasted.
            box
                // Over the glass, not under it: laid on the box from within, a mark
                // showed only as a smear refracted through it. Centred, as a sheet's is.
                .overlay(alignment: .top) { grabber }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { fieldGlobalFrame = $0 }
                .gesture(ComposerSwipe(
                    onChanged: { dy in trayDragged(dy) },
                    onEnded: { dy, vy, cancelled in trayDragEnded(dy: dy, vy: vy, cancelled: cancelled) }
                ))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        // For the layout tests (ConversationLayoutUITests): where the whole bar is.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer-dock")
        .onChange(of: composer.events.count) { _, count in if count > 0 { deliverEvents() } }
        // Come back to the session and the box is as it rests, settings folded. (Left while
        // listening, what was said goes into this session's box: `ComposerBox`.)
        .onDisappear { composer.trayOpen = false }
    }

    /// What a message held behind a screen in front of the agent's prompt waits for.
    static func heldText(_ held: String) -> String {
        switch held {
        case "signin": return "Your message goes in once you’ve signed in"
        case "trust": return "Your message goes in once the folder is trusted"
        case "picker": return "Your message goes in once its question is answered"
        default: return "Your message goes in once the setup screen is answered"
        }
    }

    private func deliverEvents() {
        for event in composer.takeEvents() {
            switch event {
            case .sent(let result):
                // Said and done: the settings fold back out of the way.
                if trayOpen { withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { trayOpen = false } }
                // Held for a just-started agent: it's your message in the conversation already,
                // with the box's working light; a toast saying so was one thing too many.
                if result.resumed { scene.toast("Resumed the session") }
                // Held behind a screen in front of the prompt: say what it waits for.
                else if let held = result.held { scene.toast(Self.heldText(held)) }
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

    /// Continuous 1:1 finger tracking for the settings tray, with rubber-band over-drag resistance
    /// past open and a selection detent when crossing the commit point. Visual-only; dock height stays fixed.
    private func trayDragged(_ dy: CGFloat) {
        guard hasTray, composer.suggestions.isEmpty else { return }
        let span: CGFloat = 100
        let base: CGFloat = trayOpen ? 0 : span
        let raw = base + dy
        let clamped: CGFloat
        if raw < 0 {
            let excess = -raw
            clamped = -(excess / (1 + excess / 72))
        } else {
            clamped = min(span + 24, raw)
        }
        room.trayDragOffset = clamped
        let armed = trayOpen ? dy > 24 : dy < -24
        if armed != trayDragArmed {
            trayDragArmed = armed
            Haptics.selection()
        }
    }

    private func trayDragEnded(dy: CGFloat, vy: CGFloat, cancelled: Bool) {
        trayDragArmed = false
        if cancelled {
            let motion = ComposerFloat.motion(opening: trayOpen, reduceMotion: reduceMotion)
            withAnimation(motion) { room.trayDragOffset = nil }
            return
        }
        let projected = dy + vy * 0.12
        if hasTray, composer.suggestions.isEmpty, room.trayDragOffset != nil {
            let shouldOpen = trayOpen ? !(projected > 28 || vy > 480) : (projected < -24 || vy < -480)
            let motion = ComposerFloat.motion(opening: shouldOpen, reduceMotion: reduceMotion)
            withAnimation(motion) {
                room.trayDragOffset = nil
                trayOpen = shouldOpen
            }
            if !shouldOpen, !trayOpen, (dy > 20 || vy > 500), !scene.hardwareKeyboard {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
            return
        }
        room.trayDragOffset = nil
        if dy < -16 || vy < -500 {
            swiped(.up)
        } else if dy > 16 || vy > 500 {
            swiped(.down)
        }
    }

    /// A swipe up brings the settings out; a swipe down folds them, or puts the keyboard away.
    private func swiped(_ direction: ComposerSwipe.Direction) {
        switch direction {
        case .up:
            guard hasTray, !trayOpen, !session.dictation.isDictating else { return }
            Haptics.selection()
            withAnimation(ComposerFloat.motion(opening: true, reduceMotion: reduceMotion)) { trayOpen = true }
        case .down:
            if trayOpen {
                Haptics.selection()
                withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { trayOpen = false }
            } else if !scene.hardwareKeyboard {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
        }
    }

    /// The box, the one every composer has (`ComposerBox`): a session's Send, Queue, Run or Stop
    /// in its corner, and its larger editor once a message outgrows it.
    private var box: some View {
        ComposerBox(composer: composer, role: .session(session), scene: scene, maxTextHeight: textCap, recall: true,
                    expand: { scene.sheet = .draft(session.key) },
                    willDictate: {
                        if trayOpen { withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { trayOpen = false } }
                    }) {
            ZStack { sendButton }
                .animation(.snappy(duration: 0.22), value: composer.showsStop(working: session.working))
                .animation(.snappy(duration: 0.22), value: session.isShell || (session.working && composer.canSend))
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { boxHeight = $0 }
        .accessibilityAction(named: trayOpen ? "Hide session settings" : "Show session settings") {
            withAnimation(ComposerFloat.motion(opening: !trayOpen, reduceMotion: reduceMotion)) { trayOpen.toggle() }
        }
    }

    /// The tell that settings wait above: a sheet's grabber along the box's top edge, which a
    /// tap opens too. Inside the box, not over it: past the bar's edge it drew but took no touch.
    @ViewBuilder
    private var grabber: some View {
        if hasTray && !showsTray && composer.suggestions.isEmpty {
            Button {
                swiped(.up)
            } label: {
                // A fine, solid line: wide and faint, it read as a smear on the glass.
                Capsule().fill(theme.muted).frame(width: 18, height: 2)
                    .padding(.top, 5)
                    .frame(width: 72, height: 12, alignment: .top)
                    .contentShape(Rectangle())
                    .contentShape(.hoverEffect, Capsule())
                    .hoverEffect(.highlight)
            }
            .buttonStyle(.plain)
            .transition(.opacity)
            .accessibilityLabel("Show session settings")
            .accessibilityHint("Model, effort, permissions and panels")
        }
    }

    /// Dictation is starting or listening: ✓ beside the microphone ends it, not Send.
    private var dictating: Bool { session.dictation.isDictating }

    @ViewBuilder
    private var sendButton: some View {
        if dictating {
            // ✓ beside it is what ends dictation; sending waits until it's done.
            EmptyView()
        } else if session.dictation.isWriting {
            // What was said is being written down: Send, held back, a ring turning around it.
            WaitingSend(size: control - 12)
                .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
        } else if composer.showsStop(working: session.working) {
            Button {
                Task { await composer.stop() }
            } label: {
                // Stop where Send was, in its accent: the one filled control in the box.
                Image(systemName: "stop.fill")
                    .font(.system(size: control * 0.25, weight: .bold))
                    .foregroundStyle(theme.accentInk)
                    .frame(width: control - 12, height: control - 12)
                    .background(theme.accentStrong, in: Circle())
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            .accessibilityLabel("Stop the turn")
        } else if (session.isShell && !composer.isEmpty) || (session.working && composer.canSend) {
            // While it works a message waits its turn: the button says so, and holding it (or
            // ⌘Return) sends now instead.
            let queues = !session.isShell
            Button {
                // Felt as the finger lifts, as the bubble shows: the host's answer can be
                // seconds away (an upload first), and the tap came with it.
                if composer.submit(working: session.working) {
                    Haptics.tap()
                } else {
                    blockedSendShake += 1
                    Haptics.failure()
                    session.notify(composer.isUploading ? "Waiting for the upload to finish" : "Nothing to send yet", tone: .error)
                }
            } label: {
                // Send's pink, its height and its place, with the word for what it does.
                Text(queues ? "Queue" : "Run")
                    .font(.ah(.subheadline).weight(.semibold))
                    .foregroundStyle(theme.accentInk)
                    .padding(.horizontal, 13)
                    .frame(height: control - 12)
                    .background(theme.accentStrong, in: Capsule())
                    .opacity(composer.canSend ? 1 : 0.45)
                    .ahShake(trigger: blockedSendShake, cornerRadius: (control - 12) / 2)
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .contextMenu {
                if queues {
                    Button("Send Now", systemImage: "bolt.fill") {
                        Haptics.threshold()
                        composer.submit(working: true, steer: true)
                    }
                    .accessibilityHint("Stops the turn and sends this now")
                }
            }
            .accessibilityLabel(queues ? "Queue" : "Run")
            .accessibilityHint(queues ? "Sends when this turn ends. Hold to send now." : "")
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
        } else if !composer.isEmpty {
            // Folded away while there's nothing to send: it comes up with the first letter.
            Button {
                let draft = composer.text
                let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                let shortText = !trimmed.isEmpty && trimmed.count <= 240 && trimmed.filter({ $0 == "\n" }).count <= 3
                if !reduceMotion && !session.working && !session.isShell && composer.attachments.isEmpty && composer.snippets.isEmpty && shortText {
                    room.launchFlight?(trimmed, fieldGlobalFrame)
                }
                if composer.submit(working: session.working) {
                    Haptics.tap()
                } else {
                    blockedSendShake += 1
                    Haptics.failure()
                    session.notify(composer.isUploading ? "Waiting for the upload to finish" : "Nothing to send yet", tone: .error)
                }
            } label: {
                // ah's Send: the accent-filled circle, the one pink control.
                Image(systemName: "arrow.up")
                    .font(.system(size: control * 0.34, weight: .bold))
                    .foregroundStyle(theme.accentInk)
                    .frame(width: control - 12, height: control - 12)
                    .background(theme.accentStrong, in: Circle())
                    .opacity(composer.canSend ? 1 : 0.45)
                    .animation(.snappy(duration: 0.2), value: composer.canSend)
                    .ahShake(trigger: blockedSendShake, cornerRadius: (control - 12) / 2)
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            .accessibilityLabel("Send")
            .accessibilityHint(composer.isUploading ? "Goes once the attachment is up" : "")
        }
    }
}

/// ✕ in a box's + place while dictating: nothing goes into the box (what went in as you spoke
/// comes out again). The same size in the same place, so nothing moves.
struct DictationCancel: View {
    let dictation: DictationModel
    let composer: ComposerModel
    @Environment(\.theme) private var theme
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44

    var body: some View {
        Button {
            Haptics.selection()
            Task { await dictation.cancel(in: composer) }
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: control * 0.3, weight: .semibold))
                .foregroundStyle(theme.muted)
                .frame(width: control - 12, height: control - 12)
                .contentShape(Circle())
                .contentShape(.hoverEffect, Circle())
                .hoverEffect(.highlight)
                .touchTarget()
        }
        .buttonStyle(.ahPress)
        .transition(.opacity)
        .accessibilityIdentifier("dictation-cancel")
        .accessibilityLabel("Cancel Dictation")
        .accessibilityHint("Nothing goes into the box")
    }
}

/// The microphone in a box's corner, beside Send: a quick tap starts or finishes dictation
/// hands-free (the existing flow); holding past the press threshold starts live preview
/// dictation where releasing commits into the draft, sliding up locks hands-free, and sliding
/// left cancels.
struct DictationMic: View {
    let dictation: DictationModel
    let composer: ComposerModel
    /// While the words are written down, the ring is around the microphone (a box with no Send
    /// to put it on), not Send.
    var ringsWhileWriting = false
    /// Just before listening starts: the session's box folds its settings out of the way.
    var willStart: () -> Void = {}
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44

    private enum HoldMode: Equatable { case idle, holding, locked, cancelled }
    @State private var holdMode: HoldMode = .idle
    @State private var justLocked = false
    @State private var dragOffset: CGSize = .zero
    @State private var holdTask: Task<Void, Never>?
    @State private var pressStarted = false
    @GestureState private var isTouching = false

    private static let holdDelay: Duration = .milliseconds(220)
    private static let lockDistance: CGFloat = 52
    private static let cancelDistance: CGFloat = 76

    private var lockProgress: CGFloat {
        min(1, max(0, -dragOffset.height / Self.lockDistance))
    }

    private var cancelProgress: CGFloat {
        min(1, max(0, -dragOffset.width / Self.cancelDistance))
    }

    private var canStartHold: Bool {
        switch dictation.phase {
        case .idle, .failed, .denied: true
        default: false
        }
    }

    var body: some View {
        // Stable container so phase swaps (.idle -> .starting -> .listening) never tear down
        // the active hold/drag gesture mid-flight.
        ZStack {
            label
        }
        .frame(width: control - 12, height: control - 12)
        .contentShape(Circle())
        .touchTarget()
        .scaleEffect(holdMode == .holding && !reduceMotion ? 1.12 : 1)
        .animation(reduceMotion ? nil : .snappy(duration: 0.16), value: holdMode)
        .overlay(alignment: .top) {
            if holdMode == .holding || holdMode == .locked {
                DictationLockPill(progress: lockProgress, locked: holdMode == .locked)
                    .fixedSize()
                    .offset(y: -64)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.85).combined(with: .opacity))
            }
        }
        .overlay(alignment: .topTrailing) {
            if holdMode == .holding {
                DictationCancelPill(progress: cancelProgress)
                    .fixedSize()
                    .offset(x: -54, y: -58)
                    .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
            }
        }
        .highPriorityGesture(holdAndTapGesture)
        .disabled(dictation.phase == .writing)
        .onChange(of: isTouching) { was, now in
            // System or ancestor gesture interrupted the drag without calling onEnded.
            if was, !now, pressStarted {
                handleGestureEnded(translation: dragOffset)
            }
        }
        .onChange(of: dictation.phase) {
            if !dictation.isDictating && holdMode != .idle {
                resetHold()
            }
        }
        .onDisappear { resetHold() }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("dictate")
        .accessibilityLabel(dictation.isListening ? "Done Dictating" : "Dictate")
        .accessibilityHint(dictation.isListening ? "Puts what you said into the box" : "Tap to dictate, or hold and release to insert. While holding, slide up to lock or slide left to cancel.")
        .accessibilityAction {
            triggerTap()
        }
        .accessibilityAction(named: "Dictate and See Your Words") {
            willStart()
            Task { await dictation.toggle(into: composer, preview: true) }
        }
    }

    private var holdAndTapGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .updating($isTouching) { _, state, _ in state = true }
            .onChanged { value in
                guard dictation.phase != .writing else { return }
                if !pressStarted {
                    pressStarted = true
                    if canStartHold {
                        holdTask?.cancel()
                        holdTask = Task {
                            try? await Task.sleep(for: Self.holdDelay)
                            guard !Task.isCancelled, pressStarted, canStartHold else { return }
                            holdMode = .holding
                            Haptics.threshold()
                            willStart()
                            await dictation.start(into: composer, preview: true)
                        }
                    }
                }
                guard holdMode == .holding else { return }
                dragOffset = value.translation
                if -value.translation.height >= Self.lockDistance {
                    holdMode = .locked
                    justLocked = true
                    dragOffset = .zero
                    Haptics.success()
                } else if -value.translation.width >= Self.cancelDistance {
                    holdMode = .cancelled
                    dragOffset = .zero
                    Haptics.failure()
                    Task { await dictation.cancel(in: composer) }
                }
            }
            .onEnded { value in
                handleGestureEnded(translation: value.translation)
            }
    }

    private func handleGestureEnded(translation: CGSize) {
        holdTask?.cancel()
        holdTask = nil
        let wasPress = pressStarted
        pressStarted = false
        let mode = holdMode
        dragOffset = .zero
        switch mode {
        case .idle:
            guard wasPress else { return }
            let distance = hypot(translation.width, translation.height)
            if distance < 24 {
                triggerTap()
            }
        case .holding:
            holdMode = .idle
            Haptics.tap()
            Task {
                if dictation.isListening {
                    await dictation.finish(into: composer)
                } else if dictation.phase == .starting {
                    // Released before capture finished starting: cancel cleanly so no mic is stranded.
                    await dictation.cancel(in: composer)
                }
            }
        case .locked:
            if justLocked {
                // Lift from the slide-up lock gesture itself: keep listening hands-free.
                justLocked = false
            } else if wasPress, hypot(translation.width, translation.height) < 24 {
                // Subsequent tap on the Done checkmark commits the locked recording.
                triggerTap()
            }
        case .cancelled:
            holdMode = .idle
        }
    }

    private func triggerTap() {
        resetHold()
        Haptics.tap()
        willStart()
        Task { await dictation.toggle(into: composer) }
    }

    private func resetHold() {
        holdTask?.cancel()
        holdTask = nil
        pressStarted = false
        justLocked = false
        holdMode = .idle
        dragOffset = .zero
    }

    /// The microphone, or while listening ✓ (Done) in the accent, a ring around it breathing
    /// with your voice: once the words are in the box, that's what says it's still listening.
    @ViewBuilder
    private var label: some View {
        switch dictation.phase {
        case .starting:
            ProgressView().controlSize(.small)
                .frame(width: control - 12, height: control - 12)
        case .writing:
            // Back as it was, waiting: the ring around Send says what's at work.
            Image(systemName: "mic")
                .font(.system(size: control * 0.36, weight: .medium))
                .foregroundStyle(theme.muted.opacity(0.5))
                .frame(width: control - 12, height: control - 12)
                .overlay { if ringsWhileWriting { WritingRing() } }
                .touchTarget()
        case .listening:
            Image(systemName: "checkmark")
                .font(.system(size: control * 0.3, weight: .bold))
                .foregroundStyle(theme.accentInk)
                .frame(width: control - 12, height: control - 12)
                .background(theme.accentStrong, in: Circle())
                .background {
                    VoiceBlobHalo(level: dictation.level, color: theme.accent)
                        .frame(width: control + 26, height: control + 26)
                }
                .contentShape(Circle())
                .touchTarget()
        default:
            Image(systemName: "mic")
                .font(.system(size: control * 0.36, weight: .medium))
                .foregroundStyle(theme.muted)
                .frame(width: control - 12, height: control - 12)
                .contentShape(Circle())
                .contentShape(.hoverEffect, Circle())
                .hoverEffect(.highlight)
                .touchTarget()
        }
    }
}

/// What opens out of the composer, floating over the transcript just above it: the / and @
/// suggestions while you type one, or else the settings tray a swipe up brings out. Over the
/// transcript, not in the bar: in the bar each one made it taller as it came and went, the
/// transcript's room changed under it, and it moved.
struct ComposerFloat: View {
    @Bindable var session: SessionModel
    @Bindable var composer: ComposerModel
    @Bindable var scene: SceneModel
    let room: ConversationRoom
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44
    @State private var trayHeight: CGFloat = 60

    /// The session has settings to show: a live agent's model, effort and permissions.
    static func hasTray(_ session: SessionModel) -> Bool { !session.isShell && session.isLive && session.launch.preset != nil }

    var body: some View {
        let open = composer.trayOpen
        let liveOffset: CGFloat = {
            if let drag = room.trayDragOffset, !reduceMotion { return drag }
            return open || reduceMotion ? 0 : trayHeight + 40
        }()
        VStack(alignment: .leading, spacing: 0) {
            if !composer.suggestions.isEmpty {
                SuggestionList(items: composer.suggestions, index: composer.suggestionIndex) { composer.accept($0) }
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            } else if DictationCard.shows(session.dictation) {
                DictationCard(dictation: session.dictation, composer: composer)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            } else if Self.hasTray(session) {
                // Out from behind the box and back under it: a slide alone, no fade. Slid, not
                // removed: a view on its way out is laid out no more, so chips folding while the
                // keyboard went down stood still in the air and were cut off, rather than follow
                // the box down. Folded, it waits below the mask's edge, out of reach.
                tray
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { trayHeight = $0 }
                    .offset(y: liveOffset)
                    .opacity(reduceMotion && !open ? 0 : 1)
                    .allowsHitTesting(open || room.trayDragOffset != nil)
                    .accessibilityHidden(!open)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        // Cut off at the box's top edge, so what slides in comes out from behind the box
        // rather than drop onto it from above; open past the other edges, for the glass.
        .mask(alignment: .bottom) { Rectangle().frame(width: 4000, height: 4000) }
        .animation(Self.motion(opening: !composer.suggestions.isEmpty, reduceMotion: reduceMotion), value: composer.suggestions.isEmpty)
        .animation(Self.motion(opening: dictating, reduceMotion: reduceMotion), value: dictating)
    }

    private var dictating: Bool { DictationCard.shows(session.dictation) }

    /// How what floats over the box moves, the settings chips and the / and @ suggestions
    /// alike, by whichever way they're brought out or put away: a spring. Coming out from
    /// behind the box they rise a touch past their place and settle; folding they sink
    /// straight back, as a bounce there would peek them up over the box's edge again.
    static func motion(opening: Bool, reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }
        return opening ? .spring(duration: 0.42, bounce: 0.22) : .spring(duration: 0.3, bounce: 0)
    }

    /// What waits folded above the box: the settings in force, and the session's panels.
    private var tray: some View {
        // In line with the box's text, past the + in its corner: the float's margin and this.
        LaunchChips(session: session, scene: scene, leading: 24) { panels }
            .padding(.leading, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        // One piece in the slide: left to themselves the settings chips (a ViewThatFits)
        // faded in where they land while / and @ beside them rose.
        .geometryGroup()
        // Over the conversation's text, which fades out above the chips (as it does under
        // the bar) and is gone by their top edge: fading all the way down, it still read
        // through the glass and between the chips. No shadow of its own: a shadow drawn over
        // glass flattens it into a dark slab.
        .background {
            LinearGradient(stops: [.init(color: theme.surface.opacity(0), location: 0), .init(color: theme.surface.opacity(0.96), location: 0.4)], startPoint: .top, endPoint: .bottom)
                .padding(.top, -28)
                .padding(.horizontal, -12)
                .padding(.bottom, -8)
                .allowsHitTesting(false)
        }
        .gesture(ComposerSwipe(
            onChanged: { dy in
                let clamped = dy < 0 ? -(abs(dy) / (1 + abs(dy) / 72)) : min(trayHeight + 40, dy)
                room.trayDragOffset = clamped
            },
            onEnded: { dy, vy, cancelled in
                if cancelled {
                    withAnimation(Self.motion(opening: composer.trayOpen, reduceMotion: reduceMotion)) {
                        room.trayDragOffset = nil
                    }
                    return
                }
                let close = (dy + vy * 0.12) > 24 || vy > 480
                if close { Haptics.selection() }
                withAnimation(Self.motion(opening: !close, reduceMotion: reduceMotion)) {
                    room.trayDragOffset = nil
                    if close { composer.trayOpen = false }
                }
            }
        ))
    }

    /// The session's panels (Diff, Files, Chat, Queue, Snapshots, Preview, Stack), one menu
    /// away, in a round of glass beside the chips. In the session menu they were a menu inside
    /// that menu, which opened over it askew. / and @ once had buttons here too; typing either
    /// still opens its suggestions.
    @ViewBuilder
    private var panels: some View {
        let available = SceneSnapshot.Panel.allCases.filter { $0.applies(to: session) }
        if !available.isEmpty {
            Menu {
                // The open one checked, its glyph kept, as the iPad header's menu has them.
                ForEach(available) { panel in
                    Toggle(isOn: Binding(get: { session.panel == panel }, set: { on in
                        withAnimation(Self.motion(opening: false, reduceMotion: reduceMotion)) { composer.trayOpen = false }
                        session.panel = on ? panel : nil
                    })) {
                        PanelLabel(panel: panel, session: session)
                    }
                }
            } label: {
                Image(systemName: "sidebar.right")
                    .font(.ah(.callout).weight(.semibold))
                    .foregroundStyle(theme.text2)
                    .frame(width: control * 0.82, height: control * 0.82)
                    .modifier(PanelsGlyphDot(session: session))
                    .contentShape(.hoverEffect, Circle())
                    .hoverEffect(.highlight)
                    .touchTarget()
            }
            // In the order written, wherever the menu opens.
            .menuOrder(.fixed)
            .tint(.primary)
            .glassEffect(.regular.interactive(), in: Circle())
            .accessibilityLabel("Panels")
        }
    }
}

/// A vertical drag on the composer, the text box included. UIKit's, so it runs beside the text
/// view's own gestures (a tap still places the caret), yields when the text is long enough to
/// scroll or when touches start on the trailing dictation/send control, and streams live vertical
/// translation during `.changed` for 1:1 finger tracking.
struct ComposerSwipe: UIGestureRecognizerRepresentable {
    enum Direction { case up, down }
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat, CGFloat, Bool) -> Void

    init(onChanged: @escaping (CGFloat) -> Void, onEnded: @escaping (CGFloat, CGFloat, Bool) -> Void) {
        self.onChanged = onChanged
        self.onEnded = onEnded
    }

    init(_ swiped: @escaping (Direction) -> Void) {
        self.onChanged = { _ in }
        self.onEnded = { dy, vy, cancelled in
            guard !cancelled else { return }
            if dy < -16 || vy < -500 {
                swiped(.up)
            } else if dy > 16 || vy > 500 {
                swiped(.down)
            }
        }
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        pan.cancelsTouchesInView = false
        return pan
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        let moved = pan.translation(in: pan.view)
        let speed = pan.velocity(in: pan.view)
        switch pan.state {
        case .began:
            Haptics.prepare(.selection)
        case .changed:
            onChanged(moved.y)
        case .ended:
            onEnded(moved.y, speed.y, false)
        case .cancelled, .failed:
            onEnded(moved.y, speed.y, true)
        default:
            break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer, let view = pan.view else { return true }
            let location = pan.location(in: view)
            // Exclusive mic ownership: never steal upward slide-to-lock drags that start on the
            // trailing microphone control.
            if location.x > view.bounds.width - 66 && location.y > view.bounds.height - 66 {
                return false
            }
            let speed = pan.velocity(in: view)
            guard abs(speed.y) > abs(speed.x) else { return false }
            var hit = view.hitTest(location, with: nil)
            while let current = hit {
                if current.accessibilityIdentifier == "dictate" { return false }
                if current is ComposerTextView { break }
                hit = current.superview
            }
            if let text = hit as? ComposerTextView, text.contentSize.height > text.bounds.height + 1 { return false }
            return true
        }
    }
}

/// The camera, for a photo to attach (devices that have one).
struct CameraPicker: UIViewControllerRepresentable {
    let took: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.took(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// How much each setting chip says: its value (or that it's the default), its value or just
/// what it sets, or only symbols. The roomiest that fits the box wins.
enum LaunchChipsDensity { case full, compact, symbols }

/// The model/effort/permission chips: the value in force, and how a change applies, with what
/// stays beside them (`trailing`: / and @ and the panels).
struct LaunchChips<Trailing: View>: View {
    let session: SessionModel
    let scene: SceneModel
    /// How far in from the screen's edge the row starts: scrolled, the chips go out past it.
    var leading: CGFloat = 0
    @ViewBuilder var trailing: Trailing
    /// As tall as the / and @ beside them, at every text size.
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 36
    @State private var trailingWidth: CGFloat = 0
    @Environment(\.theme) private var theme

    typealias Density = LaunchChipsDensity

    var body: some View {
        if session.launch.preset != nil {
            ViewThatFits(in: .horizontal) {
                row(.full)
                row(.compact)
                // Past that the row scrolls: three bare symbols said nothing anyone could read.
                scrolling
            }
        } else {
            trailing
        }
    }

    /// The chips, then what stays beside them a step apart: at the far end of a wide box, / and
    /// @ sat stranded half a screen away.
    private func row(_ density: Density) -> some View {
        HStack(spacing: 8) {
            chips(density)
            Spacer(minLength: 0).frame(maxWidth: 8)
            trailing
        }
    }

    /// Too many to fit: the chips scroll across the whole width, out past the screen's edge on
    /// one side and under what stays on the other, fading out within its glass. Cut off short
    /// of it, they ended in a smudge with a gap after it, and in a hard edge in the air.
    private var scrolling: some View {
        ZStack(alignment: .trailing) {
            ScrollView(.horizontal) {
                // Glass of its own: a chip cut off at the scroll's edge still has its whole
                // shape, and in the composer's glass it ran into the button beyond.
                GlassEffectContainer {
                    chips(.compact)
                        // Room inside the scroll for the glass's own shadow, which it clips.
                        .padding(.vertical, 4)
                }
            }
            .scrollIndicators(.hidden)
            // At rest the first chip is where the row starts; at the end the last one clears
            // what stays beside it.
            .contentMargins(.leading, leading, for: .scrollContent)
            .contentMargins(.trailing, trailingWidth + 8, for: .scrollContent)
            // Gone by a little way in: met at full strength, a chip's edge showed through the
            // glass's rim as a second outline.
            .mask {
                HStack(spacing: 0) {
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 28)
                    Color.clear.frame(width: max(0, trailingWidth - 12))
                }
            }
            .padding(.leading, -leading)
            .padding(.vertical, -4)
            trailing
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { trailingWidth = $0 }
        }
    }

    @ViewBuilder
    private func chips(_ density: Density) -> some View {
        let launch = session.launch
        if let preset = launch.preset {
            HStack(spacing: 8) {
                // One of the row: it fits, shortens and scrolls as the settings do.
                if session.hasSubagentsEntry { SubagentsChip(session: session, scene: scene, density: density) }
                if !session.commits.commits.isEmpty { CommitsChip(session: session, scene: scene, density: density) }
                if !(preset.models ?? []).isEmpty || preset.modelArgs != nil || preset.settingsCommands?.model != nil {
                    let models = preset.models ?? []
                    if models.isEmpty {
                        chip("Model", "cpu", launch.modelLabel, fallback: "Default model", density) { scene.sheet = .modelPicker(session.key) }
                    } else {
                        // A menu out of the chip, as Permissions has: a half sheet over the box
                        // and the keyboard was a lot of screen for one tap.
                        let selected = launch.model?.id
                        choices("Model", "cpu", launch.modelLabel, fallback: "Default model", density, footer: launch.footer(.model)) {
                            ForEach(models, id: \.id) { model in
                                choice(model.name, detail: model.description, on: model.id == selected) { scene.applyPlan(session.plan(model: model.id)) }
                            }
                        }
                    }
                }
                if !launch.levels.isEmpty || preset.settingsCommands?.effort != nil {
                    if launch.levels.isEmpty {
                        chip("Effort", "gauge.with.dots.needle.50percent", launch.effort.map(LaunchState.effortName), fallback: "Default effort", density) { scene.sheet = .effortPicker(session.key) }
                    } else {
                        choices("Effort", "gauge.with.dots.needle.50percent", launch.effort.map(LaunchState.effortName), fallback: "Default effort", density, footer: launch.footer(.effort)) {
                            ForEach(launch.levels, id: \.self) { level in
                                choice(LaunchState.effortName(level), detail: LaunchState.effortHints[level], on: level == launch.effort) { scene.applyPlan(session.plan(effort: level)) }
                            }
                        }
                    }
                }
                // A dangerous mode is the red shield in the header (`PermissionShield`): its
                // chip here as well pushed the row past a phone's width.
                if let modes = preset.modes, modes.count > 1, launch.mode?.dangerous != true {
                    let current = launch.mode ?? modes.first { $0.id == "default" }
                    Menu {
                        Picker("Permissions", selection: Binding(get: { current?.id ?? "default" }, set: { scene.applyPlan(session.planMode($0)) })) {
                            ForEach(modes, id: \.id) { mode in
                                Label(mode.name, systemImage: mode.dangerous == true ? "exclamationmark.shield" : Self.symbol(mode.id)).tag(mode.id)
                            }
                        }
                        Section { Text(launch.footer(.mode)) }
                    } label: {
                        // The mode in force always says its name until there's room for nothing else.
                        chipLabel("Permissions", current?.dangerous == true ? "exclamationmark.shield.fill" : "lock.shield", density == .symbols ? nil : current?.name ?? "Default", spoken: current?.name ?? "Default", danger: current?.dangerous == true, labelled: density == .full)
                    }
                    .menuOrder(.fixed)
                    // A menu tints its label with the accent; this chip reads like its neighbors.
                    .tint(.primary)
                }
            }
            .fixedSize()
        }
    }

    /// Permission modes by what they let the agent do.
    private static func symbol(_ mode: String) -> String {
        switch mode {
        case "plan": return "list.bullet.clipboard"
        case "accept-edits": return "pencil.and.list.clipboard"
        case "auto": return "wand.and.stars"
        default: return "hand.raised"
        }
    }

    /// A setting's chip that opens its choices as a menu, each with its hint, and how a change
    /// applies under them.
    private func choices<Options: View>(_ name: String, _ symbol: String, _ value: String?, fallback: String, _ density: Density, footer: String, @ViewBuilder options: () -> Options) -> some View {
        let shown: String? = density == .symbols ? nil : value ?? (density == .full ? "Default" : name)
        return Menu {
            Section { options() }
            Section { Text(footer) }
        } label: {
            chipLabel(name, symbol, shown, spoken: value ?? fallback, danger: false, labelled: density == .full, unset: value == nil)
        }
        .menuOrder(.fixed)
        .tint(.primary)
    }

    /// A menu row: the choice, checked when it's the one in force, with its hint under it (a
    /// toggle, since a picker's option shows only its first line).
    private func choice(_ title: String, detail: String?, on: Bool, pick: @escaping () -> Void) -> some View {
        Toggle(isOn: Binding(get: { on }, set: { _ in if !on { pick() } })) {
            Text(title)
            if let detail, !detail.isEmpty { Text(detail) }
        }
    }

    private func chip(_ name: String, _ symbol: String, _ value: String?, fallback: String, _ density: Density, action: @escaping () -> Void) -> some View {
        // At its default with no room for the label, a chip says what it sets ("Model").
        let shown: String? = density == .symbols ? nil : value ?? (density == .full ? "Default" : name)
        // A setting at its default reads as unset (muted), not as a value like the mode beside it.
        return Button(action: action) { chipLabel(name, symbol, shown, spoken: value ?? fallback, danger: false, labelled: density == .full, unset: value == nil) }.buttonStyle(.plain)
    }

    /// ah's setting chip (`SettingChipLabel`).
    private func chipLabel(_ name: String, _ symbol: String, _ value: String?, spoken: String, danger: Bool, labelled: Bool = true, unset: Bool = false) -> some View {
        SettingChipLabel(name: name, symbol: symbol, value: value, spoken: spoken, danger: danger, labelled: labelled, unset: unset)
    }
}

/// ah's setting chip: a quiet label and the value in force ("Model Opus 5.5"); the label
/// drops first, then the value, leaving the symbol. Every chip over the box is one, so they
/// read as one row: the settings, and Subagents beside them.
struct SettingChipLabel<Badge: View>: View {
    let name: String
    let symbol: String
    let value: String?
    let spoken: String
    let danger: Bool
    let labelled: Bool
    let unset: Bool
    /// Drawn on the glyph's corner (Subagents' working dot).
    let badge: Badge
    /// After the value: where the checkout stands (the Commits chip's uncommitted changes and pull request).
    var mark: SourceControlMark? = nil
    /// As tall as the / and @ beside them, at every text size.
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 36
    @Environment(\.theme) private var theme

    init(name: String, symbol: String, value: String?, spoken: String, danger: Bool = false, labelled: Bool = true, unset: Bool = false, mark: SourceControlMark? = nil, @ViewBuilder badge: () -> Badge) {
        self.mark = mark
        self.name = name
        self.symbol = symbol
        self.value = value
        self.spoken = spoken
        self.danger = danger
        self.labelled = labelled
        self.unset = unset
        self.badge = badge()
    }

    var body: some View {
        HStack(spacing: 4) {
            // Its glyph first, so a value alone ("High") still says what it's the value of.
            Image(systemName: symbol).imageScale(.small).foregroundStyle(value == nil || unset ? theme.muted : theme.text2)
                .overlay(alignment: .topTrailing) { badge }
            if labelled, value != nil { Text(name).foregroundStyle(theme.muted).lineLimit(1) }
            if let value {
                if danger { Image(systemName: "exclamationmark.triangle.fill").imageScale(.small).foregroundStyle(theme.danger) }
                Text(value).foregroundStyle(danger ? theme.danger : unset ? theme.muted : theme.text).lineLimit(1)
                    // A count that changes keeps the chip's width steady while its digits do.
                    .monospacedDigit()
            }
            if let mark { SourceControlGlyph(mark: mark) }
        }
        .font(.ah(.footnote).weight(.medium))
        .padding(.horizontal, value == nil ? 10 : 11)
        .frame(minWidth: height, minHeight: height)
        // Glass like the box they float over, so they read as part of it, out for a moment.
        .glassEffect(danger ? .regular.tint(theme.danger.opacity(0.22)).interactive() : .regular.interactive(), in: Capsule())
        .contentShape(Capsule())
        // A pointer finds every chip, the menus' too.
        .hoverEffect(.highlight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mark.map { "\(name), \(spoken), \($0.spoken)" } ?? "\(name), \(spoken)")
        .accessibilityAddTraits(.isButton)
    }
}

extension SettingChipLabel where Badge == EmptyView {
    init(name: String, symbol: String, value: String?, spoken: String, danger: Bool = false, labelled: Bool = true, unset: Bool = false, mark: SourceControlMark? = nil) {
        self.init(name: name, symbol: symbol, value: value, spoken: spoken, danger: danger, labelled: labelled, unset: unset, mark: mark, badge: { EmptyView() })
    }
}

struct SuggestionList: View {
    let items: [CompletionTrigger.Item]
    let index: Int
    let pick: (CompletionTrigger.Item) -> Void
    /// The most rows it shows before it scrolls.
    var rows = 7
    @Environment(\.theme) private var theme
    // A finger's worth on a phone (34 was a pointer's), still seven rows before it scrolls;
    // taller with the text in it.
    @ScaledMetric(relativeTo: .callout) private var rowHeight: CGFloat = 40

    var body: some View {
        let shown = Array(items.prefix(12))
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { i, item in
                        Button { pick(item) } label: {
                            HStack(spacing: 9) {
                                Image(systemName: symbol(item))
                                    .font(.ah(.footnote))
                                    .foregroundStyle(i == index ? theme.accent : theme.faint)
                                    .frame(width: 18)
                                // The name gives way last: the description shortens first (a long
                                // path still shortens in its middle).
                                Text(item.label).font(.ahMono(.callout)).foregroundStyle(theme.text).lineLimit(1).truncationMode(.middle).layoutPriority(1)
                                if let detail = item.detail {
                                    Text(detail).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if i == index { Image(systemName: "return").font(.ah(.caption2)).foregroundStyle(theme.faint) }
                            }
                            .padding(.horizontal, 10)
                            .frame(height: rowHeight)
                            // Concentric with the list's corners: its radius less the inset.
                            .background(i == index ? theme.accent.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .id(i)
                    }
                }
                .padding(6)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(CGFloat(shown.count) * (rowHeight + 1) + 12, CGFloat(rows) * (rowHeight + 1) + 12))
            .onChange(of: index) { _, i in proxy.scrollTo(i) }
        }
        // The composer's glass and its corners, so the list reads as the box opening upward.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggestions")
        .accessibilityIdentifier("suggestions")
    }

    /// A slash command, a session mention, or a file by its kind.
    private func symbol(_ item: CompletionTrigger.Item) -> String {
        if item.label.hasPrefix("/") { return "command" }
        if item.value.hasPrefix("#") {
            return item.detail?.hasPrefix("Chief") == true ? "crown" : "number"
        }
        let name = (item.value as NSString).lastPathComponent
        return FilesModel.Kind(FsEntry(name: name, type: item.value.hasSuffix("/") ? .dir : .file, size: 0, mtime: 0)).symbol
    }
}

/// The text box itself: a UITextView, so Return, Escape, ↑/↓, Tab and every keyboard command
/// land exactly where they should, and dictation, autocorrect and selection keep working.
struct ComposerTextField: UIViewRepresentable {
    let composer: ComposerModel
    let role: ComposerRole
    let scene: SceneModel
    /// Room kept clear at the end of each line for the button in the box's corner.
    var leadingRoom: CGFloat = 0
    var trailingRoom: CGFloat = 0
    /// How tall that button is: a long message's scroll bar stops above it.
    var cornerHeight: CGFloat = 0
    /// The most the box may be (the room the conversation has); past it, the text scrolls inside.
    /// Nil: no taller than it's offered (New session's, whose stage gives way above it).
    var maxHeight: CGFloat? = .infinity
    /// Changed for each ask for the keyboard, for a box that's asked directly (New session's);
    /// nil: it answers the scene's focus requests for its target.
    var keyboardAsk: Int? = nil
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.coordinator = context.coordinator
        view.pasteDelegate = context.coordinator
        // Media too, as the menu's Paste takes it: a keyboard's ⌘V can go through the
        // text system's paste, which drops whatever the box doesn't say it takes, and which
        // asks `pasteDelegate` what each pasted thing becomes.
        view.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: ComposerTextView.pastedTypes)
        view.font = AhType.uiFont(.body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 6, left: 2, bottom: 6, right: 2)
        view.isScrollEnabled = true
        view.returnKeyType = Self.returnKey(hardwareKeyboard: scene.hardwareKeyboard)
        view.accessibilityIdentifier = role.identifier
        view.text = composer.text
        setTraits(view)
        return view
    }

    /// A touch keyboard's Return starts a new line, as in Messages (Send is the button); with a
    /// hardware keyboard, Return sends and Shift- or Option-Return starts the new line.
    private static func returnKey(hardwareKeyboard: Bool) -> UIReturnKeyType { hardwareKeyboard ? .send : .default }

    /// Commands aren't sentences: no capitals, corrections or curly quotes in a shell.
    private func setTraits(_ view: ComposerTextView) {
        let shell = role.isShell
        view.autocapitalizationType = shell ? .none : .sentences
        view.autocorrectionType = shell ? .no : .default
        view.spellCheckingType = shell ? .no : .default
        view.smartQuotesType = shell ? .no : .default
        view.accessibilityLabel = role.accessibilityLabel
    }

    /// What the box says while it's empty: what Send will do now.
    private var placeholder: String {
        switch role {
        case .session(let session):
            let settings = ComposerFloat.hasTray(session) ? [session.launch.modelLabel, session.launch.effort.map(LaunchState.effortName)].compactMap { $0 } : []
            return composer.placeholder(working: session.working, queued: session.row?.dto.queued ?? 0, touchOnly: !scene.hardwareKeyboard, agent: session.launch.preset?.name, waiting: session.waiting, trusting: session.ask?.holdsMessages ?? false, ended: !session.isLive, settings: settings)
        case .newSession(let draft, _):
            if role.isShell { return "First command" }
            let agent = draft.preset?.name ?? "the agent"
            return scene.hardwareKeyboard ? "Message \(agent) · @ files · # sessions" : "Message \(agent)"
        case .message(let message):
            return message.placeholder
        }
    }

    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        // Room for + and Send changes the width the text wraps in, so the box is measured again:
        // a long draft's first line was cut off when Send came in beside it.
        if view.textContainerInset.left != 2 + leadingRoom || view.textContainerInset.right != 2 + trailingRoom {
            view.textContainerInset.left = 2 + leadingRoom
            view.textContainerInset.right = 2 + trailingRoom
            view.setNeedsLayout()
            view.invalidateIntrinsicContentSize()
        }
        let indicator = UIEdgeInsets(top: 8, left: 0, bottom: cornerHeight > 0 ? cornerHeight + 4 : 8, right: 0)
        if view.verticalScrollIndicatorInsets != indicator { view.verticalScrollIndicatorInsets = indicator }
        if (view.autocapitalizationType == .none) != role.isShell || view.accessibilityLabel != role.accessibilityLabel {
            setTraits(view)
            if view.isFirstResponder { view.reloadInputViews() }
        }
        if view.returnKeyType != Self.returnKey(hardwareKeyboard: scene.hardwareKeyboard) {
            view.returnKeyType = Self.returnKey(hardwareKeyboard: scene.hardwareKeyboard)
            if view.isFirstResponder { view.reloadInputViews() }
        }
        view.takesMedia = role.takesFiles
        if view.text != composer.text {
            view.text = composer.text
            view.invalidateIntrinsicContentSize()
            // Where the change left the caret (after a picked file, a snippet put in, dictation's
            // words mid-text), not always the end.
            let offset = composer.placeCaret.map { min(max(0, $0), view.text.utf16.count) }
            composer.placeCaret = nil
            let caret = offset.flatMap { view.position(from: view.beginningOfDocument, offset: $0) } ?? view.endOfDocument
            view.selectedTextRange = view.textRange(from: caret, to: caret)
        }
        // "@path" naming a file that's there: a chip in the text, opened or taken out from it.
        view.mentionTint = theme.uiAccent
        view.plainColor = UIColor(theme.text)
        view.openMention = { [composer, hostFiles, role, scene] mention in
            // What's attached opens once it's up; a file the text names, in the session's folder.
            if let attached = composer.attachment(for: mention) {
                if let path = attached.path { Task { await hostFiles?.open?(path) } } else { role.notify("\(attached.name) is still uploading", in: scene) }
                return
            }
            guard let path = composer.mentionLookup?.resolve(mention.path) else { return }
            Task { await hostFiles?.open?(path) }
        }
        view.removeMention = { [composer] mention in composer.removeChip(mention) }
        view.moveMention = { [composer] mention, to in composer.moveChip(mention, to: to) }
        view.mentions = role.isShell ? [] : composer.chips
        // A link to a pull request the host reviews: a chip that opens its review.
        let reviewed = role.isShell || hostFiles?.openPull == nil ? [] : hostFiles?.pulls?() ?? []
        view.pulls = reviewed.isEmpty ? [] : PullLinks.find(composer.text).filter { link in
            PullLinks.reviewable(link.pull, in: reviewed) && !view.mentions.contains { NSIntersectionRange($0.range, link.range).length > 0 }
        }
        view.openPull = { [hostFiles] link in hostFiles?.openPull?(link.pull) }
        // New text (sent, recalled, a chip taken out) comes in plain; and a theme's new colour.
        view.styleMentions()
        view.placeholder = placeholder
        // Only when the theme changes: setting it restyles all the text, every keystroke, under
        // autocorrect and the keyboard's predictions.
        if context.coordinator.theme != theme {
            context.coordinator.theme = theme
            view.textColor = UIColor(theme.text)
        }
        let editable = role.editable
        if view.isEditable != editable { view.isEditable = editable }
        if !editable, view.isFirstResponder { view.resignFirstResponder() }
        if let keyboardAsk {
            if keyboardAsk != context.coordinator.handledAsk {
                context.coordinator.handledAsk = keyboardAsk
                // Now, and again once it's in its window: a view not yet in one can't take it.
                if editable {
                    view.becomeFirstResponder()
                    DispatchQueue.main.async { if role.editable { view.becomeFirstResponder() } }
                }
            }
        } else if let request = scene.focusRequest, request.nonce != context.coordinator.handledFocus {
            context.coordinator.handledFocus = request.nonce
            if request.target == role.focusTarget, request.isFresh(forBoxMadeAt: context.coordinator.made) {
                DispatchQueue.main.async { view.becomeFirstResponder() }
            }
        }
    }

    /// Its eight lines at most, and no more than the room it's given. Without a cap of its own
    /// (New session's), never taller than it's offered: short of room (a phone on its side, the
    /// keyboard up) the stage above gives way, then the text scrolls inside the box. The offer,
    /// not a height measured afterwards: the keyboard's frame passes through several sizes while
    /// the phone turns, and a box sized for one held text measured for another.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        uiView.fitting(proposal, maxHeight: maxHeight ?? proposal.height ?? .infinity, kept: &context.coordinator.measured)
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate, UITextPasteDelegate, ComposerTextViewOwner {
        var parent: ComposerTextField
        var handledFocus = 0
        var handledAsk = 0
        /// When this box was made: a focus request from long before isn't for it.
        let made = Date()
        /// The theme the text was last colored for.
        var theme: Theme?
        /// The box's height for a text at a width, as last measured.
        var measured: [ComposerTextView.Measure: CGFloat] = [:]

        init(parent: ComposerTextField) { self.parent = parent }

        private var composer: ComposerModel { parent.composer }
        private var scene: SceneModel { parent.scene }

        func textViewDidChange(_ textView: UITextView) {
            // SwiftUI measures the box again only when told: a line more or less is a new size.
            textView.invalidateIntrinsicContentSize()
            scene.fieldState = fieldState(textView)
            composer.text = textView.text
            composer.caret = textView.offset(from: textView.beginningOfDocument, to: textView.selectedTextRange?.start ?? textView.endOfDocument)
            composer.edited()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            scene.fieldState = fieldState(textView)
            // Mid-keystroke the caret moves before the text arrives: suggestions worked out from
            // the old text emptied the list (and a quick Return sent the half-typed @mention).
            // The text's own change brings them up to date.
            guard textView.text == composer.text else { return }
            let caret = textView.offset(from: textView.beginningOfDocument, to: textView.selectedTextRange?.start ?? textView.endOfDocument)
            if caret != composer.caret {
                composer.caret = caret
                composer.updateSuggestions()
            }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            scene.keyScope = .field
            scene.fieldState = fieldState(textView)
            scene.didFocus(parent.role.focusTarget)
            // A session's box focused is part of where the window was: it's back focused.
            if let session = parent.role.session {
                scene.composerFocused = session.key
                scene.scheduleSave()
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            scene.keyScope = .app
            if let session = parent.role.session, scene.composerFocused == session.key { scene.composerFocused = nil }
            scene.didBlur(parent.role.focusTarget)
        }

        /// The software keyboard's Return: a new line, unless it's taking a suggestion (or, with
        /// a hardware keyboard about, it's the Send key it says it is).
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard text == "\n", (textView as? ComposerTextView)?.isHardwareReturn != true else { return true }
            if !composer.suggestions.isEmpty {
                composer.accept(composer.suggestions[min(composer.suggestionIndex, composer.suggestions.count - 1)])
                return false
            }
            guard scene.hardwareKeyboard else { return true }
            send()
            return false
        }

        func fieldState(_ textView: UITextView) -> FieldState {
            let selection = textView.selectedTextRange.map {
                textView.offset(from: textView.beginningOfDocument, to: $0.start)..<textView.offset(from: textView.beginningOfDocument, to: $0.end)
            }
            return FieldState(text: textView.text, selection: selection)
        }

        /// Return: the suggestion it's on, else what Send does here.
        func send() {
            if !composer.suggestions.isEmpty {
                composer.accept(composer.suggestions[min(composer.suggestionIndex, composer.suggestions.count - 1)])
                return
            }
            // What was said is still being written down: Send waits for it, and so does Return.
            if parent.role.dictation?.isWriting == true { return }
            switch parent.role {
            case .session(let session):
                // An empty box steers the next queued message, like its Steer button.
                if composer.isEmpty {
                    _ = session.queue.steerFirst()
                    return
                }
                composer.submit(working: session.working)
            case .newSession(let draft, let start):
                // Left to the box, the press went on to the sidebar's list, which opened its
                // first session instead.
                if draft.canStart { start() }
            case .message(let message):
                if !composer.isEmpty, !message.busy { message.send() }
            }
        }

        /// Keys the composer answers itself, after the app's commands had their chance.
        func handle(_ press: KeyPress, in textView: ComposerTextView) -> Bool {
            if scene.handle(press, scope: .field, field: fieldState(textView)) { return true }
            let mods = press.modifiers
            let session = parent.role.session
            switch press.key {
            case "Enter" where mods.isEmpty:
                send()
                return true
            case "Enter" where mods == [.shift]:
                return false
            case "Enter" where mods == [.option]:
                // A new line, as Shift-Return gives (and as a Mac's text fields have it).
                textView.insertText("\n")
                return true
            case "Enter" where mods == [.command] && session?.working == true && !composer.isEmpty && !composer.isShell && session?.dictation.isWriting != true:
                // ⌘Return while it works: don't queue, send now (the turn stops).
                Haptics.threshold()
                composer.submit(working: true, steer: true)
                return true
            case "Escape":
                if !composer.suggestions.isEmpty {
                    composer.dismissSuggestions()
                    return true
                }
                if composer.isEmpty && session?.working == true && !composer.isShell {
                    Task { await composer.stop() }
                    return true
                }
                return false
            case "Tab" where !composer.suggestions.isEmpty:
                send()
                return true
            case "ArrowUp" where mods.isEmpty:
                if !composer.suggestions.isEmpty {
                    composer.suggestionIndex = (composer.suggestionIndex - 1 + composer.suggestions.count) % composer.suggestions.count
                    return true
                }
                if composer.text.isEmpty || composer.isRecalling {
                    composer.recall(1)
                    return true
                }
                return false
            case "ArrowDown" where mods.isEmpty:
                if !composer.suggestions.isEmpty {
                    composer.suggestionIndex = (composer.suggestionIndex + 1) % composer.suggestions.count
                    return true
                }
                if composer.isRecalling {
                    composer.recall(-1)
                    return true
                }
                return false
            default:
                return false
            }
        }

        /// Pasted media with no text beside it (a screenshot, a video, a file, by ⌘V or the
        /// menu): attached, rather than typed as nothing. Text pastes as text.
        func textPasteConfigurationSupporting(_ textPasteConfigurationSupporting: any UITextPasteConfigurationSupporting, transform item: any UITextPasteItem) {
            ComposerTextView.paste(item, to: self, takesMedia: parent.role.takesFiles)
        }

        func pasteMedia(_ providers: [NSItemProvider]) {
            guard parent.role.takesFiles else { return }
            AttachPaste.attach(providers, to: composer)
        }

        /// A long paste is a chip over the text, opened to edit (not a shell's command).
        func pasteLargeText(_ text: String) -> Bool {
            guard !parent.role.isShell, ComposerModel.shouldChipPaste(text) else { return false }
            composer.addSnippet(kind: .paste, body: text)
            Haptics.selection()
            return true
        }
    }
}

/// Who a `ComposerTextView` hands its hardware keys and pasted media to: a session's box
/// (`ComposerTextField`), or New session's (`NewSessionTextField`).
@MainActor
protocol ComposerTextViewOwner: AnyObject {
    /// A key the box answers itself before it's typed (Return sends); true when it took it.
    func handle(_ press: KeyPress, in textView: ComposerTextView) -> Bool
    /// The pasteboard's media, pasted: attached.
    func pasteMedia(_ providers: [NSItemProvider])
    /// A large body of text pasted from the pasteboard: turned into a pillbox chip if handled.
    func pasteLargeText(_ text: String) -> Bool
}

extension ComposerTextViewOwner {
    func pasteLargeText(_ text: String) -> Bool { false }
}

/// A UITextView that hands hardware keys to the composer before typing them, and turns
/// pasted media (a screenshot, a video, a file) into an attachment instead of nothing. A
/// note's text is one too (`NoteTextView`), for its chips and pasted media.
class ComposerTextView: UITextView {
    /// Sized as a box is (a line or a few, centred when short, fading where it scrolls); a
    /// note's text fills its page instead.
    var sizesAsBox: Bool { true }
    weak var coordinator: (any ComposerTextViewOwner)?
    var placeholder = "" { didSet { if placeholder != oldValue { setNeedsLayout() } } }
    /// The current Return came from a hardware key (handled in pressesBegan).
    fileprivate(set) var isHardwareReturn = false
    private let placeholderLabel = UILabel()
    private let fade = CAGradientLayer()
    private struct PlaceholderFit: Equatable {
        let placeholder: String
        let width: CGFloat
        let size: CGFloat
    }
    private var placeholderFit: PlaceholderFit?

    // MARK: @mentions as chips
    //
    // The text stays the box's own (dictation, autocorrect, selection): a mention's letters are
    // tinted where they are, its @ made clear with a × drawn in its place, and a rounded border
    // laid behind it from the text system's own rects, so it wraps and scrolls with the line.
    // Over each, a tap target: the name opens the file, the × takes the mention out. A chip has
    // only the room its letters take; nothing in the line moves for it.

    /// The mentions to draw as chips (`ComposerModel.fileMentions`).
    var mentions: [Mention] = [] {
        didSet { if mentions != oldValue { styleMentions(); chipsFor = nil; setNeedsLayout() } }
    }
    var mentionTint: UIColor = .tintColor
    /// The text's own colour (the theme's), the one a mention's tint goes back to. Not read back
    /// from `textColor`: new text set beside a chip comes in with the chip's tint, and that's
    /// what `textColor` then says.
    var plainColor: UIColor = .label
    var openMention: ((Mention) -> Void)?
    var removeMention: ((Mention) -> Void)?
    /// Links to pull requests the host reviews (`PullLinks`): chips with no ×, every letter of
    /// them the address the agent gets; a tap opens the review.
    var pulls: [PullLink] = [] {
        didSet { if pulls != oldValue { styleMentions(); chipsFor = nil; setNeedsLayout() } }
    }
    var openPull: ((PullLink) -> Void)?
    /// A chip dragged to another place: the mention and where it goes (a UTF-16 offset).
    var moveMention: ((Mention, Int) -> Void)?
    /// The chip being dragged: its copy under the finger, the caret where it would land.
    private var chipDrag: (mention: Mention, ghost: UIView, caret: UIView, to: Int?)?
    private var chips: [UIView] = []
    /// What the chips were laid out for: done again only when the text, its width or the mentions change.
    private var chipsFor: (text: String, width: CGFloat, size: CGFloat)?
    /// The kerning on the space between two chips side by side, at the font size it was measured
    /// at: what stands their boxes `MentionChip.gap` apart (`layoutChips`).
    private var between: (size: CGFloat, kern: CGFloat)?

    /// The tint on each mention's letters and none elsewhere, set only where it isn't already:
    /// restyling all the text on each keystroke disturbs autocorrect and the predictions.
    func styleMentions() {
        guard markedTextRange == nil else { return }
        let storage = textStorage
        let base = plainColor
        var wanted: [(NSRange, UIColor)] = []
        for m in mentions where NSMaxRange(m.range) <= storage.length {
            wanted.append((NSRange(location: m.range.location, length: 1), .clear))
            wanted.append((NSRange(location: m.range.location + 1, length: m.range.length - 1), mentionTint))
        }
        for p in pulls where NSMaxRange(p.range) <= storage.length { wanted.append((p.range, mentionTint)) }
        let full = NSRange(location: 0, length: storage.length)
        var stray = false
        storage.enumerateAttribute(.foregroundColor, in: full) { value, range, stop in
            let color = value as? UIColor
            if color != base, !wanted.contains(where: { NSIntersectionRange($0.0, range).length > 0 && $0.1 == color }) {
                stray = true
                stop.pointee = true
            }
        }
        let missing = wanted.contains { range, color in
            (storage.attribute(.foregroundColor, at: range.location, longestEffectiveRange: nil, in: range) as? UIColor) != color
        }
        if stray || missing {
            storage.beginEditing()
            storage.addAttribute(.foregroundColor, value: base, range: full)
            for (range, color) in wanted { storage.addAttribute(.foregroundColor, value: color, range: range) }
            storage.endEditing()
        }
        // The chip's wider sides (`MentionChip.extra`): kerning on its @ and its last letter.
        let extra = MentionChip.extra(font?.pointSize ?? 17)
        var kerns: [Int: CGFloat] = [:]
        for m in mentions where NSMaxRange(m.range) <= storage.length && m.range.length > 1 {
            kerns[m.range.location] = 2 * extra
            kerns[NSMaxRange(m.range) - 1] = extra
        }
        // A pull request's chip has no × to make room before it: the letter before it does.
        for p in pulls where NSMaxRange(p.range) <= storage.length && p.range.length > 1 {
            if p.range.location > 0 { kerns[p.range.location - 1] = max(kerns[p.range.location - 1] ?? 0, extra) }
            kerns[NSMaxRange(p.range) - 1] = extra
        }
        // Two chips with only a space between: it's kerned so they stand apart.
        if let between, between.size == font?.pointSize, between.kern != 0 {
            for space in spacesBetweenChips(in: storage.string as NSString) { kerns[space] = between.kern }
        }
        func kern(at i: Int) -> CGFloat { CGFloat((storage.attribute(.kern, at: i, effectiveRange: nil) as? NSNumber)?.doubleValue ?? 0) }
        var strayKern = false
        storage.enumerateAttribute(.kern, in: full) { value, range, stop in
            guard let k = (value as? NSNumber).map({ CGFloat($0.doubleValue) }), k != 0 else { return }
            if (range.location..<NSMaxRange(range)).contains(where: { kerns[$0] != k }) {
                strayKern = true
                stop.pointee = true
            }
        }
        if strayKern || kerns.contains(where: { kern(at: $0.key) != $0.value }) {
            storage.beginEditing()
            storage.removeAttribute(.kern, range: full)
            for (at, k) in kerns { storage.addAttribute(.kern, value: k, range: NSRange(location: at, length: 1)) }
            storage.endEditing()
        }
        // Room between its lines for the chips on them (`MentionChip.leading`), so a chip doesn't
        // meet the one under it or the caret on the next line.
        let spacing = font.map(MentionChip.leading) ?? 0
        var spaced = true
        storage.enumerateAttribute(.paragraphStyle, in: full) { value, _, stop in
            if (value as? NSParagraphStyle)?.lineSpacing != spacing {
                spaced = false
                stop.pointee = true
            }
        }
        let style = NSMutableParagraphStyle()
        style.lineSpacing = spacing
        if !spaced {
            storage.beginEditing()
            storage.addAttribute(.paragraphStyle, value: style, range: full)
            storage.endEditing()
        }
        // What's typed next is plain text, also right after a chip.
        typingAttributes[.foregroundColor] = base
        typingAttributes[.kern] = nil
        typingAttributes[.paragraphStyle] = style
    }

    private func layoutChips() {
        let key = (text: text ?? "", width: bounds.width, size: font?.pointSize ?? 0)
        if let done = chipsFor, done == key { return }
        chipsFor = key
        chips.forEach { $0.removeFromSuperview() }
        chips = []
        let size = font?.pointSize ?? 17
        let symbolSize = max(9, size * 0.55)
        let symbol = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: symbolSize, weight: .semibold))
        var boxes: [Int: (first: CGRect, last: CGRect)] = [:]
        for mention in mentions {
            guard NSMaxRange(mention.range) <= (text as NSString).length,
                  let start = position(from: beginningOfDocument, offset: mention.range.location),
                  let at = position(from: start, offset: 1),
                  let sign = textRange(from: start, to: at) else { continue }
            let mark = firstRect(for: sign)
            guard !mark.isNull, !mark.isInfinite else { continue }
            let lines = chipLines(mention.range)
            // The × keeps the chip's room on both sides, as the name's last letter has it: set
            // back from the name's first letter (its ink starts a side bearing, about 0.08 of the
            // size, past the @ and its kerning), and the chip's edge as far again before it. The
            // ×'s strokes are about 0.82 of its point size across (measured off a phone).
            let side = MentionChip.side(size)
            let half = symbolSize * 0.41
            let nameStart = caretRect(for: at).minX
            let x = nameStart + size * 0.08 - side - half
            let lastInk = inkEnd(at: NSMaxRange(mention.range) - 1, size: size)
            var first: CGRect?
            for (i, line) in lines.enumerated() {
                let box = chipBox(line, from: i == 0 ? x - half : nil, to: i == lines.count - 1 ? lastInk : nil)
                if i == 0 { first = box }
                boxes[mention.range.location] = (first ?? box, box)
                // Behind the text.
                let chip = MentionChip.view(box, tint: mentionTint)
                insertSubview(chip, at: 0)
                chips.append(chip)
                // Over it: the name opens the file; held, it drags to another place in the text.
                let open = ChipButton(type: .custom, primaryAction: UIAction { [weak self] _ in self?.openMention?(mention) })
                open.mention = mention
                open.frame = box.union(line)
                open.accessibilityLabel = "Open \(mention.path)"
                let hold = UILongPressGestureRecognizer(target: self, action: #selector(dragChip(_:)))
                hold.minimumPressDuration = 0.25
                open.addGestureRecognizer(hold)
                addSubview(open)
                chips.append(open)
            }
            // The × in the @'s place takes it out, on the chip's middle.
            guard let first else { continue }
            let remove = UIButton(type: .custom, primaryAction: UIAction { [weak self] _ in self?.removeMention?(mention) })
            remove.frame = CGRect(x: x - mark.width / 2 - 4, y: first.minY, width: mark.width + 8, height: first.height)
            remove.setImage(symbol, for: .normal)
            remove.tintColor = mentionTint.withAlphaComponent(0.8)
            remove.accessibilityLabel = "Remove \(mention.path)"
            addSubview(remove)
            chips.append(remove)
        }
        for link in pulls {
            guard NSMaxRange(link.range) <= (text as NSString).length else { continue }
            let lines = chipLines(link.range)
            let firstInk = position(from: beginningOfDocument, offset: link.range.location).map { caretRect(for: $0).minX + MentionChip.bearing(size) }
            let lastInk = inkEnd(at: NSMaxRange(link.range) - 1, size: size)
            for (i, line) in lines.enumerated() {
                let box = chipBox(line, from: i == 0 ? firstInk : nil, to: i == lines.count - 1 ? lastInk : nil)
                let chip = MentionChip.view(box, tint: mentionTint)
                insertSubview(chip, at: 0)
                chips.append(chip)
                let open = ChipButton(type: .custom, primaryAction: UIAction { [weak self] _ in self?.openPull?(link) })
                open.frame = box.union(line)
                open.accessibilityLabel = "Open \(link.pull.label) in Review"
                addSubview(open)
                chips.append(open)
            }
        }
        standChipsApart(boxes, size: size)
    }

    /// Where a letter's ink ends, short of its kerning: where it starts, as wide as it is.
    private func inkEnd(at offset: Int, size: CGFloat) -> CGFloat? {
        position(from: beginningOfDocument, offset: offset).map { start in
            caretRect(for: start).minX + ((text as NSString).substring(with: NSRange(location: offset, length: 1)) as NSString).size(withAttributes: [.font: font ?? UIFont.systemFont(ofSize: size)]).width - MentionChip.bearing(size)
        }
    }

    /// Each space with a chip's last letter before it and another chip's @ after it.
    private func spacesBetweenChips(in text: NSString) -> [Int] {
        let sorted = mentions.filter { NSMaxRange($0.range) <= text.length }.sorted { $0.range.location < $1.range.location }
        return zip(sorted, sorted.dropFirst()).compactMap { a, b in
            let space = b.range.location - 1
            return space == NSMaxRange(a.range) && text.character(at: space) == 0x20 ? space : nil
        }
    }

    /// Chips side by side each reach into the space between them (the room at their sides, the
    /// × before the name), so their boxes meet. That space is kerned for `MentionChip.gap`
    /// between them, from two that are on one line: kerning it moves the second box and nothing
    /// in the first, so once measured it's right, and it's the same for any two at this size.
    private func standChipsApart(_ boxes: [Int: (first: CGRect, last: CGRect)], size: CGFloat) {
        let ns = textStorage.string as NSString
        for space in spacesBetweenChips(in: ns) {
            guard let a = mentions.first(where: { NSMaxRange($0.range) == space }),
                  let left = boxes[a.range.location]?.last, let right = boxes[space + 1]?.first,
                  abs(left.midY - right.midY) < 1 else { continue }
            let kern = CGFloat((textStorage.attribute(.kern, at: space, effectiveRange: nil) as? NSNumber)?.doubleValue ?? 0)
            let wanted = max(0, kern + MentionChip.gap(size) - (right.minX - left.maxX))
            if abs(wanted - kern) > 0.25 {
                between = (size, wanted)
                styleMentions()
                chipsFor = nil
                setNeedsLayout()
            }
            return
        }
    }

    /// A chip's box on one line: from the ×'s strokes (`from`, on the line the mention starts
    /// on) to the last letter's ink (`to`, on the line it ends on), with the composer's wider
    /// sides (`MentionChip.side`).
    private func chipBox(_ line: CGRect, from left: CGFloat?, to right: CGFloat?) -> CGRect {
        guard let font else { return line.insetBy(dx: -2, dy: 0) }
        return MentionChip.box(baseline: MentionChip.baseline(line, font: font, leading: MentionChip.leading(font)), left: left ?? line.minX, right: right ?? line.maxX, font: font, side: MentionChip.side(font.pointSize))
    }

    private final class ChipButton: UIButton {
        var mention: Mention?
    }

    /// Held, a chip lifts: its copy follows the finger and a caret shows where it would land
    /// (the text's own nearest place); let go, it moves there.
    @objc private func dragChip(_ hold: UILongPressGestureRecognizer) {
        let point = hold.location(in: self)
        switch hold.state {
        case .began:
            guard let mention = (hold.view as? ChipButton)?.mention else { return }
            let ghost = UILabel()
            ghost.text = " \((text as NSString).substring(with: mention.range)) "
            ghost.font = font
            ghost.textColor = mentionTint
            ghost.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.95)
            ghost.layer.cornerRadius = 6
            ghost.layer.cornerCurve = .continuous
            ghost.layer.borderWidth = 1
            ghost.layer.borderColor = mentionTint.withAlphaComponent(0.5).cgColor
            ghost.layer.masksToBounds = true
            ghost.sizeToFit()
            ghost.isUserInteractionEnabled = false
            let caret = UIView()
            caret.backgroundColor = mentionTint
            caret.layer.cornerRadius = 1
            caret.isHidden = true
            addSubview(caret)
            addSubview(ghost)
            chipDrag = (mention, ghost, caret, nil)
            UISelectionFeedbackGenerator().selectionChanged()
            follow(point)
        case .changed:
            follow(point)
        case .ended:
            if let drag = chipDrag, let to = drag.to { moveMention?(drag.mention, to) }
            endDrag()
        default:
            endDrag()
        }
    }

    private func follow(_ point: CGPoint) {
        guard var drag = chipDrag else { return }
        // Over the finger, where it can be seen.
        drag.ghost.center = CGPoint(x: point.x, y: point.y - drag.ghost.bounds.height)
        if let position = closestPosition(to: point) {
            let rect = caretRect(for: position)
            drag.caret.frame = CGRect(x: rect.minX - 1, y: rect.minY, width: 2, height: rect.height)
            drag.caret.isHidden = false
            drag.to = offset(from: beginningOfDocument, to: position)
        }
        chipDrag = drag
    }

    private func endDrag() {
        chipDrag?.ghost.removeFromSuperview()
        chipDrag?.caret.removeFromSuperview()
        chipDrag = nil
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.font = AhType.uiFont(.body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.numberOfLines = 1
        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)
        NotificationCenter.default.addObserver(self, selector: #selector(textChanged), name: UITextView.textDidChangeNotification, object: self)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        if sizesAsBox {
            // The box grows a line after the text does, and the caret's scroll from the line before
            // stayed, cutting off the first line; once it all fits, it sits at the top. Only when
            // there's nothing to scroll: within a fraction of a point of fitting, UIKit scrolls the
            // caret into view, this put it back, and the two could take turns without end.
            centreShortLine()
            if contentSize.height <= bounds.height, contentOffset.y != -adjustedContentInset.top {
                contentOffset.y = -adjustedContentInset.top
            }
            fadeEdges()
        }
        layoutChips()
        placeholderLabel.frame = CGRect(x: textContainerInset.left + 5, y: textContainerInset.top, width: bounds.width - textContainerInset.left - textContainerInset.right - 10, height: placeholderLabel.font.lineHeight)
        // Hints drop from the end, whole, rather than end mid-word in an ellipsis. Fitted again
        // only when the hint, its room or its type size changes: this runs on every scroll.
        let font = placeholderLabel.font ?? AhType.uiFont(.body)
        let fit = PlaceholderFit(placeholder: placeholder, width: placeholderLabel.frame.width, size: font.pointSize)
        if fit != placeholderFit {
            placeholderFit = fit
            placeholderLabel.text = ComposerModel.fitting(placeholder, width: fit.width) { ($0 as NSString).size(withAttributes: [.font: font]).width }
        }
        placeholderLabel.isHidden = hasText
    }

    /// The room above and below the text, and the least the field stands.
    static let verticalInset: CGFloat = 6
    static let leastHeight: CGFloat = 32

    /// A line shorter than the field's least height sits in its middle: at the top, in a
    /// small text size it rode high in the box, and + and Send low beside it. Worked out
    /// from the laid-out height and the font alone, so it settles in one more pass and
    /// never feeds back into how tall the field is asked to be.
    private func centreShortLine() {
        let line = ceil(font?.lineHeight ?? 20) + Self.verticalInset * 2
        let spare = bounds.height <= Self.leastHeight + 0.5 ? max(0, bounds.height - line) / 2 : 0
        let wanted = Self.verticalInset + (spare * 2).rounded() / 2
        guard abs(textContainerInset.top - wanted) > 0.01 else { return }
        textContainerInset.top = wanted
        textContainerInset.bottom = wanted
    }

    /// A message longer than the box fades out at whichever edge has more beyond it, rather
    /// than cut a line in half there. (Laid out on every scroll, so it follows along.)
    private func fadeEdges() {
        guard contentSize.height > bounds.height + 1 else {
            if layer.mask != nil { layer.mask = nil }
            return
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if layer.mask == nil { layer.mask = fade }
        fade.frame = bounds
        let edge = min(14 / max(bounds.height, 1), 0.3)
        let above = contentOffset.y > -adjustedContentInset.top + 0.5
        let below = contentOffset.y + bounds.height < contentSize.height + adjustedContentInset.bottom - 0.5
        let solid = UIColor.black.cgColor, clear = UIColor.clear.cgColor
        fade.colors = [above ? clear : solid, solid, solid, below ? clear : solid]
        fade.locations = [0, NSNumber(value: edge), NSNumber(value: 1 - edge), 1]
        CATransaction.commit()
    }

    override var text: String! {
        didSet { placeholderLabel.isHidden = !(text ?? "").isEmpty }
    }

    @objc private func textChanged() { placeholderLabel.isHidden = !text.isEmpty }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        // Composing with an input method (Japanese, Pinyin): Return picks the candidate, the
        // arrows move through them. All of it is the input method's, not a send or a recall.
        if markedTextRange != nil {
            super.pressesBegan(presses, with: event)
            return
        }
        var unhandled = Set<UIPress>()
        for press in presses {
            guard let key = press.key else {
                unhandled.insert(press)
                continue
            }
            let keyPress = KeyPress(key)
            isHardwareReturn = keyPress.key == "Enter"
            if !keyPress.isModifierOnly, coordinator?.handle(keyPress, in: self) == true { continue }
            unhandled.insert(press)
        }
        if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
        isHardwareReturn = false
    }

    /// What the box takes besides text: the types a paste (or a drop on the text) may bring.
    static let pastedTypes = [UTType.plainText, .utf8PlainText, .text, .url, .image, .audiovisualContent, .content, .archive].map(\.identifier)

    /// The box attaches pasted media (a shell's first command on New session takes none).
    var takesMedia = true

    /// Media with no text beside it: a screenshot copied on the iPad, or on a Mac nearby, a
    /// video or a recording, a PDF or another file. Told by its types, so any kind counts:
    /// the pasteboard's own image list left some out (a photo's HEIC), and those pasted as
    /// nothing. A link is text (it pastes as itself).
    static func isMedia(_ provider: NSItemProvider) -> Bool { isMedia(types: provider.registeredTypeIdentifiers) }

    static func isMedia(types identifiers: [String]) -> Bool {
        let types = identifiers.compactMap(UTType.init)
        return !types.contains { $0.conforms(to: .text) } && types.contains { ($0.conforms(to: .content) || $0.conforms(to: .archive)) && !$0.conforms(to: .url) }
    }

    /// A pasted item, for a `UITextPasteDelegate`: media goes to the owner to attach, the rest
    /// pastes as it would.
    static func paste(_ item: any UITextPasteItem, to owner: any ComposerTextViewOwner, takesMedia: Bool = true) {
        guard takesMedia, isMedia(item.itemProvider) else {
            item.setDefaultResult()
            return
        }
        owner.pasteMedia([item.itemProvider])
        item.setNoResult()
    }

    /// By the pasteboard's types alone: asked whenever a menu is checked, and reading what's
    /// on the pasteboard would ask the person to allow the paste each time.
    private var pastesMedia: Bool {
        let board = UIPasteboard.general
        return takesMedia && board.numberOfItems > 0 && Self.isMedia(types: board.types)
    }

    override func paste(_ sender: Any?) {
        if pastesMedia {
            coordinator?.pasteMedia(UIPasteboard.general.itemProviders)
            return
        }
        if let pasted = UIPasteboard.general.string, coordinator?.pasteLargeText(pasted) == true {
            return
        }
        super.paste(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) && pastesMedia { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    /// A box's height for its text at the width offered: its lines, at least one, at most
    /// eight, and no more than `maxHeight`. `kept` holds the answers so far, by text and width.
    struct Measure: Hashable {
        let text: String
        let lines: CGFloat
        let line: CGFloat
    }

    func fitting(_ proposal: ProposedViewSize, maxHeight: CGFloat, kept: inout [Measure: CGFloat]) -> CGSize {
        let width = proposal.width ?? (bounds.width > 0 ? bounds.width : 320)
        let line = font?.lineHeight ?? 20
        // Measured from the text itself: the view's own answer came from its last layout, so a
        // box emptied after a long message stayed that tall around a word.
        let inset = textContainerInset
        let lines = width - inset.left - inset.right - textContainer.lineFragmentPadding * 2
        // SwiftUI asks several times a pass, at the same few widths: each answer is kept until
        // the text, the width or the type size changes.
        let key = Measure(text: text ?? "", lines: lines, line: line)
        let cap = max(Self.leastHeight, maxHeight)
        if let known = kept[key] { return CGSize(width: width, height: min(known, cap)) }
        let text = attributedText ?? NSAttributedString()
        var height = text.boundingRect(with: CGSize(width: max(lines, 1), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height
        // A new line just begun counts before anything is typed on it.
        if text.string.hasSuffix("\n") { height += line }
        // Only measured here, nothing set: SwiftUI asks at several widths in one pass, and an
        // inset changed from inside the measuring (to centre a short line) changed between
        // them, each change asking for another pass. The window never drew again. The line
        // is centred where the view is laid out (`centreShortLine`).
        height = ceil(max(height, line)) + Self.verticalInset * 2
        let fitted = min(max(height, Self.leastHeight), line * 8 + 12)
        if kept.count > 8 { kept.removeAll(keepingCapacity: true) }
        kept[key] = fitted
        return CGSize(width: width, height: min(fitted, cap))
    }
}

/// Whether a hardware keyboard is attached: hints name keys only when there are keys.

/// Queued follow-ups above the composer (`apps/server/web/QueueTray.tsx`): Send now, Edit, Cancel,
/// drag to reorder; and our own just-queued messages until the host lists them. Above them, what
/// was typed in and the agent never took: Send Again, Edit, Let Go.
struct QueueTrayView: View {
    @Bindable var queue: QueueModel
    let composer: ComposerModel
    var working = false
    /// Held behind the agent's folder-trust prompt: nothing goes in, or can be steered in, until it's answered.
    var held = false
    var hardwareKeyboard = false
    /// Only its line: how many, and what goes next.
    var folded = false
    /// The most the whole tray may take, its line included: past it, the list scrolls inside the
    /// tray. Less than `leastOpen` and only the line shows (a phone on its side, the keyboard up).
    var maxHeight: CGFloat = .infinity
    var toggleFold: () -> Void = {}
    /// The whole queue in the session's Queue panel, to read and arrange it there.
    var showInPanel: (() -> Void)?
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The list's own height, the line's and the "more" row's, as laid out: the list's scroll view
    /// is no taller than its content or than what the tray's budget leaves it. None of them depends
    /// on the budget, so measuring them can't feed back.
    @State private var listHeight: CGFloat = 0
    @State private var lineHeight: CGFloat = 52
    @State private var moreHeight: CGFloat = 0
    /// A row, about: the least room worth opening the list for, and its height before it's measured.
    @ScaledMetric(relativeTo: .callout) private var rowHeight: CGFloat = 48
    /// Less budget than this and the tray keeps to its line.
    static let leastOpen: CGFloat = 110
    /// How the queue folds and opens; the conversation above it moves in the same.
    static let motion = Animation.snappy(duration: 0.25)
    private var expanded: Bool { queue.expanded }
    /// Nothing queued, only what never went in: the line says that instead of what's next.
    private var onlyUnsent: Bool { queue.items.isEmpty && queue.pendingRows.isEmpty }

    /// What's next stays in view; the rest fold into a row that says how many. Five long
    /// messages took half the screen over the conversation they were waiting on.
    private static let shownFolded = 2

    var body: some View {
        if !queue.isEmpty {
            // Folded, or no room to open: only the line, which says what goes next.
            let shut = folded || maxHeight < Self.leastOpen
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    // The line folds the queue, and opens it again.
                    Button(action: toggleFold) {
                        HStack(spacing: 8) {
                            Image(systemName: "text.line.first.and.arrowtriangle.forward").foregroundStyle(theme.accent)
                            VStack(alignment: .leading, spacing: 0) {
                                HStack(spacing: 5) {
                                    // The count rolls as messages join and leave, as the tray already moves.
                                    Text(onlyUnsent ? "Not sent · \(queue.unsent.count)" : "Up next · \(queue.items.count + queue.pendingRows.count)").font(.ah(.footnote).weight(.semibold))
                                        .contentTransition(.numericText(value: Double(onlyUnsent ? queue.unsent.count : queue.items.count + queue.pendingRows.count)))
                                    Image(systemName: "chevron.down")
                                        .font(.ah(.caption2).weight(.bold))
                                        .foregroundStyle(theme.faint)
                                        .rotationEffect(.degrees(shut ? -90 : 0))
                                }
                                // Folded, it still says what goes next.
                                Text(onlyUnsent ? (shut ? queue.unsent.first.map { Uploads.summary($0.text) } ?? "" : "Typed in, but the agent never took it")
                                     : shut ? (queue.items.first.map { Uploads.summary($0.text) } ?? "Sending…") : held ? "Sent once you answer above" : working ? "Sent one by one when this turn ends" : "Sending…")
                                    .font(.ah(.caption2)).foregroundStyle(theme.muted).lineLimit(1)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(onlyUnsent ? "Not sent, \(queue.unsent.count)" : "Up next, \(queue.items.count + queue.pendingRows.count) queued")
                    .accessibilityValue(shut ? "Folded" : "Open")
                    .accessibilityHint(shut ? "Shows the queued messages" : "Folds the queue to one line")
                    Spacer()
                    if let showInPanel {
                        Button(action: showInPanel) {
                            Image(systemName: "list.bullet.rectangle")
                                .font(.ah(.callout))
                                .foregroundStyle(theme.muted)
                                .frame(width: 34, height: 30)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.ahPress)
                        .accessibilityLabel("Show the queue in a panel")
                    }
                    if !held, let first = queue.items.first, !queue.sending.contains(first.id) {
                        Button {
                            Haptics.threshold()
                            Task { await queue.steer(first) }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "bolt.fill")
                                // One name for it wherever it is: the rows, the menus and the panel say Send Now.
                                Text("Send Now")
                                if hardwareKeyboard { Text("↵").foregroundStyle(theme.accent.opacity(0.7)) }
                            }
                            .font(.ah(.caption).weight(.semibold))
                        }
                        // The accent's tint, not its fill: Queue below is the one filled pink
                        // control, and two of them side by side asked for the same glance.
                        .buttonStyle(.bordered)
                        .tint(theme.accent)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .accessibilityHint("Stops the current turn and sends the first queued message now")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 6)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { lineHeight = $0 }
                if !shut {
                    let folds = queue.items.count > Self.shownFolded + 1
                    let shown = Array(queue.items.enumerated().prefix(folds && !expanded ? Self.shownFolded : queue.items.count))
                    // The list, with what's still uploading and any error, scrolls inside the tray's
                    // budget; the line above and the "more" row below stay put.
                    let room = max(0, maxHeight - lineHeight - (folds ? moreHeight : 0) - 4)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(queue.unsent) { unsentRow($0) }
                            rows(shown)
                            ForEach(queue.pendingRows) { pending in
                                HStack(spacing: 10) {
                                    ProgressView().controlSize(.mini).frame(width: 20)
                                    Text(Uploads.summary(pending.text)).font(.ah(.callout)).foregroundStyle(theme.muted).lineLimit(1)
                                    Spacer()
                                    // Queued before its attachments were up: how far they've got.
                                    if let fraction = composer.outbox.progress(pending) {
                                        Text(fraction >= 0.995 ? "Finishing the upload" : "Uploading \(Int((fraction * 100).rounded()))%").font(.ah(.caption2)).monospacedDigit().foregroundStyle(theme.faint)
                                            .contentTransition(.numericText())
                                    }
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                            }
                            if let error = queue.error {
                                HStack(alignment: .firstTextBaseline) {
                                    Label(error, systemImage: "exclamationmark.triangle.fill").font(.ah(.caption)).foregroundStyle(theme.danger)
                                    // Its agent exited (agent_gone): start it again; what's queued goes in once it's back.
                                    if queue.offersResume {
                                        Spacer(minLength: 8)
                                        Button("Resume") { Task { await queue.resumeAgent() } }
                                            .font(.ah(.caption).weight(.semibold))
                                            .accessibilityHint("Starts its agent again on this conversation; what's queued goes in once it's back")
                                    }
                                }
                                .padding(.horizontal, 12).padding(.bottom, 8)
                            }
                        }
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .scrollIndicators(listHeight > room ? .automatic : .hidden)
                    .frame(height: min(listHeight > 0 ? listHeight : rowHeight * CGFloat(queue.unsent.count + shown.count + queue.pendingRows.count), room))
                    if folds {
                        Button {
                            withAnimation(reduceMotion ? nil : Self.motion) { queue.expanded.toggle() }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "chevron.down")
                                    .font(.ah(.caption2).weight(.bold))
                                    .rotationEffect(.degrees(expanded ? 180 : 0))
                                Text(expanded ? "Show less" : "\(queue.items.count - Self.shownFolded) more")
                                    .font(.ah(.caption).weight(.semibold))
                                Spacer()
                            }
                            .foregroundStyle(theme.muted)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 32)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(expanded ? "Show fewer queued messages" : "Show \(queue.items.count - Self.shownFolded) more queued messages")
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { moreHeight = $0 }
                    }
                }
            }
            .padding(.bottom, 4)
            // The composer's glass, warmed with the accent: these are yours, waiting their turn.
            .glassEffect(.regular.tint(theme.accent.opacity(0.06)), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            // Folding and unfolding, the rows fade inside the tray as it closes onto the box or
            // grows out of it: unclipped, they went with the line above as it moved, over the
            // box and below it.
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.items.map(\.id))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.unsent.map(\.id))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.sending)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Queued messages")
            .accessibilityIdentifier("queue-tray")
        }
    }

    private func rows(_ items: [(offset: Int, element: QueueItem)]) -> some View {
        ForEach(items, id: \.element.id) { index, item in
            row(index: index, item: item)
                .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .scale(scale: 0.9).combined(with: .opacity)))
        }
    }

    private func queueGlyph(_ symbol: String) -> some View {
        Image(systemName: symbol).frame(width: 34, height: 34).contentShape(Rectangle())
    }

    /// One the agent never took: it may still sit in the terminal's box, so it isn't typed again
    /// unless you say so.
    private func unsentRow(_ item: QueueItem) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.ah(.callout))
                .foregroundStyle(theme.danger)
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(Uploads.summary(item.text)).font(.ah(.callout)).lineLimit(2)
                Text("Not sent · it may still be in the terminal’s box").font(.ah(.caption2)).foregroundStyle(theme.danger).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if queue.sending.contains(item.id) {
                ProgressView().controlSize(.small)
            } else {
                HStack(spacing: 10) {
                    if !held {
                        Button { Haptics.threshold(); Task { await queue.steer(item) } } label: { queueGlyph("paperplane") }
                            .accessibilityLabel("Send Again")
                            .accessibilityHint("Types it in again and sends it")
                    }
                    Button { Task { await queue.edit(item, into: composer) } } label: { queueGlyph("pencil") }
                        .accessibilityLabel("Edit")
                    Button(role: .destructive) { Task { await queue.cancel(item) } } label: { queueGlyph("xmark") }
                        .accessibilityLabel("Let Go")
                }
                .buttonStyle(.ahPress)
                .font(.ah(.callout))
                .foregroundStyle(theme.muted)
            }
        }
        .frame(minHeight: 34)
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .contextMenu {
            if !held { Button("Send Again", systemImage: "paperplane") { Task { await queue.steer(item) } } }
            Button("Edit", systemImage: "pencil") { Task { await queue.edit(item, into: composer) } }
            Divider()
            Button("Let Go", systemImage: "xmark", role: .destructive) { Task { await queue.cancel(item) } }
        }
        .accessibilityIdentifier("queue-unsent-row")
    }

    private func row(index: Int, item: QueueItem) -> some View {
        HStack(spacing: 10) {
            Text("\(index + 1)")
                .font(.ah(.caption2).weight(.bold).monospacedDigit())
                .foregroundStyle(theme.accent)
                .frame(width: 20, height: 20)
                .background(theme.accent.opacity(0.12), in: Circle())
            Text(Uploads.summary(item.text)).font(.ah(.callout)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            if queue.sending.contains(item.id) {
                ProgressView().controlSize(.small)
            } else {
                // Glyph-sized to look at, finger-sized to hit: they sat 14 points apart on 16,
                // then 36 on 34-point targets, a thumb's width short of Remove beside Edit.
                HStack(spacing: 10) {
                    if !held {
                        Button { Haptics.threshold(); Task { await queue.steer(item) } } label: { queueGlyph("bolt.fill") }
                            .accessibilityLabel("Send Now")
                            .accessibilityHint("Stops the current turn and sends this now")
                    }
                    Button { Task { await queue.edit(item, into: composer) } } label: { queueGlyph("pencil") }
                        .accessibilityLabel("Edit")
                    Button(role: .destructive) { Task { await queue.cancel(item) } } label: { queueGlyph("xmark") }
                        .accessibilityLabel("Remove")
                }
                .buttonStyle(.ahPress)
                .font(.ah(.callout))
                .foregroundStyle(theme.muted)
            }
        }
        // As tall while it sends as with its buttons; the last glyph's room is the margin.
        .frame(minHeight: 34)
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .contextMenu {
            if !held { Button("Send Now", systemImage: "bolt.fill") { Task { await queue.steer(item) } } }
            Button("Edit", systemImage: "pencil") { Task { await queue.edit(item, into: composer) } }
            if index > 0 { Button("Move Up", systemImage: "arrow.up") { Task { await queue.move(item.id, to: index - 1) } } }
            if index < queue.items.count - 1 { Button("Move Down", systemImage: "arrow.down") { Task { await queue.move(item.id, to: index + 1) } } }
            Divider()
            Button("Remove", systemImage: "xmark", role: .destructive) { Task { await queue.cancel(item) } }
        }
        .draggable(item.id) {
            Text(Uploads.summary(item.text)).padding(8).background(theme.raised, in: RoundedRectangle(cornerRadius: 10))
        }
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, id != item.id else { return false }
            Task { await queue.move(id, to: index) }
            return true
        }
    }
}

/// + in a box's corner: attach from the photo library, the camera, Files or the clipboard
/// (and, in a session's box, go back to the previous message). The upload starts as soon as
/// something's picked. A session's composer and New session's box both have it.
struct AttachMenu: View {
    let composer: ComposerModel
    /// A session's box offers ↑'s Previous Message here too.
    var recall = false
    @Environment(\.theme) private var theme
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44
    @State private var pickingPhotos: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var takingPhoto = false
    @State private var importingFiles = false

    var body: some View {
        Menu {
            Section {
                Button("Photo Library", systemImage: "photo.on.rectangle") { choosingPhotos = true }
                if CameraPicker.isAvailable { Button("Take Photo", systemImage: "camera") { takingPhoto = true } }
                Button("Choose Files", systemImage: "folder") { importingFiles = true }
                if UIPasteboard.general.hasImages { Button("Paste Image", systemImage: "doc.on.clipboard") { pasteImage() } }
            }
            if recall, !composer.recent.isEmpty {
                // ↑ in an empty box does this from a keyboard.
                Button("Previous Message", systemImage: "clock.arrow.circlepath") { composer.recall(1) }
            }
        } label: {
            // A glyph in the box's corner, as Send is in the other: no glass of its own.
            Image(systemName: "plus")
                .font(.system(size: control * 0.41, weight: .medium))
                .foregroundStyle(theme.text2)
                .frame(width: control - 12, height: control - 12)
                .contentShape(Circle())
                .contentShape(.hoverEffect, Circle())
                .hoverEffect(.highlight)
                .touchTarget()
        }
        // In the order written, wherever the menu opens: the library first.
        .menuOrder(.fixed)
        .tint(.primary)
        .accessibilityLabel("Attach")
        .onChange(of: pickingPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickingPhotos = []
            for item in items {
                if let ext = Self.videoExtension(item) {
                    composer.attachVideo(name: "video.\(ext)") {
                        guard let video = try await item.loadTransferable(type: LibraryVideo.self) else { throw CocoaError(.fileNoSuchFile) }
                        return (video.file, await video.thumbnail())
                    }
                    continue
                }
                // Named for what it is (a HEIC stays a HEIC), so the agent reads it right.
                let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                Task {
                    await composer.attach(name: "photo.\(ext)", image: true) {
                        guard let data = try await item.loadTransferable(type: Data.self) else { throw CocoaError(.fileNoSuchFile) }
                        return data
                    }
                }
            }
        }
        // Presented from state, not from inside the menu: a PhotosPicker placed in a Menu never
        // opened.
        // `.current`: a video comes as it is, not transcoded first.
        .photosPicker(isPresented: $choosingPhotos, selection: $pickingPhotos, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current, photoLibrary: .shared())
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                guard let data = image.jpegData(compressionQuality: 0.85) else { return }
                Task { await composer.attach(name: "photo.jpg", data: data, image: true, thumbnail: data) }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $importingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                Task {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { return }
                    let image = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) ?? false
                    await composer.attach(name: url.lastPathComponent, data: data, image: image, thumbnail: image ? data : nil)
                }
            }
        }
    }

    /// A picked item's file extension if it's a video (a Live Photo is a photo).
    private static func videoExtension(_ item: PhotosPickerItem) -> String? {
        let types = item.supportedContentTypes
        guard !types.contains(where: { $0.conforms(to: .image) }), let movie = types.first(where: { $0.conforms(to: .movie) }) else { return nil }
        return movie.preferredFilenameExtension ?? "mov"
    }

    private func pasteImage() {
        guard let image = UIPasteboard.general.image, let data = image.pngData() else { return }
        Task { await composer.attach(name: "paste.png", data: data, image: true, thumbnail: data) }
    }
}

/// What's attached, as tiles above a box's text: the picture or the file's name, the upload's
/// ring while it goes up, and × to take it off. Once up, a tile opens what it is in Quick Look.
struct AttachmentTiles: View {
    let composer: ComposerModel
    var onRemoved: ((ComposerModel.Attachment) -> Void)? = nil
    @Environment(\.theme) private var theme
    @Environment(\.hostFiles) private var hostFiles

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(composer.attachments) { file in
                    Button {
                        guard let path = file.path, let open = hostFiles?.open else { return }
                        Haptics.tap()
                        Task { await open(path) }
                    } label: {
                        Group {
                            if let data = file.thumbnail, let image = UIImage(data: data) {
                                Image(uiImage: image).resizable().scaledToFill().frame(width: 64, height: 64)
                                    .overlay(alignment: .bottomLeading) {
                                        if !file.image {
                                            Image(systemName: "play.fill").font(.ah(.caption2)).foregroundStyle(.white).shadow(radius: 2).padding(6)
                                        }
                                    }
                            } else if let kept = Self.drawn(file) {
                                // Back in the box (Edit on a message): the picture or the video's
                                // frame, from the host.
                                KeptPicture(attachment: kept, side: 64)
                            } else {
                                VStack(alignment: .leading, spacing: 4) {
                                    Image(systemName: "doc.fill").font(.ah(.title3)).foregroundStyle(theme.muted)
                                    Text(file.name).font(.ah(.caption2)).foregroundStyle(.primary).lineLimit(2)
                                }
                                .padding(8)
                                .frame(width: 112, height: 64, alignment: .topLeading)
                                .background(theme.tile)
                            }
                        }
                        .overlay { if file.path == nil { UploadRing(outbox: composer.outbox, upload: file.upload) } }
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .hoverEffect(.lift)
                    }
                    .buttonStyle(TilePress())
                    .disabled(file.path == nil || hostFiles?.open == nil)
                    .overlay(alignment: .topTrailing) {
                        Button {
                            Haptics.tap()
                            withAnimation(.snappy(duration: 0.2)) { composer.removeAttachment(file.id) }
                            onRemoved?(file)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.ah(.body))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.55))
                                .padding(3)
                                // The glyph is small; the finger's target isn't, but keeps to the
                                // corner: at 44 it reached past the tile's middle, where a tap
                                // opens the attachment.
                                .touchTarget(36)
                        }
                        .buttonStyle(.ahPress)
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(file.path == nil ? "Uploading \(file.name)" : file.name)
                    .accessibilityHint(file.path == nil || hostFiles?.open == nil ? "" : "Opens it")
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
            }
            // Inset alike from the box's top and side, so a tile's corner sits concentric in
            // the box's (its 22 less this 10).
            .padding(.top, 2)
        }
        .animation(.snappy(duration: 0.25), value: composer.attachments.map(\.id))
    }

    /// An upload with no picture of its own here that can be drawn from the host's copy: a
    /// picture or a video.
    private static func drawn(_ file: ComposerModel.Attachment) -> Attachment? {
        guard let path = file.path else { return nil }
        let kept = Attachment.upload(Uploads.Upload(path: path, name: file.name, image: file.image))
        return kept.look == .file ? nil : kept
    }
}

/// Compact pillbox chips inside the composer holding quoted message references, reused prompts,
/// and large pasted text blocks. Tapping any chip opens an editable popover so large references
/// stay editable without overcrowding the composer text box.
struct SnippetChips: View {
    let composer: ComposerModel
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editing: ComposerModel.Snippet?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(composer.snippets) { snippet in
                    HStack(spacing: 8) {
                        Button {
                            Haptics.tap()
                            editing = snippet
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: snippet.kind.symbol)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(theme.accent)
                                    .frame(width: 22, height: 22)
                                    .background(theme.accent.opacity(0.12), in: Circle())
                                VStack(alignment: .leading, spacing: 1) {
                                    HStack(spacing: 4) {
                                        Text(snippet.source ?? snippet.kind.title)
                                            .font(.ah(.caption2).weight(.semibold))
                                            .foregroundStyle(theme.muted)
                                        Text("· \(snippet.body.count) chars")
                                            .font(.ah(.caption2))
                                            .foregroundStyle(theme.faint)
                                    }
                                    .lineLimit(1)
                                    Text(snippet.preview)
                                        .font(.ah(.caption))
                                        .foregroundStyle(theme.text)
                                        .lineLimit(1)
                                        .truncationMode(.tail)
                                }
                                .frame(maxWidth: 168, alignment: .leading)
                                Image(systemName: "pencil")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(theme.accent)
                                    .accessibilityHidden(true)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("snippet-chip-\(snippet.kind.rawValue)")
                        .accessibilityLabel("\(snippet.kind.title), \(snippet.body.count) characters, \(snippet.preview)")
                        .accessibilityHint("Opens popover to edit this text")

                        Button {
                            Haptics.selection()
                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) {
                                composer.removeSnippet(snippet.id)
                            }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 15))
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(theme.muted)
                                .touchTarget(32)
                        }
                        .buttonStyle(.ahPress)
                        .accessibilityLabel("Remove \(snippet.kind.title)")
                    }
                    .padding(.leading, 8)
                    .padding(.trailing, 6)
                    .padding(.vertical, 6)
                    .background(theme.tile, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.line, lineWidth: 0.75))
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.85).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 2)
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: composer.snippets.map(\.id))
        .popover(item: $editing, arrowEdge: .bottom) { snippet in
            SnippetEditorPopover(snippet: snippet) { updated in
                composer.updateSnippet(snippet.id, body: updated)
                editing = nil
            } onRemove: {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) {
                    composer.removeSnippet(snippet.id)
                }
                editing = nil
            }
            .presentationCompactAdaptation(.popover)
        }
    }
}

/// Popover editor opened when tapping a quoted/pasted snippet pillbox inside the composer.
private struct SnippetEditorPopover: View {
    let snippet: ComposerModel.Snippet
    let onSave: (String) -> Void
    let onRemove: () -> Void
    @Environment(\.theme) private var theme
    @State private var draft: String
    @FocusState private var focused: Bool

    init(snippet: ComposerModel.Snippet, onSave: @escaping (String) -> Void, onRemove: @escaping () -> Void) {
        self.snippet = snippet
        self.onSave = onSave
        self.onRemove = onRemove
        _draft = State(initialValue: snippet.body)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label(snippet.source ?? snippet.kind.title, systemImage: snippet.kind.symbol)
                    .font(.ah(.subheadline).weight(.semibold))
                    .foregroundStyle(theme.text)
                Text("\(draft.count) chars")
                    .font(.ah(.caption2))
                    .foregroundStyle(theme.muted)
                Spacer(minLength: 8)
                Button(role: .destructive) {
                    onRemove()
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.danger)
                        .touchTarget(32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(snippet.kind.title)")
                Button("Done") {
                    onSave(draft)
                }
                .font(.ah(.subheadline).weight(.semibold))
                .foregroundStyle(theme.accent)
                .buttonStyle(.plain)
                .accessibilityIdentifier("snippet-editor-done")
            }

            TextEditor(text: $draft)
                .font(.ah(.callout))
                .foregroundStyle(theme.text)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(theme.tile, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.line, lineWidth: 0.75))
                .focused($focused)
                .accessibilityIdentifier("snippet-editor-text")
        }
        .padding(14)
        .frame(minWidth: 300, idealWidth: 332, maxWidth: 380, minHeight: 220, idealHeight: 250)
        .background(theme.surface)
        .onAppear { focused = true }
    }
}

/// A file dragged onto a box (from Files, a photo, another app on an iPad) attaches, as a
/// pasted image does.
enum AttachDrop {
    @MainActor
    static func attach(_ providers: [NSItemProvider], to composer: ComposerModel) -> Bool {
        guard !providers.isEmpty else { return false }
        for provider in providers { attachFile(provider, to: composer) }
        Haptics.selection()
        return true
    }

    /// One file, loaded as the type it is and named for it.
    @MainActor
    static func attachFile(_ provider: NSItemProvider, to composer: ComposerModel) {
        let type = provider.registeredContentTypes.first { !$0.conforms(to: .url) || $0.conforms(to: .fileURL) } ?? provider.registeredContentTypes.first ?? .data
        let image = type.conforms(to: .image)
        let name = name(provider, type, or: image ? "image" : "file")
        provider.loadDataRepresentation(for: type) { data, _ in
            guard let data else { return }
            Task { @MainActor in await composer.attach(name: name, data: data, image: image, thumbnail: image ? data : nil) }
        }
    }

    /// The name it came with ("Report.pdf"), or one for what it is ("video.mov").
    static func name(_ provider: NSItemProvider, _ type: UTType, or fallback: String) -> String {
        let given = provider.suggestedName ?? fallback
        if given.contains("."), !given.hasSuffix(".") { return given }
        return type.preferredFilenameExtension.map { "\(given).\($0)" } ?? given
    }
}

/// Media pasted into a box (⌘V, or Paste in the edit menu): a picture as a screenshot is, a
/// video streamed up from a file of its own (one can be too big to hold in memory), any
/// other file as it is.
enum AttachPaste {
    @MainActor
    static func attach(_ providers: [NSItemProvider], to composer: ComposerModel) {
        for provider in providers {
            let types = provider.registeredContentTypes
            if types.contains(where: { $0.conforms(to: .image) }) {
                // Loaded as it comes: a screenshot handed over from a Mac (Universal Clipboard)
                // arrives a moment later, and a photo may be HEIC.
                provider.loadObject(ofClass: UIImage.self) { object, _ in
                    guard let data = (object as? UIImage)?.pngData() else { return }
                    Task { @MainActor in await composer.attach(name: "paste.png", data: data, image: true, thumbnail: data) }
                }
            } else if let movie = types.first(where: { $0.conforms(to: .movie) }) {
                let pasted = Pasted(provider: provider)
                composer.attachVideo(name: AttachDrop.name(provider, movie, or: "video")) {
                    let file = try await copy(pasted.provider, movie)
                    return (file, await VideoFrame.first(of: file))
                }
            } else {
                AttachDrop.attachFile(provider, to: composer)
            }
        }
    }

    /// A pasted item's provider, handed to the upload that loads it: only read from there once
    /// handed over (an item provider loads on any thread).
    private struct Pasted: @unchecked Sendable {
        let provider: NSItemProvider
    }

    /// The pasted file, copied out to one of this app's own before the provider takes its away.
    private static func copy(_ provider: NSItemProvider, _ type: UTType) async throws -> URL {
        try await withCheckedThrowingContinuation { done in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, error in
                guard let url else { return done.resume(throwing: error ?? CocoaError(.fileNoSuchFile)) }
                let ext = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "mov") : url.pathExtension
                let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
                do {
                    try FileManager.default.copyItem(at: url, to: file)
                    done.resume(returning: file)
                } catch {
                    done.resume(throwing: error)
                }
            }
        }
    }
}

/// A video's first frame, small, for its tile.
enum VideoFrame {
    static func first(of file: URL) async -> Data? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 256, height: 256)
        guard let frame = try? await generator.image(at: .zero).image else { return nil }
        return UIImage(cgImage: frame).jpegData(compressionQuality: 0.7)
    }
}

/// A video out of the photo library, as a file of this app's own: too big to load as `Data`.
private struct LibraryVideo: Transferable {
    let file: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: file)
            return LibraryVideo(file: file)
        }
    }

    /// Its first frame for the tile.
    func thumbnail() async -> Data? { await VideoFrame.first(of: file) }
}

/// An attachment's upload as it goes, over its dimmed tile: a ring filling as the bytes go
/// up (a spinner while there's nothing to count yet, as a photo comes from iCloud). Its own
/// view, so only it draws again as the share moves.
struct UploadRing: View {
    let outbox: Outbox
    let upload: Int?
    var size: CGFloat = 26

    var body: some View {
        let fraction = upload.flatMap { outbox.uploads[$0] } ?? 0
        ZStack {
            Color.black.opacity(0.3)
            if fraction < 0.01 {
                ProgressView().tint(.white)
            } else {
                Circle().stroke(.white.opacity(0.3), lineWidth: 3).frame(width: size, height: size)
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: size, height: size)
                    .animation(.spring(duration: 0.35, bounce: 0), value: fraction)
            }
        }
        .accessibilityHidden(true)
    }
}
