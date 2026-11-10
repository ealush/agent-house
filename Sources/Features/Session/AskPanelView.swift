import OSLog
import SwiftUI

/// What a waiting agent asks, the same everywhere: what it wants, the command (with its own
/// description) or its question, and the screen text only on request.
struct AskSummaryView: View {
    let parts: AskParts
    var showTerminalText = true
    @Environment(\.theme) private var theme
    @State private var showRaw = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(parts.kind).font(.ah(.subheadline).weight(.semibold)).foregroundStyle(theme.brand)
            if let command = parts.command {
                CodeBlockView(code: "$ \(command)", tone: .command)
            }
            if let description = parts.description {
                Text(description).font(.ah(.callout)).foregroundStyle(theme.muted)
            }
            if !parts.review.isEmpty {
                ReviewList(items: parts.review)
            }
            if let question = parts.question {
                Text(question).font(.ah(.callout).weight(.medium)).foregroundStyle(theme.text)
            }
            if showTerminalText, let context = parts.context, parts.command != nil || context != parts.question {
                DisclosureGroup("Show terminal text", isExpanded: $showRaw) {
                    CodeBlockView(code: context)
                }
                .font(.ah(.caption))
                .foregroundStyle(theme.muted)
            }
        }
    }
}

/// What answering needs: the waiting session's row, its host's API, and where to say how it went.
/// Light enough for every Inbox card (no transcript stream).
@MainActor
struct AskTarget {
    let row: SessionRow
    let api: APIClient
    let hub: HubStore
    let notify: (String, Bool) -> Void

    init(row: SessionRow, hub: HubStore, notify: @escaping (String, Bool) -> Void) {
        self.row = row
        self.hub = hub
        api = hub.client(forKey: row.key)
        self.notify = notify
    }

    init(session: SessionModel) {
        self.init(row: session.row!, hub: session.hub) { text, error in session.notify(text, tone: error ? .error : .info) }
    }

    private func run(_ what: String, _ body: () async throws -> Void) async {
        do {
            try await body()
            hub.refresh(host: row.isLocal ? nil : row.host)
        } catch {
            notify("Couldn’t \(what): \(APIError.wrap(error).message)", true)
        }
    }

    /// Only for an answerable permission prompt; the host re-checks it's still showing.
    func answer(approve: Bool) async {
        await run(approve ? "approve" : "deny") { try await api.answer(row.uid, approve: approve) }
    }

    func choose(_ option: AskDTO.ScreenOption) async {
        await run("answer") { _ = try await api.choose(row.uid, key: option.key) }
    }

    func answerQuestions(_ answers: [QuestionAnswer]) async {
        await run("answer") { try await api.answerQuestions(row.uid, answers) }
    }

    func answerDialog(question: String, answer: QuestionAnswer) async {
        await run("answer") { try await api.answerQuestion(row.uid, question: question, answer: answer) }
    }

    /// "Chat about this": no answer; the conversation goes on in words.
    func chatAbout(question: String?) async {
        await run("open the chat") { try await api.chatAboutQuestions(row.uid, question: question) }
    }
}

/// Where the keyboard comes from and goes back to: the window's focus requests (`.ask(key)`
/// gives the panel the keyboard) and, on Esc, the input it came from.
@MainActor
struct AskKeyboard {
    let scene: SceneModel
    let key: String
    /// Esc: back to the composer (GUI) or the terminal.
    let leave: SceneModel.FocusTarget
}

/// The panel's keyboard: whether it has it, and what the choices on show do with a key.
/// A UIKit responder holds the keyboard (as the composer and terminal do), so a hardware
/// keyboard reaches the choices on iPhone and iPad alike.
@MainActor
@Observable
final class AskKeyInput {
    private(set) var focused = false
    /// Bumped to take the keyboard.
    private(set) var wanted = 0
    /// The choices on show: true when they used the key.
    @ObservationIgnored var handle: ((AskKey) -> Bool)?

    /// The newest choices to register: a form on its way out (the question just answered)
    /// can still update while the next one is on show, and must not take the keys back.
    @ObservationIgnored private(set) var newest = 0
    func register() -> Int {
        newest += 1
        return newest
    }

    func take() { wanted += 1 }
    func didChange(_ on: Bool) { focused = on }
}

