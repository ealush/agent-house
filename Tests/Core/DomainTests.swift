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
    #expect(StatusWord.summary([.needsYou, .newOutput, .newOutput, .idle]) == "1 session needs you. 2 with new output. 1 idle.")
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

@Test func theKeyboardWalksEveryRowOfTheQuestions() {
    let color = AskDTO.Question(question: "Pick a color", header: nil, multiSelect: false, options: [.init(label: "Red", description: nil, checked: nil), .init(label: "Green", description: nil, checked: nil)])
    let toppings = AskDTO.Question(question: "Toppings", header: nil, multiSelect: true, options: [.init(label: "Cheese", description: nil, checked: nil)])
    var form = QuestionForm(questions: [color, toppings])
    #expect(form.spots == [.option(0, 0), .option(0, 1), .other(0), .option(1, 0), .other(1), .submit])
    #expect(form.step(.option(0, 1), by: 1) == .other(0))
    #expect(form.step(.other(0), by: 1) == .option(1, 0), "down from a question's last row is the next question")
    #expect(form.step(.option(0, 0), by: -1) == .option(0, 0), "stops at the top")
    #expect(form.step(.submit, by: 1) == .submit, "and at the bottom")
    _ = form.choose(0, 1)
    #expect(form.after(0) == .option(1, 0), "answering one question moves on to the next open one")
    _ = form.choose(1, 0)
    #expect(form.after(1) == .submit, "everything answered: the Answer button")
    #expect(QuestionForm(questions: [color]).spots.last == .other(0), "a pick answers a lone single choice: no Answer button")
}

@Test func theQuestionReviewShowsWhatYouAnswered() {
    let text = "←  ☒ Storage  ☒ Events  ✔ Submit  →\nReview your answers\n ● Where should sign-in sessions be stored?\n   → Postgres\n ● Which events should the audit log keep?\n   → Sign-ins, Exports, API keys\nReady to submit your answers?"
    let options = [AskDTO.ScreenOption(key: "1", label: "Submit answers"), AskDTO.ScreenOption(key: "2", label: "Cancel")]
    let screen = AskParts(AskDTO(kind: .screen, text: text, questions: nil, options: options, dialog: nil))
    #expect(screen.kind == "Check your answers")
    #expect(screen.review == [.init(question: "Where should sign-in sessions be stored?", answer: "Postgres"), .init(question: "Which events should the audit log keep?", answer: "Sign-ins, Exports, API keys")])
    #expect(screen.context == nil, "the answers are the point, not the terminal text")
    // A hook still reporting the questions at the review: the review wins.
    let hooked = AskParts(AskDTO(kind: .choice, text: text, questions: [AskDTO.Question(question: "Where should sign-in sessions be stored?", header: nil, multiSelect: false, options: [])], options: options, dialog: nil))
    #expect(hooked.review.count == 2)
    #expect(!AskParts.isForm(AskDTO(kind: .choice, text: text, questions: [AskDTO.Question(question: "Where should sign-in sessions be stored?", header: nil, multiSelect: false, options: [])], options: options, dialog: nil)), "the review is buttons, not the form")
    #expect(AskParts.isForm(AskDTO(kind: .choice, text: "Pick", questions: nil, options: nil, dialog: AskDTO.Dialog(question: "Pick", multiSelect: false, options: [], total: 1, answered: 0))))
    #expect(AskParts.reviewed("Do you want to proceed?\n ● not a review").isEmpty)
    let plan = AskParts(AskDTO(kind: .screen, text: "Would you like to proceed?", questions: nil, options: [.init(key: "1", label: "Yes, and auto-accept edits"), .init(key: "3", label: "No, keep planning")], dialog: nil))
    #expect(plan.kind == "Plan ready" && plan.question == "Start on this plan?", "a plan is named as one, not as a generic prompt")
}

