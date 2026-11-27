import SwiftUI

/// Whose box a composer is: a live session's, or New session's before there is one. Every box
/// is the one view (`ComposerBox`, its text `ComposerTextField`), with the same chips, pasting,
/// suggestions, dictation and attachments; this is only what differs between them: what Return
/// does, what the box says before anything's in it, and where it takes the keyboard from.
@MainActor
enum ComposerRole {
    /// A live session's box: on its own screen, or a Chief's on its Space's home.
    case session(SessionModel)
    /// New session's: no session yet. Return starts it, with what's in the box or without.
    case newSession(NewSessionDraft, start: () -> Void)

    var session: SessionModel? {
        if case .session(let session) = self { return session }
        return nil
    }

    var focusTarget: SceneModel.FocusTarget {
        switch self {
        case .session(let session): .composer(session.key)
        case .newSession: .composer(SceneModel.newSessionKey)
        }
    }

    /// For UI tests: a session's box is "composer" wherever it is.
    var identifier: String {
        switch self {
        case .session: "composer"
        case .newSession: "new-session-message"
        }
    }

    /// Commands, not messages: a shell's box, or New session's starting one.
    var isShell: Bool {
        switch self {
        case .session(let session): session.composer.isShell
        case .newSession(let draft, _): draft.preset?.isShell == true
        }
    }

    /// Dictation into the box; none for a shell's, whose box takes commands.
    var dictation: DictationModel? {
        switch self {
        case .session(let session): session.isShell ? nil : session.dictation
        case .newSession(let draft, _): draft.dictates
        }
    }

    /// Pictures and files go in: a session's, a shell's too (their paths in the command), and
    /// New session's unless it starts a shell (a first command takes none).
    var takesFiles: Bool {
        switch self {
        case .session: true
        case .newSession(let draft, _): draft.attached != nil
        }
    }

    /// The box takes typing: New session's not while it starts.
    var editable: Bool {
        switch self {
        case .session: true
        case .newSession(let draft, _): draft.phase == .ready
        }
    }

    /// A session at work: the box's light says so (New session's while it starts).
    var working: Bool {
        switch self {
        case .session(let session): session.working && !session.isShell
        case .newSession(let draft, _): draft.phase == .starting
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .session: isShell ? "Command" : "Message"
        case .newSession: isShell ? "First command" : "Message"
        }
    }

    func notify(_ text: String, in scene: SceneModel) {
        if let session { session.notify(text) } else { scene.toast(text) }
    }
}

/// A composer's box, wherever there's one: a session's (`ComposerView`), a Chief's on its Space's
/// home (`ChiefComposer`), and New session's (`NewSessionScreen`). One glass field, the same in
/// each: what's attached and the chips (a quoted message, a reused prompt, a long paste) above the
/// text, + (✕ while dictating) in its leading corner, the microphone and the role's Send in its
/// trailing one, dictation's waves along its foot; / @ # suggestions as you type, a long paste
/// made a chip, pasted and dropped files attached. Only what Send does is the role's (`action`).
struct ComposerBox<Action: View>: View {
    @Bindable var composer: ComposerModel
    let role: ComposerRole
    let scene: SceneModel
    /// The most the text may take (the room the conversation has); past it, it scrolls inside.
    /// Nil: no taller than the box is offered (New session's, whose stage gives way above it).
    var maxTextHeight: CGFloat? = .infinity
    /// The + menu offers ↑'s Previous Message.
    var recall = false
    /// Opens the message in a larger editor once it's outgrown the box.
    var expand: (() -> Void)? = nil
    /// Just before dictation starts listening (a session's box folds its settings away).
    var willDictate: () -> Void = {}
    /// Changed for each ask for the keyboard, where the box is asked directly (New session's).
    var keyboardAsk: Int? = nil
    /// Send, or what's in its place (Queue, Run, Stop, Start): the role's, beside the microphone.
    @ViewBuilder var action: () -> Action
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The round controls and the box's corner grow with the text, as the system's own do: at
    /// the largest sizes a fixed + sat small beside a box twice its height.
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44
    /// The box at rest, a line of text in it: a touch taller than the controls in its corners,
    /// which it centres. As tall as them, it read as a thin strip under the conversation.
    @ScaledMetric(relativeTo: .body) private var least: CGFloat = 52
    @ScaledMetric(relativeTo: .body) private var corner: CGFloat = 22
    /// How wide Send (with the microphone) is in the box's corner: the text wraps short of it.
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