/// Answering a waiting agent without its terminal (`../ah/web/AskPanel.tsx`): its question
/// dialog as a form, a numbered picker as buttons, or Approve / Deny. Keyboard first: given
/// the keyboard (opening a waiting session, Reply), digits pick, arrows move, Space and
/// Return choose, Esc goes back to the input. The host re-checks the screen before typing
/// anything, so a stale tap never lands in a live agent.
struct AskPanelView: View {
    let target: AskTarget
    var compact = false
    var keyboard: AskKeyboard? = nil
    var onReply: (() -> Void)? = nil
    var onUseTerminal: (() -> Void)? = nil
    @Environment(\.theme) private var theme
    @State private var keys = AskKeyInput()

    var body: some View {
        let row = target.row
        if let ask = row.dto.ask, row.dto.status == .waiting {
            let parts = AskParts(ask, detail: row.dto.detail)
            VStack(alignment: .leading, spacing: 12) {
                let review = !parts.review.isEmpty
                let questions = review ? [] : (ask.questions ?? [])
                let dialog = !review && ask.kind == .choice && questions.isEmpty ? ask.dialog : nil
                if !compact {
                    if !questions.isEmpty || dialog != nil {
                        Text(AskParts.kindLabel(ask.kind)).font(.ah(.subheadline).weight(.semibold)).foregroundStyle(theme.brand)
                    } else {
                        AskSummaryView(parts: parts)
                    }
                }
                if ask.kind == .choice, !questions.isEmpty {
                    QuestionFormView(form: QuestionForm(questions: questions), progress: nil, keys: keys, leave: leave, chat: { await target.chatAbout(question: nil) }) { answers in
                        await target.answerQuestions(answers)
                    }
                    .id(questions.map(\.question).joined(separator: "\n"))
                } else if let dialog {
                    // Read off the screen, only the highlighted option's preview is known; the
                    // others still answer as a preview question does.
                    let options = dialog.previews == true ? dialog.options.map { AskDTO.Option(label: $0.label, description: $0.description, checked: $0.checked, preview: $0.preview ?? "") } : dialog.options
                    let question = AskDTO.Question(question: dialog.question, header: nil, multiSelect: dialog.multiSelect, options: options)
                    QuestionFormView(
                        form: QuestionForm(questions: [question], initial: [dialog.options.enumerated().compactMap { $0.element.checked == true ? $0.offset : nil }]),
                        progress: dialog.total > 1 ? "Question \(min(dialog.answered + 1, dialog.total)) of \(dialog.total)" : nil,
                        keys: keys,
                        leave: leave,
                        chat: { await target.chatAbout(question: dialog.question) }
                    ) { answers in
                        if let answer = answers.first { await target.answerDialog(question: dialog.question, answer: answer) }
                    }
                    .id(dialog.question)
                } else if let options = ask.options, !options.isEmpty {
                    ScreenChoicesView(target: target, options: options, keys: keys, leave: leave)
                        .id(ask.text + options.map(\.label).joined(separator: "\n"))
                } else {
                    ApproveDenyView(target: target, compact: compact, onReply: onReply, keys: keys, leave: leave)
                }
                if let onUseTerminal {
                    Button(action: onUseTerminal) { Label("Answer in terminal", systemImage: "apple.terminal") }
                        .modifier(AskSecondaryAction())
                }
            }
            .padding(compact ? 0 : 14)
            .background {
                // The request count goes in as a value, so a new one always reaches the view.
                if keyboard != nil { AskKeyCatcher(keys: keys, wanted: keys.wanted) }
            }
            // ah's AskCard: the tint and edge of what needs you; a stronger ring while the
            // keyboard answers it.
            .background(compact ? .clear : theme.accentTint, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .background(compact ? .clear : theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(compact ? .clear : keys.focused ? theme.brand : theme.accentLine, lineWidth: keys.focused ? 1.5 : 1))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(row.title) needs you")
            // The window asks for the answer controls: take the keyboard.
            .task(id: keyboard?.scene.focusRequest?.nonce) {
                guard let keyboard, let request = keyboard.scene.focusRequest, request.target == .ask(keyboard.key) else { return }
                keys.take()
            }
            .onChange(of: keys.focused) { _, on in
                guard let keyboard else { return }
                if on { keyboard.scene.didFocus(.ask(keyboard.key)) } else { keyboard.scene.didBlur(.ask(keyboard.key)) }
            }
            // Answered (or moved on) while it had the keyboard: back to where you'd type.
            // With a hardware keyboard only: on a touch screen that would put the on-screen
            // keyboard up after a tap, unasked.
            .onDisappear { if keys.focused, keyboard?.scene.hardwareKeyboard == true { leave() } }
        }
    }

    /// Esc from the answer controls: back to where you'd type.
    private var leave: () -> Void {
        { [keyboard] in
            guard let keyboard else { return }
            keyboard.scene.requestFocus(keyboard.leave)
        }
    }
}

private let keyboardLog = Logger(subsystem: "dev.ealush.ah.native", category: "keyboard")

/// The responder behind the panel that holds the keyboard for it. Keys the choices don't
/// use go on up the chain, so the window's shortcuts (⌘K, ⌘N…) still work from here.
private struct AskKeyCatcher: UIViewRepresentable {
    let keys: AskKeyInput
    let wanted: Int

