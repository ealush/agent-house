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
            Text(parts.kind).font(.caption.weight(.semibold)).foregroundStyle(theme.brand).textCase(.uppercase)
            if let command = parts.command {
                CodeBlockView(code: "$ \(command)", tone: .command)
            }
            if let description = parts.description {
                Text(description).font(.callout).foregroundStyle(theme.muted)
            }
            if let question = parts.question {
                Text(question).font(.callout.weight(.medium)).foregroundStyle(theme.text)
            }
            if showTerminalText, let context = parts.context, parts.command != nil || context != parts.question {
                DisclosureGroup("Show terminal text", isExpanded: $showRaw) {
                    CodeBlockView(code: context)
                }
                .font(.caption)
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
}

/// Answering a waiting agent without its terminal (`../ah/web/AskPanel.tsx`): its question
/// dialog as a form, a numbered picker as buttons, or Approve / Deny. Keyboard first. The host
/// re-checks the screen before typing anything, so a stale tap never lands in a live agent.
struct AskPanelView: View {
    let target: AskTarget
    var compact = false
    var onReply: (() -> Void)? = nil
    var onUseTerminal: (() -> Void)? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        let row = target.row
        if let ask = row.dto.ask, row.dto.status == .waiting {
            VStack(alignment: .leading, spacing: 12) {
                let dialog = ask.kind == .choice && (ask.questions ?? []).isEmpty ? ask.dialog : nil
                if !compact {
                    if ask.kind == .choice && (!(ask.questions ?? []).isEmpty || dialog != nil) {
                        Text(AskParts.kindLabel(ask.kind)).font(.caption.weight(.semibold)).foregroundStyle(theme.brand).textCase(.uppercase)
                    } else {
                        AskSummaryView(parts: AskParts(ask, detail: row.dto.detail))
                    }
                }
                if ask.kind == .choice, let questions = ask.questions, !questions.isEmpty {
                    QuestionFormView(form: QuestionForm(questions: questions), progress: nil) { answers in
                        await target.answerQuestions(answers)
                    }
                    .id(questions.map(\.question).joined(separator: "\n"))
                } else if let dialog {
                    let question = AskDTO.Question(question: dialog.question, header: nil, multiSelect: dialog.multiSelect, options: dialog.options)
                    QuestionFormView(
                        form: QuestionForm(questions: [question], initial: [dialog.options.enumerated().compactMap { $0.element.checked == true ? $0.offset : nil }]),
                        progress: dialog.total > 1 ? "Question \(min(dialog.answered + 1, dialog.total)) of \(dialog.total)" : nil
                    ) { answers in
                        if let answer = answers.first { await target.answerDialog(question: dialog.question, answer: answer) }
                    }
                    .id(dialog.question)
                } else if let options = ask.options, !options.isEmpty {
                    ScreenChoicesView(target: target, options: options)
                        .id(ask.text + options.map(\.label).joined(separator: "\n"))
                } else {
                    HStack(spacing: 10) {
                        if row.dto.answerable {
                            Button {
                                Haptics.success()
                                Task { await answering { await target.answer(approve: true) } }
                            } label: {
                                Label("Approve", systemImage: "checkmark").frame(maxWidth: compact ? nil : .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(theme.accentStrong)
                            Button(role: .destructive) {
                                Haptics.warning()
                                Task { await answering { await target.answer(approve: false) } }
                            } label: {
                                Label("Deny", systemImage: "xmark").frame(maxWidth: compact ? nil : .infinity)
                            }
                            .buttonStyle(.bordered)
                        } else if let onReply {
                            Button("Reply", action: onReply).buttonStyle(.borderedProminent).tint(theme.accentStrong)
                        }
                    }
                    .disabled(busy)
                }
                if let onUseTerminal, !(ask.kind == .choice && !(ask.questions ?? []).isEmpty) {
                    Button("Answer in terminal", action: onUseTerminal).font(.caption).buttonStyle(.borderless)
                }
            }
            .padding(compact ? 0 : 14)
            .background(compact ? .clear : theme.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(compact ? .clear : theme.brand.opacity(0.4)))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(row.title) needs you")
        }
    }

    @State private var busy = false

    private func answering(_ body: () async -> Void) async {
        busy = true
        await body()
        busy = false
    }
}

/// A permission picker's rows as buttons; digits pick while focus is here.
private struct ScreenChoicesView: View {
    let target: AskTarget
    let options: [AskDTO.ScreenOption]
    @Environment(\.theme) private var theme
    @State private var sent: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(options.enumerated()), id: \.element.key) { index, option in
                Button {
                    pick(option)
                } label: {
                    HStack(spacing: 10) {
                        Text(option.key.hasPrefix("nav:") ? "\(index + 1)" : option.key.uppercased())
                            .font(.caption.monospaced().weight(.bold))
                            .frame(width: 22, height: 22)
                            .background(theme.surface, in: RoundedRectangle(cornerRadius: 6))
                        Text(option.label).foregroundStyle(theme.text).multilineTextAlignment(.leading)
                        Spacer()
                        if sent == option.key { ProgressView().controlSize(.small) }
                    }
                    .padding(10)
                    .background(index == 0 ? theme.accent.opacity(0.1) : theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(sent != nil)
            }
        }
        .focusable()
        .focused($focused)
        .onKeyPress(phases: .down) { press in
            let typed = press.characters.lowercased()
            if let hit = options.first(where: { $0.key == typed }) ?? Int(typed).flatMap({ options[safe: $0 - 1] }) {
                pick(hit)
                return .handled
            }
            return .ignored
        }
        .task(id: sent) {
            // The same prompt still up a while later: the key didn't take; allow another try.
            guard sent != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            sent = nil
        }
    }