    private var dictation: DictationModel? { role.dictation }
    /// Dictating: the box's foot is ✕, the waves and ✓, and the words go in above them.
    private var listening: Bool { dictation?.showsWaves == true }
    /// Dictation is starting or listening: the box's corners are its controls (✕ and ✓).
    private var dictating: Bool { dictation?.isDictating == true }
    private var pending: Bool { dictation.map { DictationPending.shows($0) } == true }
    /// Dictating with words in the box: they sit over the row, not beside its controls.
    private var overRow: Bool { listening && (!composer.text.isEmpty || pending) }
    /// What's in the box shows: New session's goes with the first message as it starts.
    private var showsContent: Bool { role.editable }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // As tall as its tiles, always: a sideways scroll view takes whatever height it's
            // given, and with the bar short of room (a long queue, the keyboard up) the tiles
            // were squeezed to a sliver over + while the text spilled out under the box.
            if showsContent, !composer.attachments.isEmpty {
                AttachmentTiles(composer: composer) { removed in
                    scene.toast("Removed \(removed.name)", symbol: "paperclip")
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("attachments")
            }
            if showsContent, !composer.snippets.isEmpty {
                SnippetChips(composer: composer)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("composer-snippets")
            }
            // The text wraps short of Send, which sits in the box's corner (as Messages has it):
            // beside it in a row, the box was measured at one width and laid out at another,
            // and a long message lost its first line.
            ComposerTextField(composer: composer, role: role, scene: scene, leadingRoom: attachSize.width > 0 ? attachSize.width + 2 : 0, trailingRoom: sendSize.width > 0 ? sendSize.width + 4 : 0, cornerHeight: overRow ? 0 : sendSize.height, maxHeight: maxTextHeight, keyboardAsk: keyboardAsk)
                // Dictating with nothing in it yet, the text is the row's height, unseen under
                // the waves (the placeholder gone): the box is the row alone, as tall as at rest.
                .frame(minHeight: listening && !overRow ? least - 12 : control - 12)
                .opacity(listening && !overRow ? 0 : 1)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { textHeight = $0 }
            // Held to start: what you're saying now, under what's in, over the waves.
            if listening, pending, let dictation {
                DictationPending(dictation: dictation)
                    .padding(.leading, attachSize.width + 8)
                    .padding(.trailing, 8)
                    .transition(.opacity)
            }
            // The row the words come in over: ✕, the waves and ✓ (in the corners, below).
            if overRow { Color.clear.frame(height: least - 12).accessibilityHidden(true) }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 6)
        .frame(minHeight: least)
        // The box is as tall as what's in it: short of room, the bar grows up over the
        // conversation rather than the box shrinking under its own text and tiles. With no cap
        // of its own, as tall as it's offered at most.
        .fixedSize(horizontal: false, vertical: maxTextHeight != nil)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { boxHeight = $0 }
        // While dictation listens, the box says so: waves the width of its foot, between ✕ and
        // ✓, in the one place from the tap on, the words going in above them.
        .overlay(alignment: .bottom) {
            if listening, let dictation {
                DictationWaves(levels: dictation.levels, count: dictation.levelCount, color: theme.accent)
                    .frame(height: 24)
                    .frame(height: least - 12)
                    .padding(.leading, 6 + attachSize.width + 8)
                    .padding(.trailing, 6 + sendSize.width + 8)
                    .padding(.bottom, 6)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .animation(DictationBoxLayout.motion(dictating: listening), value: listening)
        .animation(DictationBoxLayout.motion(dictating: listening), value: overRow)
        .overlay(alignment: .bottomLeading) {
            // While dictating, + is Cancel: the same size in the same place, so nothing moves.
            Group {
                if dictating, let dictation {
                    DictationCancel(dictation: dictation, composer: composer)
                } else if role.takesFiles {
                    AttachMenu(composer: composer, recall: recall).disabled(!role.editable)
                }
            }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { attachSize = $0 }
            .padding(.horizontal, 6)
            .padding(.bottom, cornerInset(for: attachSize.height))
        }
        .overlay(alignment: .topTrailing) { expandButton.padding(.top, 4).padding(.trailing, 6) }
        .overlay(alignment: .bottomTrailing) {
            // The microphone beside Send, in the same corner: alone there while the box is
            // empty, as Messages has it, and still there to add to a draft.
            HStack(spacing: ButtonGroup.corner) {
                if let dictation, role.editable {
                    DictationMic(dictation: dictation, composer: composer, willStart: willDictate)
                }
                action()
            }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { sendSize = $0 }
            .animation(.snappy(duration: 0.22), value: composer.isEmpty)
            .animation(.snappy(duration: 0.22), value: dictation?.isWriting)
            .padding(.horizontal, 6)
            .padding(.bottom, cornerInset(for: sendSize.height))
        }
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
        .glassEffectID("field", in: glass)
        .overlay { ThinkingBorder(corner: corner, active: role.working) }
        // A file held over the box: the box says it will take it.
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(theme.accent, lineWidth: 2)
                    .transition(.opacity)
            }
        }
        .animation(.snappy(duration: 0.15), value: dropTargeted)
        .animation(.snappy(duration: 0.2), value: outgrown)
        .onDrop(of: [.image, .fileURL, .item], isTargeted: $dropTargeted) { providers in
            guard role.takesFiles, role.editable else { return false }
            return AttachDrop.attach(providers, to: composer)
        }
        // What's typed brings up its / @ # suggestions, the first highlighted.
        .onChange(of: composer.text) { _, _ in
            if composer.suggestionIndex != 0 { composer.suggestionIndex = 0 }
            composer.updateSuggestions()
        }
        // The host's Voice settings, read as the box shows, so the first tap knows who hears it.
        .task(id: dictation.map(ObjectIdentifier.init)) { await dictation?.refresh() }
        .onChange(of: dictation?.last) { _, last in
            if last != nil {
                Haptics.selection()
                AccessibilityNotification.Announcement("Dictation added to the message").post()
            }
        }
        // Left while listening, what was said goes into the box; a start still waiting stops.
        .onDisappear {
            guard let dictation else { return }
            switch role {
            case .session:
                if dictation.isListening { Task { await dictation.finish(into: composer) } }
                // Still waiting to start (a permission prompt, a language's download): not after leaving.
                else if dictation.phase == .starting { Task { await dictation.cancel(in: composer) } }
            case .newSession:
                // Its dictation goes with the screen: one that went wrong is put away too.
                dictation.close(into: composer)
            }
        }
    }

    /// How far up from the box's bottom edge something in a corner sits (Send, +), by its own
    /// height: centred on a line of text, so in a one-line box it's centred in the box, and in a
    /// longer one it's on the last line. A fixed inset left it low, since a line of body text
    /// with its insets is taller than the button plus twice the inset; measured against Send's,
    /// + rode high while Send was folded away to nothing. A box of one line, nothing above it,
    /// centres them in itself as it's really laid out: a line worked out from the font left them
    /// a point or two low.
    private func cornerInset(for height: CGFloat) -> CGFloat {
        // Dictating, the corners are the ends of the row along the box's foot, as tall as the
        // box at rest: they stay put as the words come in above.
        if listening { return (least - height) / 2 }
        let lineHeight = AhType.uiFont(.body).lineHeight
        if boxHeight > 0, composer.attachments.isEmpty, composer.snippets.isEmpty, textHeight < lineHeight * 2 + 12 {
            return max(6, (boxHeight - height) / 2)
        }
        let line = max(control, lineHeight + 24)
        return max(6, ((line - height) / 2).rounded())
    }

    /// A message past the box's eight lines (it scrolls there) opens in a larger editor.
    private var outgrown: Bool {
        composer.text.count > 600 || composer.text.filter { $0 == "\n" }.count >= 7
    }

    @ViewBuilder
    private var expandButton: some View {
        if outgrown, let expand {
            Button(action: expand) {
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