    func makeUIView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.keys = keys
        return view
    }

    func updateUIView(_ view: CatcherView, context: Context) {
        view.keys = keys
        if wanted != context.coordinator.handled {
            context.coordinator.handled = wanted
            DispatchQueue.main.async { view.claim() }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var handled = 0
    }

    final class CatcherView: UIView {
        weak var keys: AskKeyInput?

        override var canBecomeFirstResponder: Bool { true }

        override func becomeFirstResponder() -> Bool {
            let became = super.becomeFirstResponder()
            if became { keys?.didChange(true) }
            return became
        }

        override func resignFirstResponder() -> Bool {
            let resigned = super.resignFirstResponder()
            if resigned {
                keyboardLog.debug("ask panel lost the keyboard")
                keys?.didChange(false)
                // Lost while claiming: UIKit's focus engine moving to the sidebar, not someone
                // choosing a text box or terminal. Take it back.
                if Date() < claimUntil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.attempt() } }
            }
            return resigned
        }

        /// Takes the keyboard, and keeps at it for a moment (`../ah/web/Session.tsx`
        /// claimKeyboard): the panel may not be in its window yet, and a view settling around
        /// it can pull focus away once. It gives way only to a text input, which someone chose.
        private var claimUntil = Date.distantPast

        /// What had the keyboard when the claim began (the composer it takes over from).
        private weak var displaced: UIResponder?

        func claim() {
            claimUntil = Date().addingTimeInterval(1.5)
            displaced = UIResponder.current
            keyboardLog.debug("ask panel claims the keyboard from \(String(describing: self.displaced.map { type(of: $0) }), privacy: .public)")
            attempt()
        }

        private func attempt() {
            guard !isFirstResponder, Date() < claimUntil else { return }
            // A text box or terminal chosen since the claim began wins.
            if let holder = UIResponder.current, holder !== self, holder !== displaced, holder is UITextInput {
                keyboardLog.debug("ask panel gives way to \(String(describing: type(of: holder)), privacy: .public)")
                return
            }
            keyboardLog.debug("ask panel takes the keyboard (in window: \(self.window != nil, privacy: .public))")
            if window == nil || !becomeFirstResponder() {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.attempt() }
            }
        }

        override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            let rest = presses.filter { press in press.key.map { AskKey(KeyPress($0)) == nil } ?? true }
            if !rest.isEmpty { super.pressesEnded(rest, with: event) }
        }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            var rest = Set<UIPress>()
            for press in presses {
                // Every key the choices understand stays here, used or not: passed on, an
                // arrow would move the system's focus (to the sidebar) and a Space or Return
                // would then act on whatever it reached, another session included.
                if let key = press.key, let ask = AskKey(KeyPress(key)) {
                    _ = keys?.handle?(ask)
                    continue
                }
                rest.insert(press)
            }
            if !rest.isEmpty { super.pressesBegan(rest, with: event) }
        }
    }
}

/// Hands the panel's keyboard to the choices on show. A UIKit view's update runs every time
/// they're built or rebuilt (where `onAppear` can be skipped); only the newest choices hold it.
private struct KeyHandler: UIViewRepresentable {
    let keys: AskKeyInput
    let handle: (AskKey) -> Bool

