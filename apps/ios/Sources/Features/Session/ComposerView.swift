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
    @ScaledMetric(relativeTo: .body) private var corner: CGFloat = 22
    /// How wide Send (or Queue, Run, Stop) is in the box's corner: the text wraps short of it.
    @State private var sendSize = CGSize.zero
    /// How wide + is in the box's other corner: the text starts past it.
    @State private var attachSize = CGSize.zero
    /// How tall the box and the text in it are, as laid out: a box of one line centres what
    /// sits in its corners.
    @State private var boxHeight: CGFloat = 0
    @State private var textHeight: CGFloat = 0
    /// A file is being dragged over the box.
    @State private var dropTargeted = false
    @Namespace private var glass

    private var hasTray: Bool { ComposerFloat.hasTray(session) }
    /// Dictation is listening and the box shows it (`DictationWaves`).
    private var listening: Bool { session.dictation.showsWaves }
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
        let keeps = roomHeight > 300 ? Self.transcriptKeeps : 0
        return max(ComposerTextView.leastHeight, roomHeight - queueLine - tiles - 36 - keeps)
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
                    .padding(.leading, 12 + attachSize.width + 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // One slim glass field the width of the bar, + in its leading corner and Send in
            // its trailing one (beside the box, + left it short, and what floated over it
            // read as loose); the settings chips wait folded away until a swipe up brings
            // them out, floating over the transcript above the box (`ComposerFloat`):
            // nothing here changes height for them, so the transcript doesn't move. A
            // dangerous permission mode is a red shield in the header: as a chip kept out
            // over the box, it took a row of the screen for as long as the mode lasted.
            field
                // Over the glass, not under it: laid on the box from within, a mark
                // showed only as a smear refracted through it. Centred, as a sheet's is.
                .overlay(alignment: .top) { grabber }
                .gesture(ComposerSwipe { swiped($0) })
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        // For the layout tests (ConversationLayoutUITests): where the whole bar is.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer-dock")
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
        // Come back to the session and the box is as it rests, settings folded. Left while
        // listening, what was said goes into this session's box.
        .onDisappear {
            composer.trayOpen = false
            if session.dictation.isListening { Task { await session.dictation.finish(into: composer) } }
            // Still waiting to start (a permission prompt, a language's download): not after leaving.
            else if session.dictation.phase == .starting { Task { await session.dictation.cancel(in: composer) } }
        }
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

    /// A swipe up brings the settings out; a swipe down folds them, or puts the keyboard away.
    private func swiped(_ direction: ComposerSwipe.Direction) {
        switch direction {
        case .up:
            guard hasTray, !trayOpen else { return }
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

    /// How far up from the box's bottom edge Send (or Stop) sits: centred on a line of text,
    /// so in a one-line box it's centred in the box, and in a longer one it's on the last line.
    /// A fixed inset left it low, since a line of body text with its insets is taller than the
    /// button plus twice the inset.
    private var cornerInset: CGFloat { cornerInset(for: sendSize.height) }

    /// The same for anything else in a corner (+), by its own height: measured against Send's,
    /// + rode high while Send was folded away to nothing.
    /// A box of one line, nothing attached above it, centres them in itself as it's really
    /// laid out: a line worked out from the font left them a point or two low.
    private func cornerInset(for height: CGFloat) -> CGFloat {
        let lineHeight = AhType.uiFont(.body).lineHeight
        if boxHeight > 0, composer.attachments.isEmpty, textHeight < lineHeight * 2 + 12 {
            return max(6, (boxHeight - height) / 2)
        }
        let line = max(control, lineHeight + 24)
        return max(6, ((line - height) / 2).rounded())
    }

    /// The box: what you attach above the text, and Send inside it at the last line's end.
    private var field: some View {
        VStack(alignment: .leading, spacing: 6) {
            // As tall as its tiles, always: a sideways scroll view takes whatever height it's
            // given, and with the bar short of room (a long queue, the keyboard up) the tiles
            // were squeezed to a sliver over + while the text spilled out under the box.
            if !composer.attachments.isEmpty { AttachmentTiles(composer: composer).fixedSize(horizontal: false, vertical: true).padding(.top, 2).accessibilityElement(children: .contain).accessibilityIdentifier("attachments") }
            // The text wraps short of Send, which sits in the box's corner (as Messages has it):
            // beside it in a row, the box was measured at one width and laid out at another,
            // and a long message lost its first line.
            ComposerTextField(composer: composer, session: session, scene: scene, leadingRoom: attachSize.width > 0 ? attachSize.width + 2 : 0, trailingRoom: sendSize.width > 0 ? sendSize.width + 4 : 0, cornerHeight: sendSize.height, maxHeight: textCap)
                .frame(minHeight: control - 12)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { textHeight = $0 }
                // While dictation listens, the box says so: waves where the text goes, a draft
                // faded back under them until the words go in, the placeholder gone.
                .opacity(listening ? (composer.text.isEmpty ? 0 : 0.12) : 1)
                .overlay {
                    if listening {
                        DictationWaves(levels: session.dictation.levels, count: session.dictation.levelCount, color: theme.accent)
                            .frame(height: min(28, max(16, textHeight - 8)))
                            .padding(.leading, attachSize.width + 6)
                            .padding(.trailing, sendSize.width + 6)
                            .allowsHitTesting(false)
                            .transition(.opacity)
                    }
                }
                .animation(.easeOut(duration: 0.2), value: listening)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 6)
        .frame(minHeight: control)
        // The box is as tall as what's in it: short of room, the bar grows up over the
        // conversation rather than the box shrinking under its own text and tiles.
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { boxHeight = $0 }
        .overlay(alignment: .bottomLeading) {
            // While dictating, + is Cancel: the same size in the same place, so nothing moves.
            Group { if dictating { cancelDictation } else { attachMenu } }
                .onGeometryChange(for: CGSize.self) { $0.size } action: { attachSize = $0 }
                .padding(.horizontal, 6)
                .padding(.bottom, cornerInset(for: attachSize.height))
        }
        .overlay(alignment: .topTrailing) { expandButton.padding(.top, 4).padding(.trailing, 6) }
        .overlay(alignment: .bottomTrailing) {
            // The microphone beside Send, in the same corner: alone there while the box is
            // empty, as Messages has it, and still there to add to a draft.
            HStack(spacing: 2) {
                micButton
                ZStack { sendButton }
            }
                .onGeometryChange(for: CGSize.self) { $0.size } action: { sendSize = $0 }
                .animation(.snappy(duration: 0.22), value: composer.showsStop(working: session.working))
                .animation(.snappy(duration: 0.22), value: session.isShell || (session.working && composer.canSend))
                .animation(.snappy(duration: 0.22), value: composer.isEmpty)
                .padding(.horizontal, 6)
                .padding(.bottom, cornerInset)
        }
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
        .glassEffectID("field", in: glass)
        .overlay { ThinkingBorder(corner: corner, active: session.working && !session.isShell) }
        // A file held over the box: the box says it will take it.
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(theme.accent, lineWidth: 2)
                    .transition(.opacity)
            }
        }
        .animation(.snappy(duration: 0.15), value: dropTargeted)
        .animation(.snappy(duration: 0.2), value: outgrown)
        .onDrop(of: [.image, .fileURL, .item], isTargeted: $dropTargeted) { AttachDrop.attach($0, to: composer) }
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
            .accessibilityHint("Model, effort, permissions, commands and files")
        }
    }

    private var attachMenu: some View { AttachMenu(composer: composer, recall: true) }

    /// Dictation is starting or listening: the box's corners are its controls (✕ and ✓).
    private var dictating: Bool { session.dictation.isDictating }

    /// ✕ in +'s place while dictating.
    private var cancelDictation: some View { DictationCancel(dictation: session.dictation, composer: composer) }

    /// Dictation: a tap starts listening, another puts the words in the box. Never for a
    /// shell, whose box takes commands.
    @ViewBuilder
    private var micButton: some View {
        if !session.isShell {
            DictationMic(dictation: session.dictation, composer: composer) {
                if trayOpen { withAnimation(ComposerFloat.motion(opening: false, reduceMotion: reduceMotion)) { trayOpen = false } }
            }
        }
    }

    @ViewBuilder
    private var sendButton: some View {
        if dictating {
            // ✓ beside it is what ends dictation; sending waits until it's done.
            EmptyView()
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
                if composer.submit(working: session.working) { Haptics.tap() }
            } label: {
                // Send's pink, its height and its place, with the word for what it does.
                Text(queues ? "Queue" : "Run")
                    .font(.ah(.subheadline).weight(.semibold))
                    .foregroundStyle(theme.accentInk)
                    .padding(.horizontal, 13)
                    .frame(height: control - 12)
                    .background(theme.accentStrong, in: Capsule())
                    .opacity(composer.canSend ? 1 : 0.45)
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
                if composer.submit(working: session.working) { Haptics.tap() }
            } label: {
                // ah's Send: the accent-filled circle, the one pink control.
                Image(systemName: "arrow.up")
                    .font(.system(size: control * 0.34, weight: .bold))
                    .foregroundStyle(theme.accentInk)
                    .frame(width: control - 12, height: control - 12)
                    .background(theme.accentStrong, in: Circle())
                    .opacity(composer.canSend ? 1 : 0.45)
                    .animation(.snappy(duration: 0.2), value: composer.canSend)
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            .accessibilityLabel("Send")
            .accessibilityHint(composer.isUploading ? "Goes once the attachment is up" : "")
        }
    }

    /// Send dims while an attachment uploads, and a tap on it says why: a button that does
    /// nothing, with no word, leaves the message looking stuck.
    /// A message past the box's eight lines (it scrolls there) opens in a larger editor.
    private var outgrown: Bool {
        composer.text.count > 600 || composer.text.filter { $0 == "\n" }.count >= 7
    }

    @ViewBuilder
    private var expandButton: some View {
        if outgrown {
            Button {
                scene.sheet = .draft(session.key)
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.ah(.caption2).weight(.semibold))
                    .foregroundStyle(theme.muted)
                    .frame(width: 24, height: 24)
                    .contentShape(Circle())
                    .hoverEffect(.highlight)
                    .touchTarget()
            }
            .buttonStyle(.plain)
            .transition(.opacity)
            .accessibilityLabel("Open the message in a larger editor")
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

/// The microphone in a box's corner, beside Send: a tap starts listening (✓ in its place
/// then puts the words in the box), a hold starts it with what you're saying shown above the
/// box too (`DictationCard`).
struct DictationMic: View {
    let dictation: DictationModel
    let composer: ComposerModel
    /// Just before listening starts: the session's box folds its settings out of the way.
    var willStart: () -> Void = {}
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44
    /// The microphone held a moment (rather than tapped) to start: the tap that ends the hold
    /// isn't a second tap.
    @State private var held = false

    var body: some View {
        Button {
            if held {
                held = false
                return
            }
            Haptics.tap()
            willStart()
            Task { await dictation.toggle(into: composer) }
        } label: {
            label
        }
        .buttonStyle(.ahPress)
        // Not while starting: the lift that ends a hold must reach the action (`held`).
        .disabled(dictation.phase == .writing)
        .onChange(of: dictation.phase) {
            if !dictation.isDictating { held = false }
        }
        // Held to start: the preview of what you're saying now, above the box.
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.35).onEnded { _ in
            switch dictation.phase {
            case .idle, .failed, .denied:
                held = true
                Haptics.threshold()
                willStart()
                Task { await dictation.toggle(into: composer, preview: true) }
            default: break
            }
        })
        .accessibilityIdentifier("dictate")
        .accessibilityLabel(dictation.isListening ? "Done Dictating" : "Dictate")
        .accessibilityHint(dictation.isListening ? "Puts what you said into the box" : "Your words go into the box; nothing is sent. Hold to see them as you speak.")
        .accessibilityAction(named: "Dictate and See Your Words") {
            Task { await dictation.toggle(into: composer, preview: true) }
        }
    }

    /// The microphone, or while listening ✓ (Done) in the accent, a ring around it breathing
    /// with your voice: once the words are in the box, that's what says it's still listening.
    @ViewBuilder
    private var label: some View {
        switch dictation.phase {
        case .starting, .writing:
            ProgressView().controlSize(.small)
                .frame(width: control - 12, height: control - 12)
        case .listening:
            Image(systemName: "checkmark")
                .font(.system(size: control * 0.3, weight: .bold))
                .foregroundStyle(theme.accentInk)
                .frame(width: control - 12, height: control - 12)
                .background(theme.accentStrong, in: Circle())
                .background {
                    Circle()
                        .fill(theme.accent.opacity(0.28))
                        .scaleEffect(1 + CGFloat(min(1, max(0, dictation.level - 0.18) / 0.6)) * 0.45)
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: dictation.level)
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
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44
    /// Each of /, @ and Panels in their capsule: the least a control gets.
    @ScaledMetric(relativeTo: .body) private var toolWidth: CGFloat = 32
    @State private var trayHeight: CGFloat = 60

    /// The session has settings to show: a live agent's model, effort and permissions.
    static func hasTray(_ session: SessionModel) -> Bool { !session.isShell && session.isLive && session.launch.preset != nil }

    var body: some View {
        let open = composer.trayOpen
        VStack(alignment: .leading, spacing: 0) {
            if !composer.suggestions.isEmpty {
                SuggestionList(items: composer.suggestions, index: composer.suggestionIndex) { composer.accept($0) }
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            } else if DictationCard.shows(session.dictation, in: composer) {
                DictationCard(dictation: session.dictation, composer: composer)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            } else if Self.hasTray(session) {
                // Out from behind the box and back under it: a slide alone, no fade. Slid, not
                // removed: a view on its way out is laid out no more, so chips folding while the
                // keyboard went down stood still in the air and were cut off, rather than follow
                // the box down. Folded, it waits below the mask's edge, out of reach.
                tray
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { trayHeight = $0 }
                    .offset(y: open || reduceMotion ? 0 : trayHeight + 40)
                    .opacity(reduceMotion && !open ? 0 : 1)
                    .allowsHitTesting(open)
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

    private var dictating: Bool { DictationCard.shows(session.dictation, in: composer) }

    /// How what floats over the box moves, the settings chips and the / and @ suggestions
    /// alike, by whichever way they're brought out or put away: a spring. Coming out from
    /// behind the box they rise a touch past their place and settle; folding they sink
    /// straight back, as a bounce there would peek them up over the box's edge again.
    static func motion(opening: Bool, reduceMotion: Bool) -> Animation? {
        guard !reduceMotion else { return nil }
        return opening ? .spring(duration: 0.42, bounce: 0.22) : .spring(duration: 0.3, bounce: 0)
    }

    /// What waits folded above the box: the settings in force, and the two ways into
    /// suggestions a finger otherwise has to know about (/ for a command, @ for a file).
    private var tray: some View {
        HStack(spacing: 8) {
            LaunchChips(session: session, scene: scene)
            // A step apart from the settings, but with them: at the far end of a wide box,
            // / and @ sat stranded half a screen away.
            Spacer(minLength: 0).frame(maxWidth: 8)
            tools
        }
        // In line with the box's text, past the + in its corner.
        .padding(.leading, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        // One piece in the slide: left to themselves the settings chips (a ViewThatFits)
        // faded in where they land while / and @ beside them rose.
        .geometryGroup()
        // Over the conversation's text, which fades out beneath the chips (as it does under
        // the bar) rather than read through them. No shadow of its own: a shadow drawn over
        // glass flattens it into a dark slab.
        .background {
            LinearGradient(colors: [theme.surface.opacity(0), theme.surface.opacity(0.92)], startPoint: .top, endPoint: .bottom)
                .padding(.top, -28)
                .padding(.horizontal, -12)
                .padding(.bottom, -8)
                .allowsHitTesting(false)
        }
        .gesture(ComposerSwipe { direction in
            guard direction == .down else { return }
            Haptics.selection()
            withAnimation(Self.motion(opening: false, reduceMotion: reduceMotion)) { composer.trayOpen = false }
        })
    }

    /// / and @ (the two ways into suggestions a finger otherwise has to know about) and the
    /// session's panels, in one capsule of glass: as three round buttons with room between
    /// them they pushed the settings chips beside them past a phone's width.
    private var tools: some View {
        HStack(spacing: 0) {
            // A command is the whole message, so / starts an empty box only.
            if composer.text.isEmpty { trigger("/", label: "Insert a command") }
            trigger("@", label: "Mention a file")
            panels
        }
        .padding(.horizontal, 2)
        .glassEffect(.regular.interactive(), in: Capsule())
    }

    /// The session's panels (Diff, Files, Chat, Queue, Snapshots, Preview, Stack), one menu
    /// away. In the session menu they were a menu inside that menu, which opened over it askew.
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
                    .frame(width: toolWidth, height: control * 0.82)
                    .modifier(PanelsGlyphDot(session: session))
                    .contentShape(.hoverEffect, Capsule())
                    .hoverEffect(.highlight)
            }
            // In the order written, wherever the menu opens.
            .menuOrder(.fixed)
            .tint(.primary)
            .accessibilityLabel("Panels")
        }
    }

    private func trigger(_ mark: String, label: String) -> some View {
        Button {
            Haptics.selection()
            // Taken from the tray, which folds: picking a suggestion brought it back over the box.
            withAnimation(Self.motion(opening: false, reduceMotion: reduceMotion)) { composer.trayOpen = false }
            composer.insert(mark)
            scene.requestFocus(.composer(session.key))
        } label: {
            Text(mark)
                .font(.ahMono(.body).weight(.semibold))
                .foregroundStyle(theme.text2)
                .frame(width: toolWidth, height: control * 0.82)
                .contentShape(.hoverEffect, Capsule())
                .hoverEffect(.highlight)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A vertical flick anywhere on the composer, the text box included. UIKit's, so it runs beside
/// the text view's own gestures (a tap still places the caret), and steps aside when the text is
/// long enough to scroll, so the drag scrolls it.
struct ComposerSwipe: UIGestureRecognizerRepresentable {
    enum Direction { case up, down }
    let swiped: (Direction) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        pan.cancelsTouchesInView = false
        return pan
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        guard pan.state == .ended else { return }
        let moved = pan.translation(in: pan.view)
        let speed = pan.velocity(in: pan.view)
        guard abs(moved.y) > abs(moved.x) else { return }
        if moved.y < -16 || speed.y < -500 {
            swiped(.up)
        } else if moved.y > 16 || speed.y > 500 {
            swiped(.down)
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer, let view = pan.view else { return true }
            let speed = pan.velocity(in: view)
            guard abs(speed.y) > abs(speed.x) else { return false }
            var hit = view.hitTest(pan.location(in: view), with: nil)
            while let current = hit, !(current is ComposerTextView) { hit = current.superview }
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

/// The model/effort/permission chips: the value in force, and how a change applies.
struct LaunchChips: View {
    let session: SessionModel
    let scene: SceneModel
    /// As tall as the / and @ beside them, at every text size.
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 36
    @Environment(\.theme) private var theme

    /// How much each chip says: its value (or that it's the default), its value or just what
    /// it sets, or only symbols. The roomiest that fits the box wins.
    enum Density { case full, compact, symbols }

    var body: some View {
        if session.launch.preset != nil {
            ViewThatFits(in: .horizontal) {
                chips(.full)
                chips(.compact)
                // Past that the row scrolls: three bare symbols said nothing anyone could read.
                ScrollView(.horizontal) {
                    // Glass of its own: a chip cut off at the scroll's edge still has its whole
                    // shape, and in the composer's glass it ran into the button beyond.
                    GlassEffectContainer {
                        chips(.compact)
                            // Room inside the scroll for the glass's own shadow, which it clips.
                            .padding(.vertical, 4)
                            .padding(.trailing, 12)
                    }
                }
                .scrollIndicators(.hidden)
                .mask {
                    HStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 18)
                    }
                }
                .padding(.vertical, -4)
            }
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
    /// As tall as the / and @ beside them, at every text size.
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 36
    @Environment(\.theme) private var theme

    init(name: String, symbol: String, value: String?, spoken: String, danger: Bool = false, labelled: Bool = true, unset: Bool = false, @ViewBuilder badge: () -> Badge) {
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
        .accessibilityLabel("\(name), \(spoken)")
        .accessibilityAddTraits(.isButton)
    }
}

extension SettingChipLabel where Badge == EmptyView {
    init(name: String, symbol: String, value: String?, spoken: String, danger: Bool = false, labelled: Bool = true, unset: Bool = false) {
        self.init(name: name, symbol: symbol, value: value, spoken: spoken, danger: danger, labelled: labelled, unset: unset, badge: { EmptyView() })
    }
}

private struct SuggestionList: View {
    let items: [CompletionTrigger.Item]
    let index: Int
    let pick: (CompletionTrigger.Item) -> Void
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
            .frame(height: min(CGFloat(shown.count) * (rowHeight + 1) + 12, 7 * (rowHeight + 1) + 12))
            .onChange(of: index) { _, i in proxy.scrollTo(i) }
        }
        // The composer's glass and its corners, so the list reads as the box opening upward.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggestions")
    }

    /// A slash command, or a file by its kind.
    private func symbol(_ item: CompletionTrigger.Item) -> String {
        if item.label.hasPrefix("/") { return "command" }
        let name = (item.value as NSString).lastPathComponent
        return FilesModel.Kind(FsEntry(name: name, type: item.value.hasSuffix("/") ? .dir : .file, size: 0, mtime: 0)).symbol
    }
}

/// The text box itself: a UITextView, so Return, Escape, ↑/↓, Tab and every keyboard command
/// land exactly where they should, and dictation, autocorrect and selection keep working.
struct ComposerTextField: UIViewRepresentable {
    let composer: ComposerModel
    let session: SessionModel
    let scene: SceneModel
    /// Room kept clear at the end of each line for the button in the box's corner.
    var leadingRoom: CGFloat = 0
    var trailingRoom: CGFloat = 0
    /// How tall that button is: a long message's scroll bar stops above it.
    var cornerHeight: CGFloat = 0
    /// The most the box may be (the room the conversation has); past it, the text scrolls inside.
    var maxHeight: CGFloat = .infinity
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
        view.accessibilityIdentifier = "composer"
        view.text = composer.text
        setTraits(view)
        return view
    }

    /// A touch keyboard's Return starts a new line, as in Messages (Send is the button); with a
    /// hardware keyboard, Return sends and Shift- or Option-Return starts the new line.
    private static func returnKey(hardwareKeyboard: Bool) -> UIReturnKeyType { hardwareKeyboard ? .send : .default }

    /// Commands aren't sentences: no capitals, corrections or curly quotes in a shell.
    private func setTraits(_ view: ComposerTextView) {
        let shell = composer.isShell
        view.autocapitalizationType = shell ? .none : .sentences
        view.autocorrectionType = shell ? .no : .default
        view.spellCheckingType = shell ? .no : .default
        view.smartQuotesType = shell ? .no : .default
        view.accessibilityLabel = shell ? "Command" : "Message"
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
        if (view.autocapitalizationType == .none) != composer.isShell {
            setTraits(view)
            if view.isFirstResponder { view.reloadInputViews() }
        }
        if view.returnKeyType != Self.returnKey(hardwareKeyboard: scene.hardwareKeyboard) {
            view.returnKeyType = Self.returnKey(hardwareKeyboard: scene.hardwareKeyboard)
            if view.isFirstResponder { view.reloadInputViews() }
        }
        if view.text != composer.text {
            view.text = composer.text
            view.invalidateIntrinsicContentSize()
            // Where the change left the caret (after a picked file, a snippet put in mid-text),
            // not always the end.
            let offset = composer.placeCaret.map { min(max(0, $0), view.text.utf16.count) }
            composer.placeCaret = nil
            let caret = offset.flatMap { view.position(from: view.beginningOfDocument, offset: $0) } ?? view.endOfDocument
            view.selectedTextRange = view.textRange(from: caret, to: caret)
        }
        // "@path" naming a file that's there: a chip in the text, opened or taken out from it.
        view.mentionTint = theme.uiAccent
        view.plainColor = UIColor(theme.text)
        view.openMention = { [composer, hostFiles, session] mention in
            // What's attached opens once it's up; a file the text names, in the session's folder.
            if let attached = composer.attachment(for: mention) {
                if let path = attached.path { Task { await hostFiles?.open?(path) } } else { session.notify("\(attached.name) is still uploading") }
                return
            }
            guard let path = composer.mentionLookup?.resolve(mention.path) else { return }
            Task { await hostFiles?.open?(path) }
        }
        view.removeMention = { [composer] mention in composer.removeChip(mention) }
        view.moveMention = { [composer] mention, to in composer.moveChip(mention, to: to) }
        view.mentions = composer.chips
        // New text (sent, recalled, a chip taken out) comes in plain; and a theme's new colour.
        view.styleMentions()
        let settings = ComposerFloat.hasTray(session) ? [session.launch.modelLabel, session.launch.effort.map(LaunchState.effortName)].compactMap { $0 } : []
        view.placeholder = composer.placeholder(working: session.working, queued: session.row?.dto.queued ?? 0, touchOnly: !scene.hardwareKeyboard, agent: session.launch.preset?.name, waiting: session.waiting, trusting: session.awaitingGate, ended: !session.isLive, settings: settings)
        // Only when the theme changes: setting it restyles all the text, every keystroke, under
        // autocorrect and the keyboard's predictions.
        if context.coordinator.theme != theme {
            context.coordinator.theme = theme
            view.textColor = UIColor(theme.text)
        }
        if let request = scene.focusRequest, request.nonce != context.coordinator.handledFocus {
            context.coordinator.handledFocus = request.nonce
            if request.target == .composer(session.key), request.isFresh(forBoxMadeAt: context.coordinator.made) {
                DispatchQueue.main.async { view.becomeFirstResponder() }
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        uiView.fitting(proposal, maxHeight: maxHeight, kept: &context.coordinator.measured)
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate, UITextPasteDelegate, ComposerTextViewOwner {
        var parent: ComposerTextField
        var handledFocus = 0
        /// When this box was made: a focus request from long before isn't for it.
        let made = Date()
        /// The theme the text was last colored for.
        var theme: Theme?
        /// The box's height for a text at a width, as last measured.
        var measured: [ComposerTextView.Measure: CGFloat] = [:]

        init(parent: ComposerTextField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            // SwiftUI measures the box again only when told: a line more or less is a new size.
            textView.invalidateIntrinsicContentSize()
            parent.scene.fieldState = fieldState(textView)
            parent.composer.text = textView.text
            parent.composer.caret = textView.offset(from: textView.beginningOfDocument, to: textView.selectedTextRange?.start ?? textView.endOfDocument)
            parent.composer.edited()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.scene.fieldState = fieldState(textView)
            // Mid-keystroke the caret moves before the text arrives: suggestions worked out from
            // the old text emptied the list (and a quick Return sent the half-typed @mention).
            // The text's own change brings them up to date.
            guard textView.text == parent.composer.text else { return }
            let caret = textView.offset(from: textView.beginningOfDocument, to: textView.selectedTextRange?.start ?? textView.endOfDocument)
            if caret != parent.composer.caret {
                parent.composer.caret = caret
                parent.composer.updateSuggestions()
            }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.scene.keyScope = .field
            parent.scene.fieldState = fieldState(textView)
            parent.scene.composerFocused = parent.session.key
            parent.scene.didFocus(.composer(parent.session.key))
            parent.scene.scheduleSave()
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.scene.keyScope = .app
            if parent.scene.composerFocused == parent.session.key { parent.scene.composerFocused = nil }
            parent.scene.didBlur(.composer(parent.session.key))
        }

        /// The software keyboard's Return: a new line, unless it's taking a suggestion (or, with
        /// a hardware keyboard about, it's the Send key it says it is).
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard text == "\n", (textView as? ComposerTextView)?.isHardwareReturn != true else { return true }
            let composer = parent.composer
            if !composer.suggestions.isEmpty {
                composer.accept(composer.suggestions[min(composer.suggestionIndex, composer.suggestions.count - 1)])
                return false
            }
            guard parent.scene.hardwareKeyboard else { return true }
            send()
            return false
        }

        func fieldState(_ textView: UITextView) -> FieldState {
            let selection = textView.selectedTextRange.map {
                textView.offset(from: textView.beginningOfDocument, to: $0.start)..<textView.offset(from: textView.beginningOfDocument, to: $0.end)
            }
            return FieldState(text: textView.text, selection: selection)
        }

        func send() {
            let composer = parent.composer
            if !composer.suggestions.isEmpty {
                composer.accept(composer.suggestions[min(composer.suggestionIndex, composer.suggestions.count - 1)])
                return
            }
            // An empty box steers the next queued message, like its Steer button.
            if composer.isEmpty {
                _ = parent.session.queue.steerFirst()
                return
            }
            composer.submit(working: parent.session.working)
        }

        /// Keys the composer answers itself, after the app's commands had their chance.
        func handle(_ press: KeyPress, in textView: ComposerTextView) -> Bool {
            if parent.scene.handle(press, scope: .field, field: fieldState(textView)) { return true }
            let composer = parent.composer
            let mods = press.modifiers
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
            case "Enter" where mods == [.command] && parent.session.working && !composer.isEmpty && !composer.isShell:
                // ⌘Return while it works: don't queue, send now (the turn stops).
                Haptics.threshold()
                composer.submit(working: true, steer: true)
                return true
            case "Escape":
                if !composer.suggestions.isEmpty {
                    composer.dismissSuggestions()
                    return true
                }
                if composer.isEmpty && parent.session.working && !composer.isShell {
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
            ComposerTextView.paste(item, to: self)
        }

        func pasteMedia(_ providers: [NSItemProvider]) { AttachPaste.attach(providers, to: parent.composer) }
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
}

/// A UITextView that hands hardware keys to the composer before typing them, and turns
/// pasted media (a screenshot, a video, a file) into an attachment instead of nothing.
final class ComposerTextView: UITextView {
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
    /// A chip dragged to another place: the mention and where it goes (a UTF-16 offset).
    var moveMention: ((Mention, Int) -> Void)?
    /// The chip being dragged: its copy under the finger, the caret where it would land.
    private var chipDrag: (mention: Mention, ghost: UIView, caret: UIView, to: Int?)?
    private var chips: [UIView] = []
    /// What the chips were laid out for: done again only when the text, its width or the mentions change.
    private var chipsFor: (text: String, width: CGFloat, size: CGFloat)?

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
        // What's typed next is plain text, also right after a chip.
        typingAttributes[.foregroundColor] = base
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
        for mention in mentions {
            guard NSMaxRange(mention.range) <= (text as NSString).length,
                  let start = position(from: beginningOfDocument, offset: mention.range.location),
                  let at = position(from: start, offset: 1),
                  let sign = textRange(from: start, to: at) else { continue }
            let mark = firstRect(for: sign)
            guard !mark.isNull, !mark.isInfinite else { continue }
            let lines = chipLines(mention)
            var first: CGRect?
            for (i, line) in lines.enumerated() {
                // The ×'s strokes are under half its point size across (its image has room round them).
                let box = chipBox(line, from: i == 0 ? mark.midX - symbolSize * 0.19 : nil, last: i == lines.count - 1)
                if i == 0 { first = box }
                // Behind the text: a tinted fill, a border off the letters.
                let chip = UIView(frame: box)
                chip.isUserInteractionEnabled = false
                chip.backgroundColor = mentionTint.withAlphaComponent(0.12)
                chip.layer.cornerRadius = 6
                chip.layer.cornerCurve = .continuous
                chip.layer.borderWidth = 1
                chip.layer.borderColor = mentionTint.withAlphaComponent(0.4).cgColor
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
            remove.frame = CGRect(x: mark.minX - 4, y: first.minY, width: mark.width + 8, height: first.height)
            remove.setImage(symbol, for: .normal)
            remove.tintColor = mentionTint.withAlphaComponent(0.8)
            remove.accessibilityLabel = "Remove \(mention.path)"
            addSubview(remove)
            chips.append(remove)
        }
    }

    /// A mention's letters on each line it's on: as wide as they are (a selection's rect for
    /// a line it wraps from runs on to the line's end).
    private func chipLines(_ mention: Mention) -> [CGRect] {
        var lines: [CGRect] = []
        var from = 0
        var y: CGFloat?
        for i in 0...mention.range.length {
            let here = i < mention.range.length ? position(from: beginningOfDocument, offset: mention.range.location + i).map { caretRect(for: $0).midY } : nil
            if i > 0, i == mention.range.length || here.map({ abs($0 - (y ?? $0)) > 1 }) == true {
                if let a = position(from: beginningOfDocument, offset: mention.range.location + from),
                   let b = position(from: beginningOfDocument, offset: mention.range.location + i),
                   let range = textRange(from: a, to: b) {
                    let rect = firstRect(for: range)
                    if !rect.isNull, !rect.isInfinite, rect.width > 0 { lines.append(rect) }
                }
                from = i
            }
            if let here { y = here }
        }
        return lines
    }

    /// A chip's box on one line: around its letters, not the line, with the same room on every
    /// side. From the capitals' tops to the descenders' bottoms (the line's own box has the
    /// font's ascent over the capitals, and next to nothing under a "g"), from the ×'s strokes
    /// (`from`, on the line the mention starts on) to the last letter's. Measured on Inter: a
    /// "g" reaches nearly all of its descent, and a last letter's ink ends about a sixteenth of
    /// the size short of its advance. The border is drawn inside the box, so it's room too.
    private func chipBox(_ line: CGRect, from left: CGFloat?, last: Bool) -> CGRect {
        guard let font else { return line.insetBy(dx: -2, dy: 0) }
        // Little enough that chips on lines one under the other barely meet.
        let pad = font.pointSize * 0.12 + 1
        // The font's line sits in the middle of the text's line.
        let baseline = line.minY + (line.height - (font.ascender - font.descender)) / 2 + font.ascender
        let top = baseline - font.capHeight - pad
        let bottom = baseline - font.descender * 0.97 + pad
        let right = (last ? line.maxX - font.pointSize * 0.06 : line.maxX) + pad
        let start = (left ?? line.minX) - pad
        return CGRect(x: start, y: top, width: right - start, height: bottom - top)
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
        // The box grows a line after the text does, and the caret's scroll from the line before
        // stayed, cutting off the first line; once it all fits, it sits at the top. Only when
        // there's nothing to scroll: within a fraction of a point of fitting, UIKit scrolls the
        // caret into view, this put it back, and the two could take turns without end.
        centreShortLine()
        if contentSize.height <= bounds.height, contentOffset.y != -adjustedContentInset.top {
            contentOffset.y = -adjustedContentInset.top
        }
        fadeEdges()
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
/// drag to reorder; and our own just-queued messages until the host lists them.
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
                                    Text("Up next · \(queue.items.count + queue.pendingRows.count)").font(.ah(.footnote).weight(.semibold))
                                        .contentTransition(.numericText(value: Double(queue.items.count + queue.pendingRows.count)))
                                    Image(systemName: "chevron.down")
                                        .font(.ah(.caption2).weight(.bold))
                                        .foregroundStyle(theme.faint)
                                        .rotationEffect(.degrees(shut ? -90 : 0))
                                }
                                // Folded, it still says what goes next.
                                Text(shut ? (queue.items.first.map { Uploads.summary($0.text) } ?? "Sending…") : held ? "Sent once you answer above" : working ? "Sent one by one when this turn ends" : "Sending…")
                                    .font(.ah(.caption2)).foregroundStyle(theme.muted).lineLimit(1)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Up next, \(queue.items.count + queue.pendingRows.count) queued")
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
                                Label(error, systemImage: "exclamationmark.triangle.fill").font(.ah(.caption)).foregroundStyle(theme.danger).padding(.horizontal, 12).padding(.bottom, 8)
                            }
                        }
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .scrollIndicators(listHeight > room ? .automatic : .hidden)
                    .frame(height: min(listHeight > 0 ? listHeight : rowHeight * CGFloat(shown.count + queue.pendingRows.count), room))
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
                // Glyph-sized to look at, finger-sized to hit: they sat 14 points apart on 16.
                HStack(spacing: 2) {
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
                            withAnimation(.snappy(duration: 0.2)) { composer.removeAttachment(file.id) }
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
