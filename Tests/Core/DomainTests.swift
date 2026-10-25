import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Ports of ../ah/test/askView.test.ts, status.test.ts, uploads.test.ts and sessionKeys.test.ts.

@Test func asksReadAsKindCommandAndQuestionNeverTheRawScreen() {
    let screen = AskDTO(kind: .command, text: "────────\n Bash command\n   pnpm test --filter auth\n   Run the auth test suite\n Do you want to proceed?\n ❯ 1. Yes\n   2. No", questions: nil, options: nil, dialog: nil)
    let parts = AskParts(screen)
    #expect(parts.kind == "Wants to run a command")
    #expect(parts.command == "pnpm test --filter auth")
    #expect(parts.question == nil, "the generic confirm is already said by the kind")
    #expect(parts.context?.contains("────") == false)
    // A hook's detail is the command exactly.
    let hooked = AskParts(AskDTO(kind: .command, text: "Bash command\npnpm test\nDo you want to proceed?", questions: nil, options: nil, dialog: nil), detail: "$ pnpm test --filter auth")
    #expect(hooked.command == "pnpm test --filter auth")
    let choice = AskParts(AskDTO(kind: .choice, text: "", questions: [.init(question: "Pick a color", header: "Color", multiSelect: false, options: [])], options: nil, dialog: nil))
    #expect(choice.question == "Pick a color")
    #expect(AskParts.line(screen) == "Wants to run pnpm test --filter auth" || AskParts.line(screen).hasPrefix("Wants to run"))
    #expect(AskParts.line(AskDTO(kind: .choice, text: "Which fix?\nmore", questions: nil, options: nil, dialog: nil)) == "Asks: Which fix?")
}

@Test func screenTextUndoesEightyColumnWrapping() {
    let wide = String(repeating: "x", count: 70)
    let lines = ["\(wide) and the", "rest continues here", "Another line"]
    #expect(ScreenText.unwrap(lines) == ["\(wide) and the rest continues here", "Another line"])
    #expect(ScreenText.unwrap(["short", "lower"]) == ["short", "lower"], "narrow blocks are never joined")
    #expect(ScreenText.questionLine("a\nDo you want to make this edit to calc.py?\n❯ 1. Yes") == "Do you want to make this edit to calc.py?")
}

@Test func statusWordsMatchTheWebVocabulary() {
    #expect(StatusWord(status: .waiting, agent: "claude", limit: nil) == .needsYou)
    #expect(StatusWord(status: .attention, agent: "claude", limit: nil) == .done)
    #expect(StatusWord(status: .attention, agent: nil, limit: nil) == .newOutput, "a shell has new output, not done")
    #expect(StatusWord(status: .idle, agent: "claude", limit: "Session limit · resets 12am") == .limited)
    #expect(StatusWord(status: .busy, agent: "claude", limit: "x") == .working, "working past a stale limit notice")
    #expect(StatusWord.summary([.needsYou, .working, .working, .done, .idle]) == "1 session needs you. 2 working. 1 done. 1 idle.")
    #expect(StatusWord.summary([.needsYou, .needsYou]) == "2 sessions need you.")
    #expect(StatusWord.summary([]) == "All quiet.")
}

@Test func sessionKeysAreHostScopedUIDsAndLegacyWindowKeysAreRecognized() {
    #expect(SessionKey("abc123") == SessionKey(host: nil, uid: "abc123"))
    #expect(SessionKey("mac.local/abc123") == SessionKey(host: "mac.local", uid: "abc123"))
    #expect(SessionKey("mac/abc123")?.description == "mac/abc123")
    #expect(SessionKey("bad uid!") == nil)
    #expect(SessionKey.isLegacy("@12") && SessionKey.isLegacy("mac/@12"))
    #expect(!SessionKey.isLegacy("abc"))
}

@Test func uploadsReadAsAttachmentsWithTheirOwnNames() {
    let message = "/home/u/.cache/ah/uploads/2026-10-24T10-00-00-000Z-shot.png '/home/u/.cache/ah/uploads/2026-10-24T10-00-01-000Z-my notes.txt' what is this?"
    let split = Uploads.split(message)
    #expect(split.uploads.map(\.name) == ["shot.png", "my notes.txt"])
    #expect(split.uploads.map(\.image) == [true, false])
    #expect(split.rest == "what is this?")
    #expect(Uploads.summary(message) == "1 image, 1 file · what is this?")
    #expect(Uploads.split("plain text") .uploads.isEmpty)
    #expect(Uploads.shellQuote("/a/b.png") == "/a/b.png")
    #expect(Uploads.shellQuote("/a/it's.png") == #"'/a/it'\''s.png'"#)
}