    func makeUIView(context: Context) -> UIView {
        context.coordinator.generation = keys.register()
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        if context.coordinator.generation == keys.newest { keys.handle = handle }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var generation = 0
    }
}

/// The question dialog's review: each question and what you answered.
private struct ReviewList: View {
    let items: [AskParts.Reviewed]
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.question).font(.ah(.caption)).foregroundStyle(theme.muted)
                    Text(item.answer).font(.ah(.callout).weight(.medium)).foregroundStyle(theme.text)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// The outline the keyboard's cursor draws around the row it's on.
private struct CursorRing: ViewModifier {
    let on: Bool
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        content.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(on ? theme.accent : .clear, lineWidth: 2))
    }
}

/// Approve / Deny for a plain permission prompt (or Reply when it needs words). With the
/// keyboard: ←/→ move between them, Return chooses.
/// A row cursor the keyboard moves, and the row already sent. A reference, so the key
/// handler and the view always read and write the same one.
@MainActor
@Observable
final class RowCursor {
    /// Nothing until an arrow moves it: Space or Return right after a session opens must not
    /// approve the first row of a permission prompt nobody has read.
    var index: Int?
    var sent: String?

    func move(_ by: Int, count: Int) {
        guard count > 0 else { return }
        index = index.map { max(0, min(count - 1, $0 + by)) } ?? 0
    }
}

/// Approve / Deny for a plain permission prompt (or Reply when it needs words). With the
/// keyboard: ←/→ move between them, Return chooses.
private struct ApproveDenyView: View {
    let target: AskTarget
    let compact: Bool
    let onReply: (() -> Void)?
    let keys: AskKeyInput
    let leave: () -> Void
    @Environment(\.theme) private var theme
    @State private var cursor = RowCursor()

    var body: some View {
        HStack(spacing: 10) {
            if target.row.dto.answerable {
                Button {
                    answer(true)
                } label: {
                    Label("Approve", systemImage: "checkmark").frame(maxWidth: compact ? nil : .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.accentStrong)
                .modifier(CursorRing(on: keys.focused && cursor.index == 0))
                Button(role: .destructive) {
                    answer(false)
                } label: {
                    Label("Deny", systemImage: "xmark").frame(maxWidth: compact ? nil : .infinity)
                }
                .buttonStyle(.bordered)
                .modifier(CursorRing(on: keys.focused && cursor.index == 1))
            } else if let onReply {
                Button("Reply", action: onReply).buttonStyle(.borderedProminent).tint(theme.accentStrong)
            }
        }
        .disabled(cursor.sent != nil)
        .background(KeyHandler(keys: keys) { [cursor, target, onReply, leave] key in Self.key(key, cursor: cursor, target: target, onReply: onReply, leave: leave) })
    }

    private static func key(_ key: AskKey, cursor: RowCursor, target: AskTarget, onReply: (() -> Void)?, leave: () -> Void) -> Bool {
        switch key {
        case .left, .up: cursor.index = 0
        case .right, .down: cursor.index = 1
        case .choose:
            if !target.row.dto.answerable {
                onReply?()
            } else if let index = cursor.index {
                answer(index == 0, cursor: cursor, target: target)
            }
        case .leave: leave()
        default: return false
        }
        return true
    }

    private func answer(_ approve: Bool) { Self.answer(approve, cursor: cursor, target: target) }

    private static func answer(_ approve: Bool, cursor: RowCursor, target: AskTarget) {
        guard cursor.sent == nil else { return }
        if approve { Haptics.success() } else { Haptics.warning() }
        cursor.sent = approve ? "approve" : "deny"
        Task {
            await target.answer(approve: approve)
            cursor.sent = nil
        }
    }
}

/// A permission picker's rows as buttons; digits (or a row's own hotkey) pick, arrows move.
private struct ScreenChoicesView: View {
    let target: AskTarget
    let options: [AskDTO.ScreenOption]
    let keys: AskKeyInput
    let leave: () -> Void
    @Environment(\.theme) private var theme
    @State private var cursor = RowCursor()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(options.enumerated()), id: \.element.key) { index, option in
                Button {
                    Self.pick(option, cursor: cursor, target: target)
                } label: {
                    HStack(spacing: 10) {
                        Text(option.key.hasPrefix("nav:") ? "\(index + 1)" : option.key.uppercased())
                            .font(.ahMono(.caption).weight(.bold))
                            .frame(width: 22, height: 22)
                            .background(theme.surface, in: RoundedRectangle(cornerRadius: 6))
                        // Every choice reads in full, even with the keyboard up: the transcript gives way.
                        Text(AskParts.choiceLabel(option.label)).foregroundStyle(theme.text).multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        if cursor.sent == option.key { ProgressView().controlSize(.small) }
                    }
                    .padding(10)
                    .background(index == 0 ? theme.accent.opacity(0.1) : theme.text.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .modifier(CursorRing(on: keys.focused && cursor.index == index))
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .disabled(cursor.sent != nil)
            }
        }
        .background(KeyHandler(keys: keys) { [cursor, options, target, leave] key in Self.key(key, cursor: cursor, options: options, target: target, leave: leave) })
        .task(id: cursor.sent) {
            // The same prompt still up a while later: the key didn't take; allow another try.
            guard cursor.sent != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            cursor.sent = nil
        }
    }

