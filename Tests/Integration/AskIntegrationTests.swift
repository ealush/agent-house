import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Everything an agent asks, answered from the app against a real host: Claude's question
// dialog a question at a time (read off the screen) and as a whole (from its hook), the
// review it ends on, a folder-trust list answered by moving its cursor, and a plan up for
// approval. The stand-ins draw these exactly as Claude Code does (ah's test/fixtures/
// picker.js, scripts/demo/agent.mjs), so ah reads and types into them as it would Claude.
@Suite(.serialized, .enabled(if: LiveHost.available, "needs scripts/integration.sh"))
struct AskIntegrationTests {
    private static let questionKeys = LiveHost.environment["AH_IT_QUESTION_KEYS"] ?? ""

    /// What the question dialog got, as one string ("213\u{1b}[B…").
    private func typed() -> String {
        let log = (try? String(contentsOfFile: Self.questionKeys, encoding: .utf8)) ?? ""
        return log.split(separator: "\n").compactMap { line -> String? in
            guard line.hasPrefix("KEY:"), let data = line.dropFirst(4).data(using: .utf8) else { return nil }
            return try? JSONDecoder().decode(String.self, from: data)
        }.joined()
    }

    private func waiting(_ api: APIClient, _ uid: String, _ what: String, _ check: @escaping (AskDTO) -> Bool) async throws -> SessionDTO {
        try await until(what, timeout: 20) {
            try await api.state().windows.first { $0.uid == uid && $0.status == .waiting && $0.ask.map(check) == true }
        }
    }

    /// The conversation id of the newest Claude-shaped transcript on the host that mentions `text`.
    private func newestTranscript(containing text: String) -> String? {
        guard let dir = LiveHost.environment["AH_IT_DIR"] else { return nil }
        let projects = URL(fileURLWithPath: "\(dir)/claude/projects")
        let files = (FileManager.default.enumerator(at: projects, includingPropertiesForKeys: [.contentModificationDateKey])?.allObjects as? [URL] ?? [])
            .filter { $0.pathExtension == "jsonl" && ((try? String(contentsOf: $0, encoding: .utf8))?.contains(text) ?? false) }
        let newest = files.max { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return da < db
        }
        return newest?.deletingPathExtension().lastPathComponent
    }

    private func screen(_ api: APIClient, _ uid: String, shows text: String) async throws {
        _ = try await until("the screen shows \(text)", timeout: 10) { () -> String? in
            let screen = try await api.capture(uid)
            return screen.contains(text) ? screen : nil
        }
    }