@Test func nativeSignInSignsExactlyWhatTheServerChecks() throws {
    #expect(NativeAuth.hostHeader(for: URL(string: "https://box.tail.ts.net")!) == "box.tail.ts.net")
    #expect(NativeAuth.hostHeader(for: URL(string: "http://127.0.0.1:7681")!) == "127.0.0.1:7681")
    #expect(NativeAuth.sanitizedLabel("Evyatar's iPhone · (Pro)!") == "Evyatars iPhone · (Pro)")
    #expect(NativeAuth.sanitizedLabel(String(repeating: "a", count: 80)).count == 60)
    let message = NativeAuth.message(purpose: "login", challenge: "c", host: "h", subject: "d", label: "l")
    #expect(String(decoding: message, as: UTF8.self) == "ah-native-login-v1\nc\nh\nd\nl")
    #expect(NativeAuth.base64URL(Data([0xFB, 0xFF])) == "-_8")
}

@Test func loopbackHostsOnlyWhenAllowed() throws {
    #expect(throws: HostEndpoint.ValidationError.self) { try HostEndpoint("http://127.0.0.1:7681") }
    #expect(try HostEndpoint("http://127.0.0.1:7681", allowLoopback: true).url.absoluteString == "http://127.0.0.1:7681")
    #expect(throws: HostEndpoint.ValidationError.self) { try HostEndpoint("http://10.0.0.2:7681", allowLoopback: true) }
    #expect(try HostEndpoint("https://box.tail.ts.net").shortName == "box")
}

@Test func apiErrorsCarryTheServersMessage() {
    #expect(APIError(status: 401, body: Data(#"{"error":"sign in required"}"#.utf8)) == .unauthorized("sign in required"))
    #expect(APIError(status: 409, body: Data(#"{"error":"a rebuild is already running"}"#.utf8)).message == "a rebuild is already running")
    #expect(APIError(status: 502, body: Data("host mac is offline".utf8)) == .server(status: 502, message: "host mac is offline"))
    #expect(APIError.transport("x").isTransient)
    #expect(!APIError.forbidden("x").isTransient)
}

@Test func omarchyThemesMapToAhsTokensAndTheTerminal() {
    let theme = OmarchyTheme(name: "tokyo", mode: "dark", colors: ["background": "#1a1b26", "foreground": "#a9b1d6", "accent": "#7aa2f7", "green": "#9ece6a", "cyan": "#7dcfff", "red": "#f7768e"], font: "JetBrainsMono Nerd Font")
    let palette = try! #require(ThemePalette.omarchy(theme))
    #expect(palette.brand == "#7aa2f7")
    #expect(palette.surface == "#1a1b26", "no dark_background: the background")
    #expect(palette.run == "#7dcfff" && palette.done == "#9ece6a" && palette.danger == "#f7768e")
    #expect(palette.color(for: .needsYou) == "#7aa2f7")
    #expect(palette.terminal.ansi.count == 16)
    #expect(palette.terminal.ansi[9] == "#f7768e", "bright red falls back to red")
    #expect(ThemePalette.omarchy(OmarchyTheme(name: "x", mode: "dark", colors: ["background": "#000000"], font: nil)) == nil)
    #expect(hexComponents("#ff000080")!.a > 0.5 && hexComponents("#ff000080")!.a < 0.51)
    #expect(hexComponents("nope") == nil)
}

@Test func questionFormsAnswerLikeTheAgentsOwnDialog() {
    let color = AskDTO.Question(question: "Pick a color", header: "Color", multiSelect: false, options: [.init(label: "Red", description: nil, checked: nil), .init(label: "Green", description: nil, checked: nil)])
    let toppings = AskDTO.Question(question: "Toppings", header: nil, multiSelect: true, options: [.init(label: "Cheese", description: nil, checked: nil), .init(label: "Olives", description: nil, checked: nil), .init(label: "Basil", description: nil, checked: nil)])
    var single = QuestionForm(questions: [color])
    #expect(single.instant)
    let submitsNow = single.choose(0, 1)
    #expect(submitsNow, "one single-choice question answers on the pick")
    #expect(single.answers == [QuestionAnswer(picked: [1])])

    var form = QuestionForm(questions: [color, toppings], initial: [[], [2]])
    #expect(!form.instant)
    #expect(form.answered(1), "a half-answered multi choice from the terminal counts")
    let first = form.choose(0, 0)
    #expect(!first)
    #expect(form.firstOpen == nil)
    let second = form.choose(1, 0)
    #expect(!second)
    let third = form.choose(1, 2)
    #expect(!third, "toggling off")
    form.setOther(1, text: " Fox ")
    #expect(form.answers == [QuestionAnswer(picked: [0]), QuestionAnswer(picked: [0], text: "Fox")])
    form.setOther(0, text: "Teal")
    #expect(form.answers[0] == QuestionAnswer(picked: [], text: "Teal"), "a typed answer replaces a single pick")
    var empty = QuestionForm(questions: [color, toppings])
    #expect(!empty.complete && empty.firstOpen == 0)
    empty.setOther(0, text: "   ")
    #expect(!empty.answered(0), "blank typing isn't an answer")
}