    private static func key(_ key: AskKey, cursor: RowCursor, options: [AskDTO.ScreenOption], target: AskTarget, leave: () -> Void) -> Bool {
        switch key {
        case .up: cursor.move(-1, count: options.count)
        case .down: cursor.move(1, count: options.count)
        case .choose:
            guard let index = cursor.index, let option = options[safe: index] else { return false }
            pick(option, cursor: cursor, target: target)
        case .leave: leave()
        case .digit(let n):
            // A row's own hotkey wins over its position ("(y)" on row 1).
            guard let hit = options.first(where: { $0.key == String(n) }) ?? options[safe: n - 1] else { return false }
            pick(hit, cursor: cursor, target: target)
        case .letter(let l):
            guard let hit = options.first(where: { $0.key == l }) else { return false }
            pick(hit, cursor: cursor, target: target)
        default: return false
        }
        return true
    }

    private static func pick(_ option: AskDTO.ScreenOption, cursor: RowCursor, target: AskTarget) {
        guard cursor.sent == nil else { return }
        cursor.sent = option.key
        Haptics.selection()
        Task { await target.choose(option) }
    }
}

/// One question form's state: the answers so far, the keyboard's cursor, which "Something
/// else" rows are open, and whether it's been sent. A reference, so keys and taps change the
/// same one the view draws.
@MainActor
@Observable
final class QuestionFormModel {
    var form: QuestionForm
    /// Nothing until an arrow (or a pick) puts it somewhere.
    var cursor: QuestionForm.Spot?
    var otherOpen: Set<Int> = []
    var phase: Phase = .idle
    /// The typed-answer field that should take the keyboard (the view moves focus there).
    var typing: Int?
    @ObservationIgnored let submit: ([QuestionAnswer]) async -> Void

    enum Phase { case idle, sending, sent }

    init(form: QuestionForm, submit: @escaping ([QuestionAnswer]) async -> Void) {
        self.form = form
        self.submit = submit
    }

    func key(_ key: AskKey, leave: () -> Void) -> Bool {
        guard phase == .idle else { return false }
        switch key {
        case .up: cursor = cursor.map { form.step($0, by: -1) } ?? form.spots.first
        case .down: cursor = cursor.map { form.step($0, by: 1) } ?? form.spots.first
        case .choose:
            guard let cursor else { return true }
            activate(cursor)
        case .submit: Task { await send() }
        case .leave: leave()
        case .digit(let digit):
            let qi = cursor.flatMap(QuestionForm.question(of:)) ?? form.firstOpen ?? form.questions.indices.last ?? 0
            let count = form.questions[qi].options.count
            if digit - 1 < count {
                cursor = .option(qi, digit - 1)
                choose(qi, digit - 1)
            } else if digit - 1 == count {
                openOther(qi)
            } else {
                return false
            }
        default: return false
        }
        return true
    }

    func activate(_ spot: QuestionForm.Spot) {
        switch spot {
        case .option(let qi, let oi): choose(qi, oi)
        case .other(let qi): openOther(qi)
        case .submit: Task { await send() }
        }
    }