@Test func aScreenInFrontOfThePromptReadsWholeWithoutItsKeyHints() throws {
    // As server/agentgate.ts sends Codex's device-code sign-in.
    let json = #"{"kind":"screen","text":"Welcome to Codex, OpenAI's command-line coding agent\nFinish signing in via your browser\n1. Open this link in your browser and sign in\nhttps://auth.openai.com/codex/device\n2. Enter this one-time code after you are signed in (expires in 15 minutes)\nJUC6-GKWC4\nPress esc to cancel","gate":{"kind":"signin","links":["https://auth.openai.com/codex/device"],"code":"JUC6-GKWC4","back":true}}"#
    let ask = try JSONDecoder().decode(AskDTO.self, from: Data(json.utf8))
    let parts = AskParts(ask)
    #expect(parts.kind == "Needs you to sign in")
    #expect(parts.gate?.code == "JUC6-GKWC4" && parts.gate?.back == true)
    #expect(parts.gateLines.contains("JUC6-GKWC4"), "the code stands where the screen put it")
    #expect(parts.gateLines.contains("https://auth.openai.com/codex/device"))
    #expect(!parts.gateLines.contains("Press esc to cancel"), "Back is a button")
    for hint in ["Esc cancel", "(escape/ctrl+c to cancel)", "↑↓ navigate  enter select  escape/ctrl+c cancel", "c copy code • u copy url • enter copy & open • esc exit", "ctrl+q  quit"] {
        #expect(AskParts.isTerminalHint(hint), "\(hint)")
    }
    #expect(!AskParts.isTerminalHint("Enter the authorization code:"), "a question it asks stays")
    #expect(!AskParts.isTerminalHint("Press any key to log in..."), "what the terminal waits for stays")
    #expect(AskParts.line(ask) == "Needs you to sign in")
    #expect(AskParts.gateLabel("trust") == "Asks to trust this folder")
    #expect(AskParts.gateLabel("something-new") == "Needs setting up", "a kind this build doesn't know still reads")
    // Rows keep the line under them; a send held behind it says so.
    let row = try JSONDecoder().decode(AskDTO.ScreenOption.self, from: Data(#"{"key":"2","label":"Sign in with Device Code","description":"Sign in from another device with a one-time code"}"#.utf8))
    #expect(row.description == "Sign in from another device with a one-time code")
    let local = try JSONDecoder().decode(AskDTO.Gate.self, from: Data(#"{"kind":"signin","links":["https://auth.openai.com/oauth/authorize?x=1"],"local":true,"callback":"http://127.0.0.1:1455/auth/callback","back":true}"#.utf8))
    #expect(local.callback == "http://127.0.0.1:1455/auth/callback" && local.local == true)
    let sent = try JSONDecoder().decode(SendResult.self, from: Data(#"{"outcome":"queued","windowId":"@1","resumed":false,"queued":1,"queueId":"a1","held":"signin"}"#.utf8))
    #expect(sent.held == "signin")
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

@Test func placesReadAndWriteTheWebHash() {
    // Pages, review and settings, as the web's fromHash reads them.
    #expect(Place(hash: "").route == .inbox)
    #expect(Place(hash: "#history") == Place(.inbox, searching: true), "History is the Inbox's search now")
    #expect(Place(hash: "#search") == Place(.inbox, searching: true), "so is Search")
    #expect(!Place(hash: "").searching)
    #expect(Place(hash: "#sessions").route == .inbox, "the Sessions tab is the Inbox now")
    #expect(Place(hash: "review/stk1/42").route == .review(ReviewRoute(stack: "stk1", pr: 42)))
    #expect(Place(hash: "settings/agents").route == .settings("agents"))
    #expect(Place(hash: "settings/security").route == .settings(nil), "Security is bare settings, as on the web")
    #expect(Place(hash: "settings/nope").route == .settings(nil))
    #expect(Place(.settings("environment")).hash == "settings/environment")
    // A session with its view, a panel and a message.
    let message = Place(hash: "a1b2c3?m=42")
    #expect(message == Place(.session("a1b2c3"), message: 42))
    #expect(Place(hash: "laptop/zz9y8x?view=terminal").surface == .terminal)
    #expect(Place(hash: "a1b2c3?panel=diff&m=7") == Place(.session("a1b2c3"), panel: .diff, message: 7))
    #expect(Place(.session("a1b2c3"), surface: .terminal, panel: .files, message: 3).hash == "a1b2c3?view=terminal&panel=files&m=3")
    for hash in ["a1b2c3", "laptop/zz9y8x?m=12", "a1b2c3?view=terminal&panel=snapshots", "review/stk1/42", "settings/system", "search", ""] {
        #expect(Place(hash: hash).hash == hash, "\(hash) round-trips")
    }
    // Options only belong to a session, and only known ones count.
    #expect(Place(hash: "search?m=4") == Place(.inbox, searching: true))
    #expect(Place(hash: "a1b2c3?panel=nope&view=sideways&m=-1") == Place(.session("a1b2c3")))
    #expect(Place(.inbox, message: 4, searching: true).hash == "search")
    #expect(Place(.review(ReviewRoute()), searching: true).hash == "review", "only the Inbox searches")
    // Nothing but a session key opens a session.
    #expect(Place(hash: "../etc/passwd").route == .inbox)
    #expect(Place(hash: "a/b/c1234").route == .inbox)
    #expect(Place(hash: "bad host!/abcd1").route == .inbox)
}

@Test func linksNameAPlaceOnOneOfYourHosts() throws {
    let desk = AppLink.Account(origin: "https://desk.tail1234.ts.net", hostname: "desk", peers: ["laptop"])
    let other = AppLink.Account(origin: "https://box.tail1234.ts.net", hostname: "box", peers: [])
    let accounts = [other, desk]
    let place = Place(.session("a1b2c3"), message: 42)

    // A web link is the host's own address with the place as its hash.
    let web = try #require(AppLink.webURL(origin: desk.origin, place: place))
    #expect(web.absoluteString == "https://desk.tail1234.ts.net/#a1b2c3?m=42")
    let fromWeb = try #require(AppLink(url: web))
    #expect(fromWeb.resolve(accounts)! == (desk.origin, place))
    #expect(AppLink(url: URL(string: "https://elsewhere.example/#a1b2c3")!)!.resolve(accounts) == nil, "not one of your hosts")
    #expect(AppLink.webURL(origin: desk.origin, place: Place(.inbox))?.absoluteString == "https://desk.tail1234.ts.net/")

    // An app link names the host: by its full name (the web app's "Open in Agent House") or hostname.
    let app = try #require(AppLink.appURL(host: "desk.tail1234.ts.net", place: place))
    #expect(app.absoluteString == "agenthub://desk.tail1234.ts.net/a1b2c3?m=42")
    #expect(AppLink(url: app)!.resolve(accounts)! == (desk.origin, place))
    #expect(AppLink(url: URL(string: "agenthub://desk/settings/agents")!)!.resolve(accounts)! == (desk.origin, Place(.settings("agents"))))
    // A peer's name opens its session through the host that reaches it.
    #expect(AppLink(url: URL(string: "agenthub://laptop/zz9y8x?view=terminal")!)!.resolve(accounts)! == (desk.origin, Place(.session("laptop/zz9y8x"), surface: .terminal)))
    // "local" is this window's host.
    #expect(AppLink(url: URL(string: "agenthub://local/search")!)!.resolve(accounts, preferred: desk.origin)! == (desk.origin, Place(.inbox, searching: true)))
    // The links this app already made (notifications, new windows) still open.
    #expect(AppLink(url: DeepLink.session(host: "box", uid: "ah-1234").url)!.resolve(accounts)! == (other.origin, Place(.session("ah-1234"))))
    #expect(AppLink(url: URL(string: "agenthub://unknown/a1b2c3")!)!.resolve(accounts) == nil)

    // Pasted text: the link alone, trimmed; anything else isn't one.
    #expect(AppLink(text: "  <https://desk.tail1234.ts.net/#history>\n")?.place == Place(.inbox, searching: true), "an old History link opens the Inbox's search")
    #expect(AppLink(text: "see https://desk.tail1234.ts.net/#history") == nil)
    #expect(AppLink(text: "mailto:me@example.com") == nil)
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
    #expect(Handoff.route(hash: "history") == .inbox)
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
    let catalog = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Shared/AgentLogos.xcassets/Agents").standardized
    let sets = Set(((try? FileManager.default.contentsOfDirectory(atPath: catalog.path)) ?? []).filter { $0.hasSuffix(".imageset") }.map { String($0.dropLast(9)) })
    #expect(sets == AgentLogo.known)
}

@Test func answerControlsReadTheKeysTheWebPanelDoes() {
    let press = { (usage: Int, chars: String, mods: KeyPress.Modifiers) in AskKey(KeyPress(hidUsage: usage, characters: chars, modifiers: mods)) }
    #expect(press(0x1F, "2", []) == .digit(2))
    #expect(press(0x1F, "@", [.shift]) == nil, "Shift+2 isn't a pick")
    #expect(press(0x51, "", []) == .down)
    #expect(press(0x2B, "\t", [.shift]) == .up)
    #expect(press(0x2C, " ", []) == .choose)
    #expect(press(0x28, "\r", []) == .choose)
    #expect(press(0x28, "\r", [.command]) == .submit)
    #expect(press(0, "\r", [.command]) == .submit, "a Return without its usual key code is still Return")
    #expect(press(0x29, "", []) == .leave)
    #expect(press(0x1C, "y", []) == .letter("y"))
    #expect(press(0x0E, "k", [.command]) == nil, "⌘K is the window's (the palette)")
    #expect(press(0x27, "0", []) == nil, "no row 0")
}

@Test func terminalTextSizeStepsWithinItsRangeAndDroppedFilesTypeTheirPaths() {
    #expect(TerminalTextSize.step(13, by: 1) == 14)
    #expect(TerminalTextSize.step(28, by: 1) == 28, "never past the largest")
    #expect(TerminalTextSize.step(8, by: -1) == 8, "never under the smallest")
    #expect(TerminalTextSize.clamped(15.6) == 16, "whole points, as pinching settles")
    #expect(Uploads.typed(["/up/a.png", "/up/my shot.png"]) == "/up/a.png '/up/my shot.png' ", "quoted when needed, a space after, ready for more")
    #expect(Uploads.typed([]) == "")
}

@Test func alertsStayOutOfTheWayOfWhatYouAreDoing() {
    #expect(AlertRules.presentation(key: "a", onScreen: true, appActive: true) == .nothing, "you're looking at it")
    #expect(AlertRules.presentation(key: "a", onScreen: false, appActive: true) == .listOnly, "the app's own nudge says it")
    #expect(AlertRules.presentation(key: "a", onScreen: false, appActive: false) == .banner)
    #expect(AlertRules.presentation(key: nil, onScreen: false, appActive: true) == .banner, "a stack review has no nudge")
    let delivered = [
        AlertRules.Delivered(id: "1", key: "keys", event: "waiting"),
        AlertRules.Delivered(id: "2", key: "docs", event: "waiting"),
        AlertRules.Delivered(id: "3", key: "web", event: "done"),
        AlertRules.Delivered(id: "4", key: "api", event: "done"),
        AlertRules.Delivered(id: "5", key: nil, event: "waiting"),
    ]
    #expect(AlertRules.stale(delivered, waiting: ["keys"], seen: ["api"]) == ["2", "4"], "answered elsewhere, or opened here; a finished one stays until seen")
    let offline = [AlertRules.Delivered(id: "6", key: "docs", event: "waiting", live: false)]
    #expect(AlertRules.stale(offline, waiting: [], seen: []).isEmpty, "a host that isn't live can't say it was answered")
    #expect(AlertRules.stale(offline, waiting: [], seen: ["docs"]) == ["6"], "but opening it is still seeing it")
}

@Test func theAppWorksOutTheHostsAlertsFromItsOwnLists() throws {
    func row(_ status: String, ask: [String: Any]? = nil, answerable: Bool = false, limit: String? = nil) throws -> SessionRow {
        var object: [String: Any] = ["id": "@1", "uid": "u1", "name": "keys", "title": "Rotate keys", "statusSource": "screen", "project": "infra", "projectPath": "/p/infra", "status": status, "command": "claude", "agent": "claude", "answerable": answerable]
        if let ask { object["ask"] = ask }
        if let limit { object["limit"] = limit }
        return SessionRow(key: "u1", host: "box", isLocal: true, dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    var watcher = AlertWatcher()
    let start = Date()
    #expect(watcher.observe(origin: "h", rows: [try row("waiting")], now: start).isEmpty, "the first look alerts nothing")
    #expect(watcher.observe(origin: "h", rows: [try row("busy")], now: start).isEmpty)
    let asked = watcher.observe(origin: "h", rows: [try row("waiting", ask: ["kind": "command", "text": "Bash command\n./keys/rotate.sh"], answerable: true)], now: start.addingTimeInterval(40))
    #expect(asked == [.init(id: "h#u1", event: .waiting, title: "Rotate keys needs you", body: "infra · Wants to run ./keys/rotate.sh", host: "box", uid: "u1", answerable: true)])
    _ = watcher.observe(origin: "h", rows: [try row("busy")], now: start.addingTimeInterval(50))
    #expect(watcher.observe(origin: "h", rows: [try row("attention")], now: start.addingTimeInterval(60)).isEmpty, "within 30 s of the last alert: quiet")
    _ = watcher.observe(origin: "h", rows: [try row("busy")], now: start.addingTimeInterval(80))
    let done = watcher.observe(origin: "h", rows: [try row("attention")], now: start.addingTimeInterval(90), agentName: { $0 == "claude" ? "Claude Code" : $0 })
    #expect(done.first?.title == "Rotate keys finished" && done.first?.body == "infra · Claude Code" && done.first?.answerable == false)
    #expect(watcher.observe(origin: "h", rows: [try row("idle")], now: start.addingTimeInterval(200)).isEmpty, "settling to idle isn't news")
    #expect(watcher.observe(origin: "other", rows: [try row("waiting")], now: start).isEmpty, "each host has its own first look")
}

// MARK: Questions with previews, notes and "Chat about this"

@Test func aQuestionWithPreviewsTakesAPickAndNotesNotATypedAnswer() throws {
    let json = #"{"question":"Which layout?","header":"Layout","multiSelect":false,"options":[{"label":"Stacked","preview":"+--+\n|  |"},{"label":"Inline","description":"Side by side"}]}"#
    let question = try JSONDecoder().decode(AskDTO.Question.self, from: Data(json.utf8))
    #expect(question.hasPreviews)
    #expect(question.options[0].preview == "+--+\n|  |")
    #expect(question.options[1].preview == nil)
    var form = QuestionForm(questions: [question])
    #expect(!form.instant, "a pick shows its preview first; it doesn't answer at once")
    #expect(!form.spots.contains(.other(0)), "no Something else row")
    #expect(form.choose(0, 1) == false)
    form.setNotes(0, "  make it\ncompact ")
    #expect(form.complete)
    #expect(form.answers == [QuestionAnswer(picked: [1], notes: "make it compact")])
    let plain = QuestionForm(questions: [AskDTO.Question(question: "Q", header: nil, multiSelect: false, options: [AskDTO.Option(label: "A", description: nil, checked: nil)])])
    #expect(plain.instant && plain.spots.contains(.other(0)), "without previews, nothing changes")
}

@Test func answersCarryNotesAndTheDialogSaysWhenItHasPreviews() throws {
    let encoded = String(decoding: try JSONEncoder().encode(QuestionAnswer(picked: [0], notes: "n")), as: UTF8.self)
    #expect(encoded.contains(#""notes":"n""#))
    #expect(!String(decoding: try JSONEncoder().encode(QuestionAnswer(picked: [0])), as: UTF8.self).contains("notes"))
    let dialog = try JSONDecoder().decode(AskDTO.Dialog.self, from: Data(#"{"question":"Q","multiSelect":false,"options":[{"label":"A","preview":"x"}],"total":1,"answered":0,"cursor":1,"previews":true}"#.utf8))
    #expect(dialog.previews == true)
    let old = try JSONDecoder().decode(AskDTO.Dialog.self, from: Data(#"{"question":"Q","multiSelect":false,"options":[],"total":1,"answered":0}"#.utf8))
    #expect(old.previews == nil, "an older host's dialog still reads")
}

@Test func rowsSitOnACardThatRisesOffTheGround() {
    // ah's own palettes: the surface.
    #expect(ThemePalette.dark.card == ThemePalette.dark.surface)
    #expect(ThemePalette.light.card == ThemePalette.light.surface)
    #expect(ThemePalette.dark.tile == ThemePalette.dark.raised)
    // Tokyo Night's dark_background sits below its ground: rows take lighter_background, and
    // an agent's tile steps above that.
    let tokyo = OmarchyTheme(name: "tokyo-night", mode: "dark", colors: [
        "background": "#1a1b26", "dark_background": "#13141c", "lighter_background": "#24283b",
        "foreground": "#a9b1d6", "bright_foreground": "#c0caf5", "accent": "#7aa2f7", "selection": "#292e42",
    ], font: nil)
    let palette = try! #require(ThemePalette.omarchy(tokyo))
    #expect(palette.card == "#24283b")
    #expect(palette.tile != palette.card && ThemePalette.luminance(palette.tile) > ThemePalette.luminance(palette.card))
    // No lighter layer at all (raised falls back to the foreground): a card mixed from the
    // ground, never the foreground.
    let bare = try! #require(ThemePalette.omarchy(OmarchyTheme(name: "bare", mode: "dark", colors: ["background": "#1a1b26", "foreground": "#a9b1d6", "accent": "#7aa2f7"], font: nil)))
    #expect(bare.card != bare.raised && bare.card != bare.background)
    #expect(ThemePalette.luminance(bare.card) < ThemePalette.luminance(bare.background) + 0.08)
}

@Test func aCancelledRequestIsNotAnErrorToShow() {
    #expect(APIError.shown(CancellationError()) == nil)
    #expect(APIError.shown(URLError(.cancelled)) == nil)
    #expect(APIError.shown(URLError(.notConnectedToInternet)) != nil)
}

@Test func aScreenChoiceDropsTheTerminalsKeyForIt() {
    #expect(AskParts.choiceLabel("No, and tell Claude what to do differently (esc)") == "No, and tell Claude what to do differently")
    #expect(AskParts.choiceLabel("Yes, allow all edits (shift+tab)") == "Yes, allow all edits")
    #expect(AskParts.choiceLabel("Yes, and don't ask again for ./keys commands") == "Yes, and don't ask again for ./keys commands")
    #expect(AskParts.keepingPaths("again for ./keys commands") == "again for ./\u{2060}keys commands")
    #expect(AskParts.keepingPaths("either / or") == "either / or")
    #expect(AskParts.keepingPaths("no paths") == "no paths")
    #expect(AskParts.choiceLabel("Use Redis (fast)") == "Use Redis (fast)", "a choice's own words in parentheses stay")
}

@Test func anUploadTheHostWontTakeSaysSoPlainly() {
    let error = APIError(status: 413, body: Data(#"{"error":"body too large"}"#.utf8))
    #expect(error.message == "It’s larger than your host accepts.")
}

@Test func effortLevelsReadAsWordsAndExtraHighIsNotATypo() {
    #expect(LaunchState.effortName("xhigh") == "Extra high")
    #expect(LaunchState.effortName("high") == "High")
    #expect(LaunchState.effortName("max") == "Max")
}

@Test func modelsReadAsPeopleSayThemAndAnAliasNamesWhatReallyRuns() throws {
    #expect(LaunchState.shortModel("claude-fable-5-2") == "Fable 5.2")
    #expect(LaunchState.shortModel("claude-haiku-4-5-20251001") == "Haiku 4.5")
    #expect(LaunchState.shortModel("claude-opus-5-5[1m]") == "Opus 5.5")
    #expect(LaunchState.shortModel("muse-wonder-1.0") == "Wonder 1.0")
    #expect(LaunchState.shortModel("muse-wonder-full-1.0") == "Wonder Full 1.0")
    #expect(LaunchState.shortModel("gpt-6.1-sol") == "6.1 Sol")
    #expect(LaunchState.shortModel("grok-4.7-build-fast") == "4.7 Build")
    #expect(LaunchState.shortModel("default") == nil)

    let claude = try JSONDecoder().decode(PresetDTO.self, from: Data(#"{"id":"claude","name":"Claude","command":"claude","models":[{"id":"fable","name":"Fable 5.2"},{"id":"opus","name":"Opus 5.5"}],"available":true}"#.utf8))
    func running(_ model: String?, agent: String = "claude") throws -> SessionDTO {
        var object: [String: Any] = ["id": "%1", "uid": "1", "name": "s", "title": "s", "statusSource": "hook", "project": "ah", "projectPath": "/p/ah", "status": "idle", "command": "node", "agent": agent]
        if let model { object["model"] = model }
        return try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
    }
    let older = LaunchState(preset: claude, session: try running("claude-fable-5-1"))
    #expect(older.model?.id == "fable", "the alias is still the choice")
    #expect(older.modelLabel == "Fable 5.1", "named for what runs, not the alias's newest model")
    #expect(LaunchState(preset: claude, session: try running("claude-fable-5-2")).modelLabel == "Fable 5.2")
    #expect(LaunchState(preset: claude, session: try running("opus")).modelLabel == "Opus 5.5", "the alias itself keeps its name")

    let muse = try JSONDecoder().decode(PresetDTO.self, from: Data(#"{"id":"muse","name":"Muse","command":"muse","models":[{"id":"muse-wonder-1.0","name":"Muse Wonder 1.0"},{"id":"muse-wonder-full-1.0","name":"Muse Wonder Full 1.0"}],"available":true}"#.utf8))
    let full = LaunchState(preset: muse, session: try running("muse-wonder-full-1.0", agent: "muse"))
    #expect(full.model?.id == "muse-wonder-full-1.0" && full.modelLabel == "Muse Wonder Full 1.0", "Full is never taken for Wonder")
}

@Test func aModelSwitchedMidTurnShowsAtOnce() throws {
    let claude = try JSONDecoder().decode(PresetDTO.self, from: Data(#"{"id":"claude","name":"Claude","command":"claude","models":[{"id":"fable","name":"Fable 5.1"},{"id":"opus","name":"Opus 5.5"}],"available":true}"#.utf8))
    func row(model: String?, launchModel: String?) throws -> SessionDTO {
        var object: [String: Any] = ["id": "%1", "uid": "1", "name": "s", "title": "s", "statusSource": "hook", "project": "ah", "projectPath": "/p/ah", "status": "busy", "command": "node", "agent": "claude"]
        if let model { object["model"] = model }
        if let launchModel { object["launchModel"] = launchModel }
        return try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
    }
    var report = ModelReport()
    report.take(chosen: "fable", reported: "claude-fable-5-1")
    #expect(!report.pickIsNewer, "opened as it is: the agent's word")
    // Switched through ah mid-turn: the agent hasn't written since.
    report.take(chosen: "opus", reported: "claude-fable-5-1")
    #expect(report.pickIsNewer)
    let switched = try row(model: "claude-fable-5-1", launchModel: "opus")
    #expect(LaunchState(preset: claude, session: switched, preferChosen: report.pickIsNewer).modelLabel == "Opus 5.5", "the chip names the pick")
    #expect(LaunchState(preset: claude, session: switched).modelLabel == "Fable 5.1", "without the report, the agent's last word")
    // The agent writes with the new model: its word again.
    report.take(chosen: "opus", reported: "claude-opus-5-5")
    #expect(!report.pickIsNewer)
    // Switched in its own terminal: only what it reports changes, and that's what shows.
    report.take(chosen: "opus", reported: "claude-fable-5-1")
    #expect(!report.pickIsNewer)
}

@Test func aRowsTimeIsAFewCharacters() {
    let now = 1_800_000_000.0
    #expect(ElapsedWords.short(since: now - 5, now: now) == "now")
    #expect(ElapsedWords.short(since: now + 40, now: now) == "now", "a host's clock a little ahead")
    #expect(ElapsedWords.date(epoch: 1_763_000_000) == ElapsedWords.date(epoch: 1_763_000_000_000), "seconds and milliseconds read as the same time")
    #expect(ElapsedWords.short(since: now - 60, now: now) == "1m")
    #expect(ElapsedWords.short(since: now - 59 * 60, now: now) == "59m")
    #expect(ElapsedWords.short(since: now - 3600, now: now) == "1h")
    #expect(ElapsedWords.short(since: now - 23 * 3600, now: now) == "23h")
    #expect(ElapsedWords.short(since: now - 6 * 86_400, now: now) == "6d")
    #expect(ElapsedWords.short(since: now - 20 * 86_400, now: now) == "2w")
    #expect(ElapsedWords.short(since: now - 800 * 86_400, now: now) == "2y")
}

// A session's agent as its screen shows it (`AgentHold`).

@Test func aScanThatMissesTheAgentKeepsItsConversationOnScreen() {
    var hold = AgentHold()
    let start = Date()
    #expect(hold.take(agent: nil, feed: nil, now: start) == nil, "the window's shell before the agent: nothing to hold")
    #expect(hold.agent == nil)
    #expect(hold.take(agent: "claude", feed: "claude", now: start.addingTimeInterval(1)) == nil)
    #expect(hold.feed == "claude")
    // A scan misses it: still the agent, and the screen is told when to look again.
    let again = hold.take(agent: nil, feed: nil, now: start.addingTimeInterval(2))
    #expect(again == start.addingTimeInterval(2 + AgentHold.grace))
    #expect(hold.agent == "claude" && hold.feed == "claude", "the conversation stays")
    #expect(hold.take(agent: nil, feed: nil, now: start.addingTimeInterval(3)) == again, "the hold runs from the first miss")
    #expect(hold.take(agent: "claude", feed: "claude", now: start.addingTimeInterval(4)) == nil, "back: no hold")
    // Missing past the hold: the agent exited, and the terminal shows.
    _ = hold.take(agent: nil, feed: nil, now: start.addingTimeInterval(10))
    #expect(hold.take(agent: nil, feed: nil, now: start.addingTimeInterval(10 + AgentHold.grace)) == nil)
    #expect(hold.agent == nil && hold.feed == nil)
}


@Test func swipeFillsCarryTheSystemsWhiteLabel() {
    // The dark palette's statuses are pale, made for its dark ground; under white they were
    // 1.7–2.3:1. Deepened, they reach 4.5:1 and keep their hue.
    for hex in [ThemePalette.dark.danger, ThemePalette.dark.limited, ThemePalette.dark.done, ThemePalette.dark.accent] {
        let fill = ThemePalette.underWhite(hex)
        #expect(ThemePalette.contrastWithWhite(fill) >= 4.5, "\(hex) → \(fill)")
        #expect(fill != hex)
    }
    // The light palette's are deep already: left as they are.
    #expect(ThemePalette.underWhite(ThemePalette.light.danger) == ThemePalette.light.danger)
    #expect(ThemePalette.underWhite(ThemePalette.light.done) == ThemePalette.light.done)
}

@Test func aWindowLeftOnAPageThatIsGoneOpensTheInbox() throws {
    // A window saved on the phone's Sessions tab, before it went into the Inbox.
    let saved = Data(#"{"version":2,"sceneID":"a","hostOrigin":"https://one.example.ts.net","route":{"sessions":{}},"historyFilter":"auth"}"#.utf8)
    let snapshot = try JSONDecoder().decode(SceneSnapshot.self, from: saved)
    #expect(snapshot.route == .inbox)
    #expect(snapshot.hostOrigin == "https://one.example.ts.net", "the rest of the window comes back as it was")
    // One left on History or Search, before they went into the Inbox.
    for page in ["history", "search"] {
        let saved = Data(#"{"version":2,"sceneID":"b","hostOrigin":null,"route":{"\#(page)":{}}}"#.utf8)
        #expect(try JSONDecoder().decode(SceneSnapshot.self, from: saved).route == .inbox, "\(page)")
    }
}