@Test func deepLinksFromPushRoutesAndURLs() {
    // server/push.ts strips "/#" from the web hash: a bare uid, or a review layer.
    #expect(DeepLink(route: "ah-1a2b", host: "box") == .session(host: "box", uid: "ah-1a2b"))
    #expect(DeepLink(route: "/#ah-1a2b", host: nil) == .session(host: nil, uid: "ah-1a2b"))
    #expect(DeepLink(route: "review/stk_1234/42", host: "box") == .review(host: "box", ReviewRoute(stack: "stk_1234", pr: 42)))
    #expect(DeepLink(route: "", host: "box") == .inbox(host: "box"))
    #expect(DeepLink(route: "../etc/passwd", host: nil) == .inbox(host: nil), "nothing but a uid opens a session")

    let link = DeepLink.session(host: "box", uid: "ah-1")
    #expect(DeepLink(url: link.url) == link)
    let review = DeepLink.review(host: "peer", ReviewRoute(stack: "stk_1234", pr: 7))
    #expect(DeepLink(url: review.url) == review)
    #expect(DeepLink(url: URL(string: "https://box.ts.net/#ah-1")!) == nil)

    #expect(link.sessionKey(localHost: "box") == "ah-1")
    #expect(link.sessionKey(localHost: "other") == "box/ah-1")
    #expect(DeepLink.session(host: nil, uid: "ah-1").sessionKey(localHost: "box") == "ah-1")
}

