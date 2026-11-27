import AVFoundation
import UIKit
import UniformTypeIdentifiers
import XCTest

/// Where things are on the conversation screen, against a demo host (scripts/demo/host.mjs) that the
/// tests drive themselves: a long conversation, a turn streaming in (the demo agent's `/stream` and
/// `/burst`), a queue of a dozen. Each test asserts geometry, not existence:
/// - the bar stands on the keyboard (no gap, no overlap) or on the bottom edge;
/// - the queue stays inside the screen and under the navigation bar;
/// - the transcript is drawn, judged from the screenshot's pixels, because a blank transcript still
///   lists its rows to accessibility;
/// - what you're reading stays where it is.
///
/// Skipped unless a demo host is given, with its local token for driving the session:
///
///     TEST_RUNNER_AH_LAYOUT=1 TEST_RUNNER_AH_DEMO_ORIGIN=http://127.0.0.1:47691 \
///     TEST_RUNNER_AH_DEMO_CODE=<scripts/demo/code.mjs> TEST_RUNNER_AH_DEMO_TOKEN=<demo.json localToken> \
///     xcodebuild test … -only-testing:AgentHubNativeUITests/ConversationLayoutUITests
///
/// TEST_RUNNER_AH_TOUR_OUT=<folder on the Mac> also keeps the screenshots taken along the way there.
@MainActor
final class ConversationLayoutUITests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment
    private var app: XCUIApplication!
    private var host: DemoHost!
    /// The demo's orbit-api session (its agent takes `/stream`, `/burst`, `/stubborn` and `/long`), and another.
    private static let main = "Users latency"
    private static let other = "Welcome flow"

    override func setUp() async throws {
        guard environment["AH_LAYOUT"] == "1", let origin = environment["AH_DEMO_ORIGIN"].flatMap(URL.init(string:)),
              let token = environment["AH_DEMO_TOKEN"], environment["AH_DEMO_CODE"] != nil else {
            throw XCTSkip("Set TEST_RUNNER_AH_LAYOUT=1 and a demo host (origin, setup code, local token).")
        }
        continueAfterFailure = false
        host = DemoHost(origin: origin, token: token)
        // Each test starts from a quiet session: no turn running, nothing queued.
        try await host.reset(Self.main)
        try await host.reset(Self.other)
        app = XCUIApplication()
        app.launchArguments += ["-AHFreshWindow", "-AHTouchOnly", "-AHLayoutProbe"]
        app.launch()
        try enroll()
    }

    override func tearDown() {
        // The next test's setUp quiets the session; here only what outlives the app.
        XCUIDevice.shared.orientation = .portrait
    }

    // MARK: The tests (numbered as in the plan: docs/native/CONVERSATION-LAYOUT.md)

    /// 1. Open a conversation and focus the composer.
    func test01OpenAndFocus() async throws {
        try await host.send(Self.main, ["/long 40"])
        open(Self.main)
        assertBarOnEdge("opened")
        assertTranscriptDrawn("opened")
        focusComposer()
        assertBarOnKeyboard("focused")
        assertTranscriptDrawn("focused")
    }

    /// 2. The keyboard up and down, again and again: the bar lands on it each time, at one width.
    func test02KeyboardUpAndDown() throws {
        open(Self.main)
        var columns: Set<Int> = []
        for round in 1...5 {
            focusComposer()
            assertBarOnKeyboard("up \(round)")
            columns.insert(Int(dock.frame.minX.rounded()) * 10_000 + Int(dock.frame.width.rounded()))
            dismissKeyboardByTap()
            assertBarOnEdge("down \(round)")
            columns.insert(Int(dock.frame.minX.rounded()) * 10_000 + Int(dock.frame.width.rounded()))
        }
        XCTAssertEqual(columns.count, 1, "the bar changed its width or place across the keyboard going up and down")
        assertTranscriptDrawn("after the rounds")
    }

    /// 3. Typing line after line: the box grows up to its most, then scrolls inside, and stays on the keyboard.
    func test03MultilineToMaxHeight() throws {
        open(Self.main)
        focusComposer()
        var heights: [CGFloat] = []
        for line in 1...16 {
            composer.typeText(line == 1 ? "Line 1" : "\nLine \(line)")
            heights.append(box.frame.height)
            assertBarOnKeyboard("line \(line)")
        }
        for (a, b) in zip(heights, heights.dropFirst()) {
            XCTAssertGreaterThanOrEqual(b, a - 0.5, "the box shrank while the text grew: \(heights)")
        }
        XCTAssertGreaterThan(heights.last!, heights.first! + 40, "the box didn't grow with the text: \(heights)")
        XCTAssertEqual(heights.suffix(4).max()! - heights.suffix(4).min()!, 0, accuracy: 0.5, "the box kept growing past its most: \(heights)")
        // The conversation keeps a usable share of the screen.
        XCTAssertGreaterThan(dock.frame.minY - topEdge, 120, "the box left the conversation \(dock.frame.minY - topEdge) pt")
        assertTranscriptDrawn("sixteen lines")
    }

    /// 4. Paste text, then two pictures: the pictures go in the box, inside the bar, on the keyboard.
    func test04PasteTextAndImages() throws {
        open(Self.main)
        focusComposer()
        UIPasteboard.general.string = "Pasted words that run on long enough to wrap onto a second line in the box."
        paste()
        XCTAssertTrue((composer.value as? String ?? "").contains("Pasted words"), "the pasted text isn't in the box")
        UIPasteboard.general.images = [Self.picture(.systemPink), Self.picture(.systemTeal)]
        paste()
        let strip = app.descendants(matching: .any)["attachments"]
        XCTAssertTrue(strip.waitForExistence(timeout: 10), "no attachment strip after pasting pictures")
        XCTAssertTrue(dock.frame.contains(strip.frame.insetBy(dx: 1, dy: 1)), "the pictures sit outside the bar: \(strip.frame) vs \(dock.frame)")
        assertBarOnKeyboard("pictures pasted")
        assertTranscriptDrawn("pictures pasted")
    }

    /// 5. A queue of twelve, opened all the way: inside the screen, under the bar, and the box still there.
    func test05LargeQueueExpanded() async throws {
        try await host.send(Self.main, ["/stream 400"] + Self.queued(12))
        open(Self.main)
        focusComposer()
        XCTAssertTrue(tray.waitForExistence(timeout: 15), "no queue tray with twelve queued")
        expandQueue()
        assertQueueBounded("expanded")
        assertBarOnKeyboard("queue expanded")
        XCTAssertTrue(composer.isHittable, "the box is covered with the queue open")
        assertTranscriptDrawn("queue expanded")
    }

    /// 6. Add and remove queued messages with the keyboard up: the box doesn't move.
    func test06QueueEditsWithKeyboard() async throws {
        try await host.send(Self.main, ["/stream 400"] + Self.queued(10))
        open(Self.main)
        focusComposer()
        XCTAssertTrue(tray.waitForExistence(timeout: 15))
        let rest = box.frame.maxY
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "Remove", "Remove")).firstMatch.tap()
        settle()
        XCTAssertEqual(box.frame.maxY, rest, accuracy: 1, "cancelling a queued message moved the box")
        assertBarOnKeyboard("cancelled one")
        composer.typeText("One more for the queue")
        app.buttons["Queue"].tap()
        settle()
        XCTAssertEqual(box.frame.maxY, rest, accuracy: 1, "queueing a message moved the box")
        assertBarOnKeyboard("queued one")
        assertQueueBounded("after edits")
    }

    /// 6b. A Send Now the host refuses (the agent didn't stop) says why, and still does once the
    /// tray has read the queue again: the message is still in it.
    func test06bRefusedSendNowSaysWhy() async throws {
        try await host.send(Self.main, ["/stubborn 400"] + Self.queued(2))
        open(Self.main)
        XCTAssertTrue(tray.waitForExistence(timeout: 15), "no queue tray with two queued")
        app.buttons["Send Now"].firstMatch.tap()
        let why = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn’t send it now")).firstMatch
        // ah gives up on the stop after about six seconds.
        XCTAssertTrue(why.waitForExistence(timeout: 20), "a refused Send Now said nothing")
        XCTAssertTrue(why.label.contains("did not stop"), why.label)
        // Past the tray's next read of the queue (every three seconds).
        try await Task.sleep(for: .seconds(4))
        XCTAssertTrue(why.exists, "the tray's reload cleared why it wasn't sent")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Queued follow-up'")).count, 2, "the message left the queue")
        keep("refused")
    }

    /// 7. Folding the queue doesn't move the box.
    func test07CollapseQueueKeepsBox() async throws {
        try await host.send(Self.main, ["/stream 400"] + Self.queued(12))
        open(Self.main)
        focusComposer()
        XCTAssertTrue(tray.waitForExistence(timeout: 15))
        expandQueue()
        let rest = box.frame
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Up next'")).firstMatch.tap()
        settle()
        XCTAssertEqual(box.frame.maxY, rest.maxY, accuracy: 1, "folding the queue moved the box")
        XCTAssertEqual(box.frame.minX, rest.minX, accuracy: 1)
        assertBarOnKeyboard("queue folded")
        assertTranscriptDrawn("queue folded")
    }

    /// 8. Another session with the keyboard up: its own conversation, its own draft, and the draft
    /// left in the first is still there on coming back.
    func test08SwitchSessionsWithKeyboard() throws {
        open(Self.main)
        focusComposer()
        composer.typeText("Draft for the first")
        back()
        open(Self.other)
        focusComposer()
        assertBarOnKeyboard("second session")
        assertTranscriptDrawn("second session")
        XCTAssertFalse((composer.value as? String ?? "").contains("Draft for the first"), "the first session's draft showed in the second")
        back()
        open(Self.main, keepDraft: true)
        XCTAssertTrue((composer.value as? String ?? "").contains("Draft for the first"), "the draft was lost going to another session and back")
        assertTranscriptDrawn("back to the first")
    }

    /// 9. Another model from the settings: the draft and the queue stay as they were.
    func test09SwitchModelKeepsState() async throws {
        try await host.send(Self.main, ["/stream 400"] + Self.queued(4))
        open(Self.main)
        focusComposer()
        composer.typeText("Draft that outlives a model change")
        XCTAssertTrue(tray.waitForExistence(timeout: 15))
        app.buttons["Show session settings"].tap()
        // The chip is a menu, labelled "Model, <value>"; its choices are toggles.
        let model = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Model, '")).firstMatch
        XCTAssertTrue(model.waitForExistence(timeout: 5), "no model chip in the settings")
        model.tap()
        let choice = app.descendants(matching: .any).matching(NSPredicate(format: "(label CONTAINS 'Sonnet' OR label CONTAINS 'Haiku') AND NOT (label BEGINSWITH 'Model, ')")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 5), "no other model to pick")
        choice.tap()
        settle()
        XCTAssertTrue((composer.value as? String ?? "").contains("Draft that outlives"), "changing the model lost the draft")
        XCTAssertTrue(tray.exists, "changing the model lost the queue")
        assertTranscriptDrawn("model changed")
    }

    /// 10. Typing while the transcript streams: the bar holds still, and the newest step stays in view.
    func test10StreamWhileTyping() async throws {
        try await host.send(Self.main, ["/stream 200"])
        open(Self.main)
        focusComposer()
        let rest = box.frame
        let before = transcriptWords()
        for word in ["streaming", "under", "the", "box", "while", "typing", "a", "few", "words"] {
            composer.typeText(word + " ")
            settle(0.6)
            XCTAssertEqual(box.frame.maxY, rest.maxY, accuracy: 1, "the box moved while the transcript streamed")
        }
        assertBarOnKeyboard("typed while streaming")
        // Following the turn: what's in view moved on, and the transcript is held at its end.
        XCTAssertNotEqual(transcriptWords(), before, "the transcript didn't move on as the turn streamed")
        if let anchor = (probe()?.json["transcript"] as? [String: Any])?["anchor"] as? String {
            XCTAssertEqual(anchor, "end", "the transcript let go of the end while it streamed")
        }
        assertTranscriptDrawn("while streaming")
    }

    /// 11. Reading back while the turn streams on: what you're reading stays where it is.
    func test11ScrollBackWhileStreaming() async throws {
        try await host.send(Self.main, ["/long 30"])
        try await Task.sleep(for: .seconds(2))
        try await host.send(Self.main, ["/stream 200"])
        open(Self.main)
        transcript.swipeDown()
        transcript.swipeDown()
        settle(1.5)
        let reading = try XCTUnwrap(middleText(), "nothing to read in the middle of the transcript")
        let label = reading.label, before = reading.frame.minY
        settle(6)
        let after = transcriptTexts().first { $0.label == label }
        XCTAssertNotNil(after, "what was being read left the screen as the turn streamed on")
        if let after { XCTAssertEqual(after.frame.minY, before, accuracy: 4, "what was being read moved \(after.frame.minY - before) pt as the turn streamed on") }
        assertTranscriptDrawn("reading back")
    }

    /// 12. Away from the session and back: where you were reading is where it opens.
    func test12AwayAndBack() async throws {
        try await host.send(Self.main, ["/long 30"])
        open(Self.main)
        transcript.swipeDown()
        transcript.swipeDown()
        settle(1.5)
        let reading = try XCTUnwrap(middleText())
        let label = reading.label
        back()
        // An iPad's sidebar stays: away is another session in its place.
        if !isPhone { open(Self.other) }
        open(Self.main)
        settle(1.5)
        XCTAssertNotNil(transcriptTexts().first { $0.label == label }, "came back somewhere else than where it was left")
        assertTranscriptDrawn("back again")
    }

    /// 13. Turning the phone with the keyboard up, and back.
    func test13RotateWithKeyboard() throws {
        open(Self.main)
        focusComposer()
        XCUIDevice.shared.orientation = .landscapeLeft
        settle(1.5)
        if keyboardUp { assertBarOnKeyboard("landscape") } else { assertBarOnEdge("landscape") }
        assertTranscriptDrawn("landscape", minimumHeight: 20)
        XCUIDevice.shared.orientation = .portrait
        settle(1.5)
        if keyboardUp { assertBarOnKeyboard("portrait again") } else { assertBarOnEdge("portrait again") }
        assertTranscriptDrawn("portrait again")
    }

    /// 15. Dragging the keyboard away with the transcript: it goes, and the bar comes down with it.
    func test15InteractiveDismissal() throws {
        open(Self.main)
        focusComposer()
        let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
        settle(1.5)
        XCTAssertFalse(keyboardUp, "the keyboard stayed up after dragging it down")
        assertBarOnEdge("dragged away")
        assertTranscriptDrawn("dragged away")
    }

    /// 20. The phone locked with the keyboard up, then unlocked: the bar is on the keyboard if it
    /// came back, or on the bottom edge if it didn't — never over the space a gone keyboard left.
    func test20LockWithKeyboardUp() throws {
        open(Self.main)
        focusComposer()
        assertBarOnKeyboard("before locking")
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        settle(2)
        // Wake, then unlock (no passcode on the simulator).
        XCUIDevice.shared.press(.home)
        settle(1)
        XCUIDevice.shared.press(.home)
        settle(1)
        app.activate()
        settle(2)
        if keyboardUp { assertBarOnKeyboard("unlocked, keyboard back") } else { assertBarOnEdge("unlocked, keyboard gone") }
        assertTranscriptDrawn("unlocked")
    }

    /// 21. Home with the keyboard up, then back to the app: the same.
    func test21AwayToHomeWithKeyboardUp() throws {
        open(Self.main)
        focusComposer()
        XCUIDevice.shared.press(.home)
        settle(2)
        app.activate()
        settle(2)
        if keyboardUp { assertBarOnKeyboard("back, keyboard back") } else { assertBarOnEdge("back, keyboard gone") }
        assertTranscriptDrawn("back")
    }

    /// 22. Light mode, a session's agent terminal: the bar over it is styled for the dark terminal
    /// (light title and buttons), so what's behind the bar is the terminal's dark, not the page's
    /// white, or its title is white on white.
    func test22TerminalHeaderInLightMode() throws {
        XCUIDevice.shared.appearance = .light
        // The simulator is left in light mode (XCTest takes no "unspecified" back).
        defer { XCUIDevice.shared.appearance = .light }
        open(Self.main)
        app.buttons["Session menu"].tap()
        let terminal = app.buttons["Agent Terminal"].exists ? app.buttons["Agent Terminal"] : app.menuItems["Agent Terminal"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 5), "no Agent Terminal in the session menu")
        terminal.tap()
        settle(2)
        let shot = XCUIScreen.main.screenshot()
        keep("terminal in light mode", shot)
        let bar = app.navigationBars.firstMatch.frame
        // The middle of the bar, under the title, clear of the round buttons at its ends.
        let band = CGRect(x: bar.minX + bar.width * 0.3, y: bar.minY + 4, width: bar.width * 0.4, height: max(8, bar.height - 8))
        let shade = Self.brightness(in: shot.image, region: band)
        XCTAssertLessThan(shade, 0.45, "behind the terminal's bar is \(Int(shade * 100))% bright: its light title can't be read")
        // Back to its messages: the session keeps the surface it was left on, and the next test
        // opens it expecting its conversation.
        app.buttons["Session menu"].tap()
        let messages = app.buttons["Messages"].exists ? app.buttons["Messages"] : app.menuItems["Messages"]
        if messages.waitForExistence(timeout: 5) { messages.tap() }
        settle()
    }

    /// 16. A turn writing fifteen steps a second while typing: every keystroke lands, the bar holds, the
    /// transcript keeps drawing.
    func test16HighFrequencyUpdates() async throws {
        try await host.send(Self.main, ["/burst 400"])
        open(Self.main)
        focusComposer()
        let rest = box.frame
        let typed = "every key lands while it streams"
        for character in typed {
            composer.typeText(String(character))
        }
        XCTAssertEqual(composer.value as? String, typed, "keystrokes were lost while the transcript streamed fast")
        XCTAssertEqual(box.frame.maxY, rest.maxY, accuracy: 1, "the box moved under fast streaming")
        for sample in 1...4 {
            assertTranscriptDrawn("burst \(sample)")
            settle(0.5)
        }
        assertBarOnKeyboard("after the burst")
    }

    /// 17. New session's box takes what a session's does: pasted words as words, pasted pictures as
    /// tiles inside the box (not dropped as nothing), and the microphone in its corner.
    func test17NewSessionPasteAndMicrophone() throws {
        if isPhone, app.tabBars.buttons["Inbox"].exists { app.tabBars.buttons["Inbox"].tap() }
        let new = app.buttons["New Session"].firstMatch
        XCTAssertTrue(new.waitForExistence(timeout: 15), "no New Session button")
        new.tap()
        let field = app.textViews["new-session-message"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no box on New Session")
        XCTAssertTrue(app.buttons["dictate"].waitForExistence(timeout: 5), "no microphone in New Session's box")
        field.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "no keyboard after tapping New Session's box")
        settle()
        UIPasteboard.general.string = "Pasted words for the first message."
        paste(into: field)
        XCTAssertTrue((field.value as? String ?? "").contains("Pasted words"), "the pasted text isn't in New Session's box")
        UIPasteboard.general.images = [Self.picture(.systemPink), Self.picture(.systemTeal)]
        paste(into: field)
        let strip = app.descendants(matching: .any)["attachments"]
        XCTAssertTrue(strip.waitForExistence(timeout: 10), "no attachment strip after pasting pictures into New Session")
        let removes = strip.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove '"))
        let both = expectation(for: NSPredicate(format: "count == 2"), evaluatedWith: removes)
        wait(for: [both], timeout: 10)
        XCTAssertTrue((field.value as? String ?? "").contains("Pasted words"), "pasting pictures changed the words")
        XCTAssertLessThan(strip.frame.maxY, field.frame.minY + 1, "the pictures aren't above the words in the box")
        // A video and a PDF, as Photos and Files copy them: each a tile too.
        UIPasteboard.general.setData(try Self.video(), forPasteboardType: UTType.mpeg4Movie.identifier)
        paste(into: field)
        UIPasteboard.general.setData(Self.document(), forPasteboardType: UTType.pdf.identifier)
        paste(into: field)
        let four = expectation(for: NSPredicate(format: "count == 4"), evaluatedWith: removes)
        wait(for: [four], timeout: 20)
        XCTAssertTrue(strip.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove ' AND label ENDSWITH '.mp4'")).firstMatch.exists, "the pasted video has no tile")
        XCTAssertTrue(strip.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove ' AND label ENDSWITH '.pdf'")).firstMatch.exists, "the pasted PDF has no tile")
        keep("pasted")
    }

    /// 23. New session starts with nothing said: its box's Send is there while the box is empty
    /// (a session's isn't), and starts it; the session takes over the screen. Nothing else on the
    /// stage starts it.
    func test23NewSessionStartsWithoutAMessage() throws {
        if isPhone, app.tabBars.buttons["Inbox"].exists { app.tabBars.buttons["Inbox"].tap() }
        let new = app.buttons["New Session"].firstMatch
        XCTAssertTrue(new.waitForExistence(timeout: 15), "no New Session button")
        new.tap()
        let field = app.textViews["new-session-message"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no box on New Session")
        XCTAssertEqual(field.value as? String ?? "", "", "New Session's box isn't empty")
        let send = app.buttons["new-session-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), "no Send in New Session's empty box")
        wait(for: [expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: send)], timeout: 10)
        XCTAssertFalse(app.buttons["Start Without a Message"].exists, "the stage still has its own Start Without a Message")
        keep("start-empty")
        send.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "the started session didn't take over New Session")
        XCTAssertFalse(field.exists, "New Session's box is still there after starting")
        keep("started-empty")
    }

    /// 24. A message swiped to quote it follows the finger the whole way: drawn where the drag has
    /// it while the finger is down (the probe reads where the row was drawn, not where it was asked
    /// to be), not still until it springs back at the end; let go past the mark, it's a chip in the box.
    func test24SwipeToQuoteFollowsTheFinger() async throws {
        try await host.send(Self.main, ["/long 12"])
        open(Self.main)
        settle(1.5)
        // A message halfway between the top bar and the box: the transcript runs on under both.
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let y = (topEdge + dock.frame.minY) / 2
        let start = origin.withOffset(CGVector(dx: window.width * 0.8, dy: y))
        let end = origin.withOffset(CGVector(dx: window.width * 0.35, dy: y))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.6)
        settle(1)
        let swipe = (probe()?.json["transcript"] as? [String: Any])?["swipe"] as? [String: Any]
        let shown = swipe?["shown"] as? Double ?? 0, asked = swipe?["asked"] as? Double ?? 0
        XCTAssertGreaterThan(asked, 60, "the drag didn't swipe the message (\(swipe ?? [:]))")
        XCTAssertGreaterThan(shown, asked * 0.8, "the message was drawn \(Int(shown)) pt along of the \(Int(asked)) the finger took it (\(swipe ?? [:]))")
        let chips = app.descendants(matching: .any)["composer-snippets"]
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "letting go past the mark put no chip in the box")
        keep("swiped-to-quote")
        // Out of the box again, so the next test's box starts empty.
        chips.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove '")).firstMatch.tap()
    }

    /// 25. New session's box is a session's (`ComposerBox`): a long paste is a chip over the words,
    /// not the words themselves; # brings up the host's sessions; and the session starts with the
    /// chip's text as its first message.
    func test25NewSessionBoxIsTheSessionsBox() throws {
        if isPhone, app.tabBars.buttons["Inbox"].exists { app.tabBars.buttons["Inbox"].tap() }
        let new = app.buttons["New Session"].firstMatch
        XCTAssertTrue(new.waitForExistence(timeout: 15), "no New Session button")
        new.tap()
        let field = app.textViews["new-session-message"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no box on New Session")
        field.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "no keyboard after tapping New Session's box")
        settle()
        UIPasteboard.general.string = (1...12).map { "Pasted line \($0) for the first message." }.joined(separator: "\n")
        paste(into: field)
        let chips = app.descendants(matching: .any)["composer-snippets"]
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "a long paste into New Session's box made no chip")
        XCTAssertFalse((field.value as? String ?? "").contains("Pasted line"), "the long paste went into the words, not a chip")
        field.typeText("#")
        let suggestions = app.descendants(matching: .any)["suggestions"]
        XCTAssertTrue(suggestions.waitForExistence(timeout: 10), "# brought up no sessions in New Session's box")
        keep("new-session-chip-and-suggestions")
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        field.typeText("Read this first.")
        XCTAssertTrue(suggestions.waitForNonExistence(timeout: 5), "the suggestions stayed up")
        app.buttons["new-session-send"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), "the started session didn't take over New Session")
        let first = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Pasted line 12 for the first message.'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 20), "the session's first message hasn't the chip's text")
        keep("new-session-started-with-chip")
    }

    /// 26. Review's boxes are the composer's box (`ComposerBox`): the question to the reviewer and the
    /// message to the agent both make a long paste a chip over the words, as a session's does.
    func test26ReviewBoxesAreTheComposersBox() throws {
        app.open(URL(string: "agenthub://local/review")!)
        let stack = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Cache the users query'")).firstMatch
        XCTAssertTrue(stack.waitForExistence(timeout: 15), "no demo stack in Review")
        stack.tap()
        let reviewer = app.navigationBars.buttons["Reviewer"].firstMatch
        XCTAssertTrue(reviewer.waitForExistence(timeout: 10), "no Reviewer in the stack's bar")
        reviewer.tap()
        let question = app.textViews["reviewer-question"]
        XCTAssertTrue(question.waitForExistence(timeout: 10), "the reviewer's question isn't the composer's box")
        question.tap()
        settle()
        UIPasteboard.general.string = (1...12).map { "Stack trace line \($0)" }.joined(separator: "\n")
        paste(into: question)
        XCTAssertTrue(app.descendants(matching: .any)["composer-snippets"].waitForExistence(timeout: 5), "a long paste into the reviewer's box made no chip")
        XCTAssertFalse((question.value as? String ?? "").contains("Stack trace line"), "the long paste went into the words")
        keep("reviewer-chip")
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(question.waitForNonExistence(timeout: 5), "the reviewer's sheet stayed")

        let layer = app.buttons["Review #101"].firstMatch
        XCTAssertTrue(layer.waitForExistence(timeout: 10), "no Review #101")
        layer.tap()
        let send = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Send ' AND label CONTAINS ' to '")).firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10), "no Send to the session on the layer")
        send.tap()
        let message = app.textViews["review-message"]
        XCTAssertTrue(message.waitForExistence(timeout: 10), "the message to the agent isn't the composer's box")
        message.tap()
        settle()
        paste(into: message)
        XCTAssertTrue(app.descendants(matching: .any)["composer-snippets"].waitForExistence(timeout: 5), "a long paste into the message to the agent made no chip")
        keep("dispatch-chip")
        app.buttons["Cancel"].firstMatch.tap()
    }

    /// 27. A chip in the box is still a chip after the app is closed and opened again: the host keeps
    /// the draft's chips with its text (`draftParts`), not only what they'd send ("> …" in the words).
    func test27ChipsSurviveARelaunch() throws {
        open(Self.main)
        focusComposer()
        UIPasteboard.general.string = (1...12).map { "Kept line \($0)" }.joined(separator: "\n")
        paste()
        composer.typeText("Why?")
        XCTAssertTrue(app.descendants(matching: .any)["composer-snippets"].waitForExistence(timeout: 5), "the long paste made no chip")
        // The draft goes to the host shortly after typing stops, and at once as the app leaves.
        settle(2)
        XCUIDevice.shared.press(.home)
        settle(2)
        app.terminate()
        app.launchArguments.removeAll { $0 == "-AHFreshWindow" }
        app.launch()
        // The window comes back where it was (the session open), or at the Inbox.
        if !composer.waitForExistence(timeout: 10) { open(Self.main) }
        let chips = app.descendants(matching: .any)["composer-snippets"]
        XCTAssertTrue(chips.waitForExistence(timeout: 10), "the chip came back as words, not a chip")
        XCTAssertEqual(composer.value as? String, "Why?", "the words aren't what was typed after the chip")
        keep("chip-after-relaunch")
        chips.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove '")).firstMatch.tap()
    }

    /// 18. Subagents: the chip is one of the setting chips over the box, its count changing in place
    /// (the box and the dock don't move, and the other chips stay whole beside it); its browser
    /// lists the tree, nested ones too; a child opens read-only (no box, its bar instead) and its bar
    /// goes back up to the parent, as Back does on a phone.
    func test18SubagentsChipBrowserAndChild() async throws {
        try await host.send(Self.main, ["/delegate 45"])
        open(Self.main)
        openSettings()
        XCTAssertTrue(subagentsChip.waitForExistence(timeout: 20), "no Subagents chip among the settings once the agent spawned subagents")
        let rest = box.frame
        let dockRest = dock.frame
        let active = expectation(for: NSPredicate(format: "label CONTAINS 'active'"), evaluatedWith: subagentsChip)
        await fulfillment(of: [active], timeout: 15)
        for sample in 1...4 {
            XCTAssertEqual(box.frame.minY, rest.minY, accuracy: 1, "the box moved as the count changed (\(sample))")
            XCTAssertEqual(dock.frame.height, dockRest.height, accuracy: 1, "the dock changed height as the count changed (\(sample))")
            XCTAssertLessThanOrEqual(subagentsChip.frame.maxY, dock.frame.minY + 1, "the chip isn't over the box")
            settle(0.7)
        }
        assertTranscriptDrawn("chip shown")
        // Whole, one line, inside the screen, and not over the chip beside it.
        XCTAssertLessThan(subagentsChip.frame.height, 60, "the chip broke onto two lines")
        XCTAssertGreaterThanOrEqual(subagentsChip.frame.minX, window.minX)
        let next = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model,'")).firstMatch
        if next.exists, next.frame.width > 0 {
            XCTAssertLessThanOrEqual(subagentsChip.frame.maxX, next.frame.minX + 1, "the Subagents chip covers the Model chip")
        }
        keep("subagents-chip")

        subagentsChip.tap()
        let list = app.descendants(matching: .any)["subagents-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10), "no subagents browser")
        for name in ["API boundary refactor", "Contract validator", "Test reliability", "Domain model audit"] {
            XCTAssertTrue(app.descendants(matching: .any)["subagent:\(name)"].waitForExistence(timeout: 10), "\(name) isn't in the browser")
        }
        keep("subagents-browser")
        app.descendants(matching: .any)["subagent:Contract validator"].tap()
        let footer = app.descendants(matching: .any)["subagent-footer"]
        XCTAssertTrue(footer.waitForExistence(timeout: 10), "a subagent opened without its read-only bar")
        XCTAssertFalse(composer.exists, "a read-only subagent has a box")
        XCTAssertTrue(transcript.waitForExistence(timeout: 10), "no transcript for the subagent")
        assertTranscriptDrawn("subagent")
        XCTAssertGreaterThan(footer.frame.minY, window.midY, "the bar isn't where the box would be")
        XCTAssertLessThanOrEqual(footer.frame.maxY, window.maxY + 1, "the bar runs off the screen")
        keep("subagent-child")

        // Up to its parent (another subagent), then up again to the session.
        app.buttons["subagent-parent"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["subagent-footer"].waitForExistence(timeout: 10), "the parent subagent didn't open")
        if isPhone {
            app.navigationBars.buttons.firstMatch.tap()
        } else {
            app.buttons["subagent-parent"].tap()
        }
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "back at the session, its box isn't there")
        assertBarOnEdge("back at the parent")
    }

    /// 19. Typing while subagents report: every key lands and the box holds still as counts change.
    func test19TypingWhileSubagentsWork() async throws {
        try await host.send(Self.main, ["/delegate 30"])
        open(Self.main)
        openSettings()
        XCTAssertTrue(subagentsChip.waitForExistence(timeout: 20), "no Subagents chip")
        focusComposer()
        let rest = box.frame
        let typed = "subagents keep working while I type this"
        for character in typed { composer.typeText(String(character)) }
        XCTAssertEqual(composer.value as? String, typed, "keystrokes were lost while subagents reported")
        XCTAssertEqual(box.frame.maxY, rest.maxY, accuracy: 1, "the box moved while subagents reported")
        assertBarOnKeyboard("typing with subagents")
        clearDraft()
    }

    // MARK: Elements

    private var subagentsChip: XCUIElement { app.buttons["subagents-chip"].firstMatch }

    /// The setting chips out over the box (the grabber on the box's top edge).
    private func openSettings() {
        let grabber = app.buttons["Show session settings"].firstMatch
        if grabber.waitForExistence(timeout: 10) { grabber.tap() }
        settle()
    }

    private var composer: XCUIElement { app.textViews["composer"] }
    private var dock: XCUIElement { app.descendants(matching: .any)["composer-dock"] }
    private var tray: XCUIElement { app.descendants(matching: .any)["queue-tray"] }
    private var transcript: XCUIElement { app.collectionViews["transcript"] }
    /// The box itself: the text field's frame stands for it (the box is a few points around it).
    private var box: XCUIElement { composer }
    private var keyboard: XCUIElement { app.keyboards.firstMatch }
    private var keyboardUp: Bool { keyboard.exists && keyboard.frame.height > 60 }
    private var window: CGRect { app.windows.firstMatch.frame }
    /// The bottom of the navigation bar (a phone's pushed session), or the window's top.
    private var topEdge: CGFloat {
        let bar = app.navigationBars.firstMatch
        return bar.exists ? bar.frame.maxY : window.minY
    }

    private var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    // MARK: Steps

    private func open(_ title: String, keepDraft: Bool = false) {
        if isPhone, app.tabBars.buttons["Inbox"].exists { app.tabBars.buttons["Inbox"].tap() }
        let row = app.descendants(matching: .any).matching(identifier: "session:\(title)").firstMatch
        // A phone's Inbox has the cards that need you on top: a row further down is scrolled to,
        // clear of the tab bar. By frame: hittability can't be asked while the tab pops back.
        if isPhone {
            _ = row.waitForExistence(timeout: 5)
            settle(0.5)
            let bar = app.tabBars.firstMatch
            func inReach() -> Bool { row.exists && row.frame.height > 0 && row.frame.minY >= topEdge && (!bar.exists || row.frame.maxY <= bar.frame.minY) }
            for _ in 0..<4 where !inReach() { app.swipeUp() }
        }
        // An iPad in portrait may have put its sidebar away behind the session.
        if !isPhone, !row.waitForExistence(timeout: 3), app.buttons["Show Sidebar"].exists { app.buttons["Show Sidebar"].tap() }
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no session row for \(title)")
        row.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "no composer in \(title)")
        XCTAssertTrue(transcript.waitForExistence(timeout: 15), "no transcript in \(title)")
        settle(1.5)
        if !keepDraft { clearDraft() }
    }

    /// A draft left from an earlier test (they're kept per session, across launches) goes first.
    private func clearDraft() {
        var cleared = false
        for _ in 0..<3 {
            let left = (composer.value as? String) ?? ""
            guard !left.isEmpty, left != composer.placeholderValue else { break }
            // All of it selected, then deleted: deleting from a tap's caret left the text after it, and
            // a tap in the box's corner lands on Send (or Queue) instead.
            composer.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.2)).tap()
            composer.press(forDuration: 1.1)
            let all = app.menuItems["Select All"].exists ? app.menuItems["Select All"] : app.buttons["Select All"]
            if all.waitForExistence(timeout: 3) {
                all.tap()
                composer.typeText(XCUIKeyboardKey.delete.rawValue)
            } else {
                composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: left.count + 2))
            }
            cleared = true
        }
        if cleared { dismissKeyboardByTap() }
    }

    /// Away from the session: a phone goes back to its list; an iPad keeps its sidebar beside the
    /// session, where the next `open` picks another.
    private func back() {
        if keyboardUp { dismissKeyboardByTap() }
        guard isPhone else { return }
        let back = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        settle()
    }

    private func focusComposer() {
        composer.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "no keyboard after tapping the box")
        settle()
    }

    private func dismissKeyboardByTap() {
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: keyboard)
        wait(for: [gone], timeout: 5)
        settle()
    }

    private func paste(into field: XCUIElement? = nil) {
        (field ?? composer).press(forDuration: 1.0)
        let item = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssertTrue(item.waitForExistence(timeout: 5), "no Paste in the box's menu")
        item.tap()
        settle()
    }

    private func expandQueue() {
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Show ' AND label ENDSWITH 'more queued messages'")).firstMatch
        if !more.exists {
            // Folded to its line: open it first.
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Up next'")).firstMatch.tap()
            settle()
        }
        if more.waitForExistence(timeout: 3) { more.tap() }
        settle()
    }

    /// Long enough for an animation (the keyboard's, a fold's) to land.
    private func settle(_ seconds: TimeInterval = 0.8) {
        Thread.sleep(forTimeInterval: seconds)
    }

    // MARK: Assertions

    /// On the keyboard: no gap under the bar and no overlap with the keys. XCUI's keyboard is its
    /// keys, without the suggestions row above them (part of the keyboard all the same), so against
    /// it alone a bar on the keyboard sits up to a suggestions row above. The app's layout probe
    /// (`-AHLayoutProbe`, debug builds) has the keyboard's real top: there, the dock's bottom is it.
    private func assertBarOnKeyboard(_ when: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(keyboardUp, "\(when): no keyboard", file: file, line: line)
        let bar = dock.frame, keys = keyboard.frame
        XCTAssertLessThanOrEqual(bar.maxY, keys.minY + 1, "\(when): the bar is \(bar.maxY - keys.minY) pt into the keys", file: file, line: line)
        XCTAssertGreaterThanOrEqual(bar.maxY, keys.minY - 64, "\(when): a \(keys.minY - bar.maxY) pt gap between the bar and the keys", file: file, line: line)
        if let probe = probe() {
            XCTAssertEqual(probe.dockBottom, probe.keyboardTop, accuracy: 1, "\(when): the dock ends at \(probe.dockBottom), the keyboard starts at \(probe.keyboardTop)", file: file, line: line)
            XCTAssertLessThanOrEqual(probe.keyboardTop, keys.minY + 1, "\(when): the keyboard guide is under the keys' top", file: file, line: line)
        }
        assertBarUnderTop(when, file: file, line: line)
        keep(when)
    }

    /// What the app's layout probe says (debug builds launched with `-AHLayoutProbe`), or nil.
    private func probe() -> (keyboardTop: CGFloat, dockBottom: CGFloat, json: [String: Any])? {
        let element = app.descendants(matching: .any)["layout-probe"]
        guard element.exists, let text = element.value as? String, let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let top = json["keyboardTopInWindow"] as? Double,
              let dock = json["dockInWindow"] as? [[Double]], dock.count == 2, dock[0].count == 2, dock[1].count == 2 else { return nil }
        return (CGFloat(top), CGFloat(dock[0][1] + dock[1][1]), json)
    }

    /// No keyboard: the bar stands on the bottom edge (above the home indicator).
    private func assertBarOnEdge(_ when: String, file: StaticString = #filePath, line: UInt = #line) {
        let bar = dock.frame
        XCTAssertLessThanOrEqual(bar.maxY, window.maxY + 0.5, "\(when): the bar runs off the bottom", file: file, line: line)
        XCTAssertGreaterThanOrEqual(bar.maxY, window.maxY - 56, "\(when): the bar floats \(window.maxY - bar.maxY) pt above the bottom", file: file, line: line)
        assertBarUnderTop(when, file: file, line: line)
        keep(when)
    }

    private func assertBarUnderTop(_ when: String, file: StaticString, line: UInt) {
        XCTAssertGreaterThanOrEqual(dock.frame.minY, topEdge - 0.5, "\(when): the bar reaches up under the navigation bar", file: file, line: line)
    }

    /// The queue: under the navigation bar, above the box, and no more than half the room above the keyboard.
    private func assertQueueBounded(_ when: String, file: StaticString = #filePath, line: UInt = #line) {
        let queue = tray.frame
        let floor = keyboardUp ? keyboard.frame.minY : window.maxY
        XCTAssertGreaterThanOrEqual(queue.minY, topEdge - 0.5, "\(when): the queue reaches under the navigation bar (\(queue.minY) < \(topEdge))", file: file, line: line)
        XCTAssertLessThanOrEqual(queue.maxY, box.frame.minY + 0.5, "\(when): the queue overlaps the box", file: file, line: line)
        XCTAssertLessThanOrEqual(queue.height, (floor - topEdge) * 0.5 + 1, "\(when): the queue takes \(Int(queue.height)) of \(Int(floor - topEdge)) pt", file: file, line: line)
        if let strip = Optional(app.descendants(matching: .any)["attachments"]), strip.exists {
            XCTAssertFalse(queue.intersects(strip.frame), "\(when): the queue and the pictures overlap", file: file, line: line)
        }
    }

    /// The transcript between the top bar and the composer is drawn: the screenshot has text in it,
    /// not one flat color (a blank transcript still lists its rows to accessibility).
    private func assertTranscriptDrawn(_ when: String, minimumHeight: CGFloat = 60, file: StaticString = #filePath, line: UInt = #line) {
        let top = topEdge, bottom = dock.frame.minY
        XCTAssertGreaterThanOrEqual(bottom - top, minimumHeight, "\(when): the transcript has \(bottom - top) pt", file: file, line: line)
        guard bottom - top >= 20 else { return }
        let shot = XCUIScreen.main.screenshot()
        let region = CGRect(x: window.minX + 40, y: top + 4, width: window.width - 56, height: bottom - top - 8)
        let ink = Self.ink(in: shot.image, region: region)
        XCTAssertGreaterThan(ink, 0.004, "\(when): the transcript is blank (\(String(format: "%.4f", ink)) of it has ink)", file: file, line: line)
        keep(when, shot)
    }

    /// Text rows of the transcript in view, top to bottom.
    private func transcriptTexts() -> [XCUIElement] {
        let top = topEdge, bottom = dock.frame.minY
        return transcript.staticTexts.allElementsBoundByIndex
            .filter { $0.exists && $0.frame.minY > top + 2 && $0.frame.maxY < bottom - 2 && !$0.label.isEmpty }
            .sorted { $0.frame.minY < $1.frame.minY }
    }

    /// What the transcript says in view, top to bottom: its texts, its steps (a step's row is a
    /// button: "Ran npm test, Completed") and its prose (a text view, `SelectableProse`, whose words
    /// are its value). With the keyboard up the view is a few lines tall, and often it holds only
    /// steps and prose: counting texts alone, it said nothing before or after.
    private func transcriptWords() -> [String] {
        let top = topEdge, bottom = dock.frame.minY
        let inView = { (e: XCUIElement) in e.exists && e.frame.minY > top + 2 && e.frame.maxY < bottom - 2 }
        let said = transcript.staticTexts.allElementsBoundByIndex.filter(inView).map { ($0.frame.minY, $0.label) }
            + transcript.buttons.allElementsBoundByIndex.filter(inView).map { ($0.frame.minY, $0.label) }
            + transcript.textViews.allElementsBoundByIndex.filter(inView).map { ($0.frame.minY, $0.value as? String ?? "") }
        return said.filter { !$0.1.isEmpty }.sorted { $0.0 < $1.0 }.map(\.1)
    }

    /// A text near the middle of the transcript's view, to watch: one whose words show once in
    /// view, so it's the one found again. A step's "Thinking", "Read" or "The agent took 15s"
    /// repeat down the screen, and the first of them was taken for the one watched: test 11
    /// reported 397 points of movement with every text where it had been.
    private func middleText() -> XCUIElement? {
        let middle = (topEdge + dock.frame.minY) / 2
        let texts = transcriptTexts()
        let counts = Dictionary(texts.map { ($0.label, 1) }, uniquingKeysWith: +)
        return texts.filter { counts[$0.label] == 1 }.min { abs($0.frame.midY - middle) < abs($1.frame.midY - middle) }
    }

    /// Keeps a screenshot in the results (and in AH_TOUR_OUT, when set) named for the moment.
    private func keep(_ when: String, _ shot: XCUIScreenshot? = nil) {
        let shot = shot ?? XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "\(name) \(when)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = environment["AH_TOUR_OUT"] {
            let file = "\(name)-\(when)".replacingOccurrences(of: "[^A-Za-z0-9-]+", with: "-", options: .regularExpression)
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent(file + ".png"))
        }
    }

    // MARK: Helpers

    /// The share of a region's pixels far from its most common shade: text, glyphs and tiles have
    /// some; a blank surface (or one flat gradient) has next to none.
    private static func ink(in image: UIImage, region: CGRect) -> Double {
        guard let cg = image.cgImage else { return 0 }
        let scale = CGFloat(cg.width) / image.size.width
        let pixels = CGRect(x: region.minX * scale, y: region.minY * scale, width: region.width * scale, height: region.height * scale).integral
        guard let crop = cg.cropping(to: pixels) else { return 0 }
        // Small enough to count quickly, big enough that a line of text survives.
        let width = 160, height = max(8, Int(160 * pixels.height / max(pixels.width, 1)))
        var gray = [UInt8](repeating: 0, count: width * height)
        let drawn: Bool = gray.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return 0 }
        var histogram = [Int](repeating: 0, count: 256)
        for value in gray { histogram[Int(value)] += 1 }
        let common = histogram.indices.max { histogram[$0] < histogram[$1] } ?? 0
        let far = gray.filter { abs(Int($0) - common) > 40 }.count
        return Double(far) / Double(gray.count)
    }

    /// A region's average brightness, 0 (black) to 1 (white).
    private static func brightness(in image: UIImage, region: CGRect) -> Double {
        guard let cg = image.cgImage else { return 1 }
        let scale = CGFloat(cg.width) / image.size.width
        let pixels = CGRect(x: region.minX * scale, y: region.minY * scale, width: region.width * scale, height: region.height * scale).integral
        guard let crop = cg.cropping(to: pixels) else { return 1 }
        let width = 64, height = max(4, Int(64 * pixels.height / max(pixels.width, 1)))
        var gray = [UInt8](repeating: 0, count: width * height)
        let drawn: Bool = gray.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn, !gray.isEmpty else { return 1 }
        return Double(gray.reduce(0) { $0 + Int($1) }) / Double(gray.count) / 255
    }

    private static func picture(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 120, height: 90)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 120, height: 90))
        }
    }

    /// A one-page PDF.
    private static func document() -> Data {
        UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 260)).pdfData { context in
            context.beginPage()
            ("Pasted document" as NSString).draw(at: CGPoint(x: 20, y: 20), withAttributes: [.font: UIFont.systemFont(ofSize: 16)])
        }
    }

    /// A second of video: thirty pink frames, H.264 in an MP4.
    private static func video() throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 160, AVVideoHeightKey: 120])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 160, kCVPixelBufferHeightKey as String: 120])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<30 {
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.01) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
            for i in stride(from: 0, to: CVPixelBufferGetBytesPerRow(buffer) * 120, by: 4) { base[i] = 0x90; base[i + 1] = 0x2D; base[i + 2] = 0xFF; base[i + 3] = 0xFF }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 30))
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        defer { try? FileManager.default.removeItem(at: url) }
        return try Data(contentsOf: url)
    }

    private static func queued(_ count: Int) -> [String] {
        (1...count).map { "Queued follow-up \($0) of \(count): check the users cache again after this." }
    }

    /// A fresh install pairs with the demo host using the setup code it was given.
    private func enroll() throws {
        let address = app.textFields["hostAddress"]
        guard address.waitForExistence(timeout: 4) else { return }
        guard let origin = environment["AH_DEMO_ORIGIN"], let code = environment["AH_DEMO_CODE"] else { throw XCTSkip("Not paired") }
        address.tap()
        address.typeText(origin)
        let field = app.textFields["setupCode"]
        field.tap()
        field.typeText(code)
        app.buttons["connectHost"].tap()
        XCTAssertTrue(address.waitForNonExistence(timeout: 20), "pairing with the demo host")
    }
}

