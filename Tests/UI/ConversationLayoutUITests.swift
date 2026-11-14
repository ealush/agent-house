import UIKit
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
    /// The demo's orbit-api session (its agent takes `/stream`, `/burst` and `/long`), and another.
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
        app.launchArguments += ["-AHFreshWindow", "-AHTouchOnly"]
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
        app.buttons.matching(identifier: "Cancel").firstMatch.tap()
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
        open(Self.main)
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
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model'")).firstMatch
        XCTAssertTrue(model.waitForExistence(timeout: 5), "no model chip in the settings")
        model.tap()
        let choice = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Sonnet' OR label CONTAINS 'Haiku'")).firstMatch
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
        for word in ["streaming", "under", "the", "box", "while", "typing", "a", "few", "words"] {
            composer.typeText(word + " ")
            settle(0.6)
            XCTAssertEqual(box.frame.maxY, rest.maxY, accuracy: 1, "the box moved while the transcript streamed")
        }
        assertBarOnKeyboard("typed while streaming")
        let newest = transcriptTexts().last { $0.label.hasPrefix("Step ") || $0.label.hasPrefix("After step") || $0.label.contains("passing") }
        XCTAssertNotNil(newest, "the transcript isn't showing the steps streaming in")
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

    // MARK: Elements

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

    private func open(_ title: String) {
        if isPhone, app.tabBars.buttons["Sessions"].exists { app.tabBars.buttons["Sessions"].tap() }
        let row = app.descendants(matching: .any).matching(identifier: "session:\(title)").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "no session row for \(title)")
        row.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "no composer in \(title)")
        XCTAssertTrue(transcript.waitForExistence(timeout: 15), "no transcript in \(title)")
        settle(1.5)
    }

    private func back() {
        if keyboardUp { dismissKeyboardByTap() }
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

    private func paste() {
        composer.press(forDuration: 1.0)
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

    /// On the keyboard: no gap under the bar and no overlap with the keys.
    private func assertBarOnKeyboard(_ when: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(keyboardUp, "\(when): no keyboard", file: file, line: line)
        let bar = dock.frame, keys = keyboard.frame
        XCTAssertLessThanOrEqual(bar.maxY, keys.minY + 1, "\(when): the bar is \(bar.maxY - keys.minY) pt under the keyboard", file: file, line: line)
        XCTAssertGreaterThanOrEqual(bar.maxY, keys.minY - 14, "\(when): a \(keys.minY - bar.maxY) pt gap between the bar and the keyboard", file: file, line: line)
        assertBarUnderTop(when, file: file, line: line)
        keep(when)
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

    /// A text near the middle of the transcript's view, to watch.
    private func middleText() -> XCUIElement? {
        let middle = (topEdge + dock.frame.minY) / 2
        return transcriptTexts().min { abs($0.frame.midY - middle) < abs($1.frame.midY - middle) }
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

    private static func picture(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 120, height: 90)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 120, height: 90))
        }
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
        try await Task.sleep(for: .seconds(1))
    }
}