    func choose(_ qi: Int, _ oi: Int) {
        otherOpen.remove(qi)
        Haptics.selection()
        if form.choose(qi, oi) {
            Task { await send() }
        } else if !form.questions[qi].multiSelect {
            // A single choice is answered: the cursor moves on, as the agent's dialog does.
            cursor = form.after(qi)
        }
    }

    func openOther(_ qi: Int) {
        otherOpen.insert(qi)
        form.setOther(qi, text: form.drafts[qi].text)
        cursor = .other(qi)
        typing = qi
    }

    /// Return in a typed answer: send when that's everything, else on to what's still open.
    /// True when the keyboard should go back to the rows.
    func typed(_ qi: Int) -> Bool {
        if form.complete && (form.instant || form.questions.count == 1) {
            Task { await send() }
            return false
        }
        cursor = form.after(qi)
        return true
    }

    func send() async {
        guard form.complete, phase == .idle else { return }
        phase = .sending
        await submit(form.answers)
        phase = .sent
    }
}

/// The agent's questions as one form. With the keyboard: digits pick in the question the
/// cursor is in, ↑/↓ move, Space and Return choose the row, ⌘Return answers.
struct QuestionFormView: View {
    @State private var model: QuestionFormModel
    let progress: String?
    let keys: AskKeyInput
    var leave: () -> Void = {}
    /// The dialog's "Chat about this": decline the questions and talk it over instead.
    var chat: (() async -> Void)? = nil
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass
    @FocusState private var typing: Int?
    @FocusState private var noting: Int?
    @State private var chatting = false

    init(form: QuestionForm, progress: String?, keys: AskKeyInput, leave: @escaping () -> Void = {}, chat: (() async -> Void)? = nil, submit: @escaping ([QuestionAnswer]) async -> Void) {
        _model = State(initialValue: QuestionFormModel(form: form, submit: submit))
        self.progress = progress
        self.keys = keys
        self.leave = leave
        self.chat = chat
    }