    private func pick(_ option: AskDTO.ScreenOption) {
        guard sent == nil else { return }
        sent = option.key
        Haptics.selection()
        Task { await target.choose(option) }
    }
}

/// The agent's questions as one form: digits pick, Space toggles, Return answers.
struct QuestionFormView: View {
    @State var form: QuestionForm
    let progress: String?
    let submit: ([QuestionAnswer]) async -> Void
    @Environment(\.theme) private var theme
    @State private var state: Phase = .idle
    @State private var otherOpen: Set<Int> = []

    enum Phase { case idle, sending, sent }

    var body: some View {
        if state == .sent {
            Label("Answer sent.", systemImage: "checkmark").font(.callout).foregroundStyle(theme.muted)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                if let progress { Text(progress).font(.caption).foregroundStyle(theme.muted) }
                ForEach(Array(form.questions.enumerated()), id: \.offset) { qi, question in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            if let header = question.header { Text(header).font(.caption.weight(.bold)).foregroundStyle(theme.accent) }
                            Text(question.question).font(.callout.weight(.medium))
                            if question.multiSelect { Text("Pick any.").font(.caption).foregroundStyle(theme.muted) }
                        }
                        ForEach(Array(question.options.enumerated()), id: \.offset) { oi, option in
                            let on = form.drafts[qi].picked.contains(oi) && !(form.drafts[qi].other && !question.multiSelect)
                            Button {
                                choose(qi, oi)
                            } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    Image(systemName: question.multiSelect ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                                        .foregroundStyle(on ? theme.accent : theme.faint)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(oi + 1). \(option.label)").foregroundStyle(theme.text)
                                        if let d = option.description { Text(d).font(.caption).foregroundStyle(theme.muted) }
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                        if otherOpen.contains(qi) {
                            TextField("Something else", text: Binding(get: { form.drafts[qi].text }, set: { form.setOther(qi, text: $0) }))
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { Task { await send() } }
                        } else {
                            Button("Something else…") {
                                otherOpen.insert(qi)
                                form.setOther(qi, text: "")
                            }
                            .font(.caption)
                            .buttonStyle(.borderless)
                        }
                    }
                }
                if !form.instant {
                    Button {
                        Task { await send() }
                    } label: {
                        Text(state == .sending ? "Sending…" : "Answer").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.accentStrong)
                    .disabled(!form.complete || state == .sending)
                    .keyboardShortcut(.return, modifiers: .command)
                }
            }
            .onKeyPress(phases: .down) { press in
                guard let digit = Int(press.characters), (1...9).contains(digit), let qi = form.firstOpen ?? form.questions.indices.last else { return .ignored }
                if digit - 1 < form.questions[qi].options.count {
                    choose(qi, digit - 1)
                    return .handled
                }
                return .ignored
            }
        }
    }

    private func choose(_ qi: Int, _ oi: Int) {
        otherOpen.remove(qi)
        Haptics.selection()
        if form.choose(qi, oi) { Task { await send() } }
    }

    private func send() async {
        guard form.complete, state == .idle else { return }
        state = .sending
        await submit(form.answers)
        state = .sent
    }
}