    @Test func aQuestionDialogIsAnsweredOneQuestionAtATimeThenReviewed() async throws {
        try "".write(toFile: Self.questionKeys, atomically: true, encoding: .utf8)
        let api = try await LiveHost.enrolled().api
        let session = try await LiveHost.launch(api, preset: "ask-dialog", label: "questions")
        defer { Task { try? await api.terminate(session.uid) } }

        // Without a hook, ah reads the question on screen: the first of two.
        let first = try #require(try await waiting(api, session.uid, "the first question") { $0.dialog?.question == "Pick a color" }.ask)
        #expect(AskParts.isForm(first), "answered as a form, not by its first row's digit")
        let color = try #require(first.dialog)
        #expect(color.total == 2 && color.answered == 0 && !color.multiSelect)
        var form = QuestionForm(questions: [AskDTO.Question(question: color.question, header: nil, multiSelect: false, options: color.options)])
        let sendsNow = form.choose(0, 1)
        #expect(sendsNow, "one single choice answers on the pick")
        try await api.answerQuestion(session.uid, question: color.question, answer: try #require(form.answers.first))

        // The next one, multi-select: two picks and a typed answer.
        let second = try #require(try await waiting(api, session.uid, "the second question") { $0.dialog?.question == "Pick toppings" }.ask?.dialog)
        #expect(second.multiSelect && second.answered == 1)
        form = QuestionForm(questions: [AskDTO.Question(question: second.question, header: nil, multiSelect: true, options: second.options)])
        _ = form.choose(0, 0)
        _ = form.choose(0, 2)
        form.setOther(0, text: "Fox")
        try await api.answerQuestion(session.uid, question: second.question, answer: try #require(form.answers.first))

        // The review: what was answered, then Submit.
        let review = try #require(try await waiting(api, session.uid, "the review") { !($0.options ?? []).isEmpty }.ask)
        let parts = AskParts(review)
        #expect(parts.kind == "Check your answers")
        #expect(parts.review == [.init(question: "Pick a color", answer: "Green"), .init(question: "Pick toppings", answer: "Cheese, Basil, Fox")])
        #expect(!AskParts.isForm(review), "the review is two buttons, not the form again")
        let submit = try #require(review.options?.first { $0.label == "Submit answers" })
        _ = try await api.choose(session.uid, key: submit.key)
        try await screen(api, session.uid, shows: "SUBMITTED")
        #expect(typed().hasPrefix("2"), "Green by its digit, never the first row's")
    }

    @Test func theHooksWholeSetIsAnsweredInOneGo() async throws {
        try "".write(toFile: Self.questionKeys, atomically: true, encoding: .utf8)
        let api = try await LiveHost.enrolled().api
        let session = try await LiveHost.launch(api, preset: "ask-dialog", label: "hooked questions")
        defer { Task { try? await api.terminate(session.uid) } }
        _ = try await until("agent detected", timeout: 20) { try await api.state().windows.first { $0.uid == session.uid && $0.agent == "ask-dialog" } }

        // What Claude's hook reports for AskUserQuestion: every question at once.
        let questions: [[String: Any]] = [
            ["question": "Pick a color", "header": "Color", "multiSelect": false, "options": [["label": "Red"], ["label": "Green"], ["label": "Blue"]]],
            ["question": "Pick toppings", "header": "Toppings", "multiSelect": true, "options": [["label": "Cheese"], ["label": "Olives"], ["label": "Basil"]]],
        ]
        let ask = String(decoding: try JSONSerialization.data(withJSONObject: ["kind": "choice", "text": "Pick a color", "questions": questions]), as: UTF8.self)
        try LiveHost.tmux("set-option", "-w", "-t", session.id, "@ah-harness", "ask-dialog",
                          ";", "set-option", "-w", "-t", session.id, "@ah-state", "waiting",
                          ";", "set-option", "-w", "-t", session.id, "@ah-state-at", String(Int(Date().timeIntervalSince1970)),
                          ";", "set-option", "-w", "-t", session.id, "@ah-ask", ask)

        let asked = try #require(try await waiting(api, session.uid, "the whole set") { ($0.questions ?? []).count == 2 }.ask)
        #expect(AskParts.isForm(asked))
        var form = QuestionForm(questions: try #require(asked.questions))
        #expect(!form.instant, "two questions: one Answer for both")
        #expect(form.questions[0].header == "Color")
        _ = form.choose(0, 1)
        _ = form.choose(1, 0)
        _ = form.choose(1, 2)
        form.setOther(1, text: "Fox")
        try await api.answerQuestions(session.uid, form.answers)
        try await screen(api, session.uid, shows: "SUBMITTED")
        // Green; Cheese and Basil; down to "Type something", Fox, Tab to Submit, Enter; then the review's Submit.
        let keys = typed()
        #expect(keys.range(of: #"^213(\x{1B}\[B|\x{1B}OB){3}Fox\t\r1$"#, options: .regularExpression) != nil, "typed: \(keys.debugDescription)")
    }

    @Test func aFolderTrustListIsAnsweredByMovingItsCursor() async throws {
        let api = try await LiveHost.enrolled().api
        let session = try await LiveHost.launch(api, preset: "demo-claude", label: "trust")
        defer { Task { try? await api.terminate(session.uid) } }
        _ = try await until("agent ready", timeout: 20) { try await api.state().windows.first { $0.uid == session.uid && $0.agent == "demo-claude" && $0.status != .busy } }
        _ = try await api.send(session.uid, text: "/trust")

        let trust = try #require(try await waiting(api, session.uid, "the trust list") { ($0.options ?? []).count == 2 }.ask)
        let options = try #require(trust.options)
        #expect(options.map(\.label) == ["Yes, I trust this folder", "No, exit"])
        #expect(options.map(\.key) == ["nav:0", "nav:1"], "a list without numbers: picked by moving the cursor")
        #expect(AskParts(trust).question == "Do you trust the files in this folder?")
        _ = try await api.choose(session.uid, key: options[0].key)
        try await screen(api, session.uid, shows: "Trusted")
    }

    @Test func aPlanUpForApprovalShowsThePlanAndTakesTheChoice() async throws {
        let api = try await LiveHost.enrolled().api
        let session = try await LiveHost.launch(api, preset: "demo-claude", label: "plan")
        defer { Task { try? await api.terminate(session.uid) } }
        _ = try await until("agent ready", timeout: 20) { try await api.state().windows.first { $0.uid == session.uid && $0.agent == "demo-claude" && $0.status != .busy } }
        _ = try await api.send(session.uid, text: "/plan")

        let plan = try #require(try await waiting(api, session.uid, "the plan's picker") { ($0.options ?? []).count == 3 }.ask)
        #expect(plan.options?.map(\.label) == ["Yes, and auto-accept edits", "Yes, and manually approve edits", "No, keep planning"])
        #expect(AskParts(plan).kind == "Plan ready", "named as a plan, not a generic prompt")
        // Claude's SessionStart hook names the conversation; the stand-in's is its newest transcript.
        let conversation = try #require(newestTranscript(containing: "ExitPlanMode"))
        try LiveHost.tmux("set-option", "-w", "-t", session.id, "@ah-harness", "demo-claude", ";", "set-option", "-w", "-t", session.id, "@ah-harness-id", conversation)

        // The plan itself is in the transcript while it waits, drawn as the plan.
        let call = try await until("the plan in the transcript", timeout: 15) { () -> ToolCall? in
            let page = try await api.feedPage(session.uid, before: nil)
            return page.entries.flatMap(\.parts).compactMap { if case .toolCall(let c) = $0, c.name == "ExitPlanMode" { return c } else { return nil } }.last
        }
        let waitingView = ToolPresentation(call: call, result: nil, awaiting: true)
        #expect(waitingView.kind == .plan && waitingView.summary == "Move sessions to Postgres")
        guard case .plan(let markdown) = waitingView.body else { Issue.record("not drawn as a plan"); return }
        #expect(markdown.contains("Add a `sessions` table"))

        _ = try await api.choose(session.uid, key: "2")
        try await screen(api, session.uid, shows: "Plan approved")
        let result = try await until("the approval in the transcript", timeout: 15) { () -> ToolResult? in
            let page = try await api.feedPage(session.uid, before: nil)
            return page.entries.flatMap(\.parts).compactMap { if case .toolResult(let r) = $0, r.callId == call.id { return r } else { return nil } }.last
        }
        let decided = ToolPresentation(call: call, result: result)
        #expect(decided.label == "Proposed a plan" && decided.status == .done)
    }
}
