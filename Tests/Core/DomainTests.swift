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