    var body: some View {
        Group {
            if chatting {
                Label("Back to the conversation: say what you'd like instead.", systemImage: "bubble.left.and.text.bubble.right").font(.ah(.callout)).foregroundStyle(theme.muted)
            } else if model.phase == .sent {
                Label("Answer sent.", systemImage: "checkmark").font(.ah(.callout)).foregroundStyle(theme.muted)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    if let progress { Text(progress).font(.ah(.caption)).foregroundStyle(theme.muted) }
                    ForEach(Array(model.form.questions.enumerated()), id: \.offset) { qi, question in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                if let header = question.header {
                                    Text(header)
                                        .font(.ah(.caption).weight(.semibold))
                                        .foregroundStyle(theme.accent)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(theme.accent.opacity(0.14), in: Capsule())
                                }
                                // The whole question, however long: it's what you're answering.
                                (Text(question.question).font(.ah(.callout).weight(.medium)) + Text(question.multiSelect ? "  Pick any." : "").font(.ah(.caption)).foregroundStyle(theme.muted))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if question.hasPreviews {
                                previewed(qi, question)
                            } else {
                                ForEach(Array(question.options.enumerated()), id: \.offset) { oi, option in
                                    optionRow(qi, oi, option, multi: question.multiSelect)
                                }
                                otherRow(qi)
                            }
                        }
                    }
                    HStack(spacing: 12) {
                        if !model.form.instant {
                            Button {
                                Task { await model.send() }
                            } label: {
                                Text(model.phase == .sending ? "Sending…" : "Answer").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(theme.accentStrong)
                            .disabled(!model.form.complete || model.phase == .sending)
                            .keyboardShortcut(.return, modifiers: .command)
                            .modifier(CursorRing(on: keys.focused && model.cursor == .submit))
                        }
                        if let chat {
                            Button {
                                Task {
                                    chatting = true
                                    await chat()
                                }
                            } label: {
                                Label("Chat about this", systemImage: "bubble.left.and.text.bubble.right")
                            }
                            .modifier(AskSecondaryAction())
                            .disabled(model.phase != .idle)
                            .accessibilityHint("Declines the questions and goes back to the conversation")
                        }
                    }
                }
            }
        }
        .background(KeyHandler(keys: keys) { [model, leave] key in model.key(key, leave: leave) })
        .onChange(of: model.typing) { _, field in
            guard let field else { return }
            typing = field
            model.typing = nil
        }
    }

    private func optionRow(_ qi: Int, _ oi: Int, _ option: AskDTO.Option, multi: Bool) -> some View {
        let draft = model.form.drafts[qi]
        let on = draft.picked.contains(oi) && !(draft.other && !multi)
        return Button {
            model.choose(qi, oi)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: multi ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(on ? theme.accent : theme.faint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(oi + 1). \(option.label)").foregroundStyle(theme.text)
                    if let d = option.description { Text(d).font(.ah(.caption)).foregroundStyle(theme.muted) }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // A finger's worth of row: 4 points each way left a one-line choice 28 high.
            .padding(.vertical, 8)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
            .modifier(CursorRing(on: keys.focused && model.cursor == .option(qi, oi)))
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// A question whose options carry previews: the options, the picked one's preview beside
    /// them (under them on a phone), and notes on the pick.
    @ViewBuilder
    private func previewed(_ qi: Int, _ question: AskDTO.Question) -> some View {
        let options = VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { oi, option in
                optionRow(qi, oi, option, multi: false)
            }
        }
        let picked = model.form.drafts[qi].picked.first ?? question.options.firstIndex { $0.preview != nil } ?? 0
        let preview = VStack(alignment: .leading, spacing: 8) {
            PreviewBox(text: question.options[safe: picked]?.preview, label: question.options[safe: picked]?.label ?? "")
            TextField("Add notes on this design…", text: Binding(get: { model.form.drafts[qi].notes }, set: { model.form.setNotes(qi, $0) }))
                .textFieldStyle(.roundedBorder)
                .font(.ah(.callout))
                .focused($noting, equals: qi)
                .submitLabel(.done)
                .onSubmit { keys.take() }
                .accessibilityLabel("Notes on your pick for: \(question.question)")
        }
        if sizeClass == .regular {
            HStack(alignment: .top, spacing: 14) {
                options.frame(maxWidth: 260, alignment: .leading)
                preview
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                options
                preview
            }
        }
    }

    @ViewBuilder
    private func otherRow(_ qi: Int) -> some View {
        if model.otherOpen.contains(qi) {
            TextField("Type your answer", text: Binding(get: { model.form.drafts[qi].text }, set: { model.form.setOther(qi, text: $0.replacingOccurrences(of: "\n", with: " ")) }))
                .textFieldStyle(.roundedBorder)
                .focused($typing, equals: qi)
                .submitLabel(model.form.complete ? .send : .next)
                .onSubmit { if model.typed(qi) { keys.take() } }
                .accessibilityLabel("Your answer to: \(model.form.questions[qi].question)")
        } else {
            // One more choice, drawn as the others are: its own glyph where their circles are.
            Button { model.openOther(qi) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "square.and.pencil").foregroundStyle(theme.faint)
                    Text("\(model.form.questions[qi].options.count + 1). Something else…").foregroundStyle(theme.text2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
                .padding(.horizontal, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            .modifier(CursorRing(on: keys.focused && model.cursor == .other(qi)))
        }
    }
}

/// An option's preview as Claude Code draws it: monospaced, in a box, scrolling sideways
/// rather than wrapping a mockup.
private struct PreviewBox: View {
    let text: String?
    let label: String
    @Environment(\.theme) private var theme

    var body: some View {
        Group {
            if let text, !text.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text)
                        .font(.ahMono(.footnote))
                        .foregroundStyle(theme.text)
                        .fixedSize()
                        .textSelection(.enabled)
                        .padding(12)
                }
            } else {
                // A dialog read off the screen only shows the highlighted option's preview.
                Text("\(label)'s preview shows in the terminal when it's highlighted.")
                    .font(.ah(.caption))
                    .foregroundStyle(theme.muted)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.sunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(uiColor: .separator), lineWidth: 0.5))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text.flatMap { $0.isEmpty ? nil : "Preview of \(label): \($0)" } ?? "No preview of \(label) here")
    }
}

/// The ways out of a question that aren't an answer (talk it over, the terminal): one quiet
/// style, so neither reads as disabled or as the answer itself.
private struct AskSecondaryAction: ViewModifier {
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        content
            .font(.ah(.footnote).weight(.medium))
            .foregroundStyle(theme.muted)
            .buttonStyle(.borderless)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
    }
}