/// The demo host's API, with its local token: what another device would do to the session.
struct DemoHost {
    let origin: URL
    let token: String

    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> Any {
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("1", forHTTPHeaderField: "X-AH")
        request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw NSError(domain: "DemoHost", code: status, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path): \(status) \(String(decoding: data, as: UTF8.self))"]) }
        return data.isEmpty ? [:] : try JSONSerialization.jsonObject(with: data)
    }

    func uid(_ title: String) async throws -> String {
        let state = try await call("GET", "/api/state") as? [String: Any]
        let windows = state?["windows"] as? [[String: Any]] ?? []
        guard let uid = windows.first(where: { $0["title"] as? String == title })?["uid"] as? String else {
            throw NSError(domain: "DemoHost", code: 404, userInfo: [NSLocalizedDescriptionKey: "no live session titled \(title)"])
        }
        return uid
    }

    /// Each line as a message; while the first one's turn runs, the rest wait in the queue.
    func send(_ title: String, _ lines: [String]) async throws {
        let uid = try await uid(title)
        for (index, text) in lines.enumerated() {
            _ = try await call("POST", "/api/sessions/\(uid)/send", ["text": text])
            if index == 0 { try await Task.sleep(for: .seconds(1.5)) }
        }
    }

    /// Nothing running and nothing queued.
    func reset(_ title: String) async throws {
        let uid = try await uid(title)
        _ = try? await call("DELETE", "/api/sessions/\(uid)/queue")
        _ = try? await call("POST", "/api/sessions/\(uid)/interrupt", [:])
        // A draft left in the box (a quoted message) would come back with the keyboard over it.
        _ = try? await call("PUT", "/api/sessions/\(uid)/draft", ["text": "", "device": "UI tests", "client": "ui-tests"])
        try await Task.sleep(for: .seconds(1))
    }
}