@Test func newSessionsTakeATypedModelAndAnyTmuxSession() throws {
    #expect(LaunchState.isValidModelID("claude-opus-5-5"))
    #expect(LaunchState.isValidModelID("org/model:v1.2@latest"))
    #expect(!LaunchState.isValidModelID("-leading-dash"))
    #expect(!LaunchState.isValidModelID("has space"))
    #expect(!LaunchState.isValidModelID("ünïcode"))
    #expect(!LaunchState.isValidModelID(String(repeating: "a", count: 81)))
    #expect(!LaunchState.isValidModelID(""))
    let json = Data(#"{"id":"claude","name":"Claude","command":"claude","models":[{"id":"opus","name":"Opus"},{"id":"sonnet","name":"Sonnet"}],"defaultModel":"sonnet","modelArgs":["--model","{model}"],"available":true}"#.utf8)
    let preset = try JSONDecoder().decode(PresetDTO.self, from: json)
    #expect(LaunchState.takesCustomModel(preset))
    #expect(LaunchState.chosenModel(listed: "opus", typed: "  claude-opus-5-5 ", preset: preset) == "claude-opus-5-5")
    #expect(LaunchState.chosenModel(listed: "opus", typed: "bad id", preset: preset) == "opus", "an invalid typed id never goes out")
    #expect(LaunchState.chosenModel(listed: "sonnet", typed: "", preset: preset) == nil, "the default sends nothing")
    #expect(LaunchState.tmuxChoices(sessions: ["work", "ah"], defaultSession: "ah") == (["work", "ah"], "ah"))
    #expect(LaunchState.tmuxChoices(sessions: ["work"], defaultSession: "ah").initial == "work")
    #expect(LaunchState.tmuxChoices(sessions: [], defaultSession: "ah").initial == nil)
}

@Test func handoffCarriesTheWebHashBothWays() throws {
    let origin = "https://desk.tail1234.ts.net"
    let session = Handoff(origin: origin, route: .session("a1b2c3"), title: "fix login")
    #expect(session.hash == "a1b2c3")
    #expect(session.webpageURL?.absoluteString == "https://desk.tail1234.ts.net/#a1b2c3")
    #expect(Handoff(userInfo: session.userInfo)?.route == .session("a1b2c3"))
    let peer = Handoff(origin: origin, route: .session("laptop/zz9y8x"), title: "")
    #expect(Handoff(userInfo: peer.userInfo)?.route == .session("laptop/zz9y8x"))
    let review = Handoff(origin: origin, route: .review(ReviewRoute(stack: "stk1", pr: 42)), title: "Review")
    #expect(review.hash == "review/stk1/42")
    #expect(Handoff.route(hash: "#review/stk1/42") == .review(ReviewRoute(stack: "stk1", pr: 42)))
    #expect(Handoff.route(hash: "history") == .history)
    #expect(Handoff.route(hash: "security") == .settings(nil))
    #expect(Handoff.route(hash: "") == .inbox)
    #expect(Handoff.route(hash: "@12") == .inbox, "an old tmux window id can't be resolved here")
    #expect(Handoff.route(hash: "bad host!/abcd1") == .inbox)
    #expect(Handoff(origin: origin, route: .inbox, title: "Inbox").webpageURL?.absoluteString == "https://desk.tail1234.ts.net/")
    #expect(Handoff(origin: "http://127.0.0.1:7000", route: .inbox, title: "").webpageURL == nil, "only an https host has a page to hand to")
    #expect(Handoff(userInfo: ["hash": "abc12"]) == nil, "no host, nothing to continue")
}

@Test func aForkSendsOnlyWhatDiffersFromItsParent() {
    let same = LaunchState.forkRequest(name: "  Try B ", prompt: "", mode: "default", modes: 1, inherited: ("opus", "high"), picked: ("opus", "high"))
    #expect(same == ForkRequest(name: "Try B"))
    let changed = LaunchState.forkRequest(name: "", prompt: "Rewrite the parser", mode: "plan", modes: 3, inherited: ("opus", "high"), picked: ("sonnet", nil))
    #expect(changed == ForkRequest(prompt: "Rewrite the parser", model: "sonnet", effort: "default", mode: "plan"))
}

@Test func aMacIsNamedForItsHostName() {
    #expect(DeviceDescriptor.macName(hostName: "Evyatars-MacBook-Pro.local") == "Evyatars MacBook Pro")
    #expect(DeviceDescriptor.macName(hostName: "studio") == "studio")
    #expect(DeviceDescriptor.macName(hostName: "") == "Mac")
}

@Test func onlyStatusesThatNeedYouAskForWords() {
    #expect(StatusWord.needsYou.asksForAttention && StatusWord.limited.asksForAttention)
    #expect(!StatusWord.idle.asksForAttention && !StatusWord.working.asksForAttention && !StatusWord.done.asksForAttention && !StatusWord.newOutput.asksForAttention)
}

@Test func aScreenPromptStillSaysWhatItWouldRun() {
    let text = "[me@box infra]$ claude\n✻ Welcome\n Bash command\n   ./keys/rotate.sh\n   Rotate the API signing keys\n Do you want to proceed?"
    let ask = AskDTO(kind: .screen, text: text, questions: nil, options: nil, dialog: nil)
    let parts = AskParts(ask)
    #expect(parts.kind == "Wants to run a command")
    #expect(parts.command == "./keys/rotate.sh")
    #expect(parts.description == "Rotate the API signing keys")
    #expect(parts.question == nil, "the generic question adds nothing")
    #expect(AskParts.line(ask) == "Wants to run ./keys/rotate.sh")
    // A screen prompt without a command stays a plain question.
    let plain = AskParts(AskDTO(kind: .screen, text: "Overwrite the file?", questions: nil, options: nil, dialog: nil))
    #expect(plain.command == nil && plain.question == "Overwrite the file?")
}

// Port of ../ah/web/logos.tsx's logoKey.
@Test func agentsFindTheirOwnLogoByIdAliasOrName() {
    #expect(AgentLogo.key("claude") == "claude")
    #expect(AgentLogo.key("Codex") == "codex")
    #expect(AgentLogo.key("custom-qwen-code") == "qwen", "an agent added on the host, by its usual name")
    #expect(AgentLogo.key("custom-kilo") == "kilocode", "by an alias")
    #expect(AgentLogo.key("cursor-agent") == "cursor")
    #expect(AgentLogo.key("custom-mytool") == nil)
    #expect(AgentLogo.initial("custom-mytool") == "M")
    #expect(AgentLogo.initial("custom-") == "?")
    #expect(AgentLogo.tiles.isSubset(of: AgentLogo.known))
    // Every logo the app names is in the asset catalog (scripts/agent-logos.sh).
    let catalog = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../App/Assets.xcassets/Agents").standardized
    let sets = Set(((try? FileManager.default.contentsOfDirectory(atPath: catalog.path)) ?? []).filter { $0.hasSuffix(".imageset") }.map { String($0.dropLast(9)) })
    #expect(sets == AgentLogo.known)
}
