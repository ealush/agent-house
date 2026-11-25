import XCTest

/// A Space's home on a phone: its sessions straight under the search, not under a card of its
/// folder, projects and tabs and a Chief of Staff pitch. Its own things (Files, Tasks,
/// Knowledge, a Chief, its settings) are its menu's, in the bar; its notes a tap away. Against
/// a demo host (scripts/demo/host.mjs) with a Space that has sessions, notes and no Chief:
///
///     TEST_RUNNER_AH_DEMO_ORIGIN=http://127.0.0.1:47681 TEST_RUNNER_AH_DEMO_CODE=<setup code> \
///     TEST_RUNNER_AH_PORTAL_SPACE='<the Space’s name>' xcodebuild test … \
///     -only-testing:AgentHubNativeUITests/SpaceHomeUITests
///
/// TEST_RUNNER_AH_TOUR_OUT=<folder on the Mac> also keeps the screenshots there.
@MainActor
final class SpaceHomeUITests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment

    func testSessionsComeFirst() throws {
        let (app, space) = try openSpace()
        let window = app.windows.firstMatch.frame
        let menu = app.buttons["space-menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "the Space's menu in the bar")
        let sessions = app.buttons["inbox-show-sessions"].firstMatch
        let notes = app.buttons["inbox-show-notes"].firstMatch
        XCTAssertTrue(sessions.waitForExistence(timeout: 5), "Sessions, under the search")
        XCTAssertTrue(notes.exists, "Notes, beside it")
        XCTAssertLessThan(notes.frame.maxY, window.height * 0.4, "the switch near the top, the sessions right under it")

        // What used to stand over the sessions is gone from the list.
        XCTAssertFalse(app.descendants(matching: .any)["space-portal-tabs"].exists, "no tab strip")
        XCTAssertFalse(app.descendants(matching: .any)["space-portal-path"].exists, "no folder card")
        XCTAssertFalse(app.buttons["space-chief-banner-start"].exists, "no Chief of Staff pitch")
        keep(app, "space-home")

        // The Space's menu: its tools, a Chief, its settings (a menu's items go by their names).
        menu.tap()
        for item in ["Files", "Tasks", "Knowledge", "Context", "Start Chief of Staff…", "Space Settings…"] {
            XCTAssertTrue(app.buttons[item].firstMatch.waitForExistence(timeout: 5), "\(item) in the Space's menu")
        }
        keep(app, "space-menu")
        app.buttons["Files"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["\(space) Files"].waitForExistence(timeout: 8), "Files in a sheet")
        keep(app, "space-files")
        app.navigationBars["\(space) Files"].buttons.firstMatch.tap()
        XCTAssertTrue(notes.waitForExistence(timeout: 5), "back on the Space")

        // Its notes, a tap away: the Space's own, with New Note.
        notes.tap()
        XCTAssertTrue(app.buttons["space-notes-new"].firstMatch.waitForExistence(timeout: 5), "the Space's notes")
        XCTAssertTrue(notes.isSelected, "Notes chosen")
        keep(app, "space-notes")
        sessions.tap()
        XCTAssertFalse(app.buttons["space-notes-new"].exists, "the sessions again")
    }

    /// Typed into, a note says where it's kept: in the bar as it's typed, on Done, and on the
    /// way back (a Space's notes need a note in it on the demo host).
    func testANoteSaysItsSaved() throws {
        let (app, _) = try openSpace()
        let notes = app.buttons["inbox-show-notes"].firstMatch
        XCTAssertTrue(notes.waitForExistence(timeout: 10), "Notes, under the search")
        notes.tap()
        let note = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'note:'")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 5), "a note in the Space")
        note.tap()

        let editor = app.descendants(matching: .any)["note-editor"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 8), "the note's text")
        editor.tap()
        editor.typeText(" One more line.")
        let saved = NSPredicate(format: "label BEGINSWITH 'Saved to '")
        XCTAssertTrue(app.navigationBars.staticTexts.matching(saved).firstMatch.waitForExistence(timeout: 5), "the bar says where it's saved")
        let done = app.buttons["note-done"].firstMatch
        XCTAssertTrue(done.exists, "Done in the bar")
        XCTAssertTrue(done.label.hasPrefix("Done, Saved to "), "Done says where it's saved")
        keep(app, "note-saved")

        done.tap()
        XCTAssertTrue(notes.waitForExistence(timeout: 5), "back on the Space")
        XCTAssertTrue(app.staticTexts.matching(saved).firstMatch.waitForExistence(timeout: 3), "the way back says it's saved")
        keep(app, "note-left")
    }

    /// A Chief is quiet: over its Space's sessions, one line (its crown and name) and its box,
    /// the session's own composer; nothing else says who's managed. Against a Space on the demo
    /// host with a Chief and workers: TEST_RUNNER_AH_CHIEF_SPACE='<the Space's name>'.
    func testAChiefIsQuiet() throws {
        guard let name = environment["AH_CHIEF_SPACE"], !name.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_AH_CHIEF_SPACE (a Space with a Chief on the demo host) and a demo host.")
        }
        let (app, _) = try openSpace(name)
        let open = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'space-chief-open-'")).firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 10), "the Chief's line over the sessions")
        let chief = open.label.components(separatedBy: ", Chief of Staff").first ?? ""
        XCTAssertFalse(app.buttons["Open"].exists, "no Open button: the line opens it")
        XCTAssertFalse(app.staticTexts["Supervised"].exists, "no Supervised on its workers' rows")

        // Its box is the session's composer: + to attach, the microphone, the text.
        let box = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'space-chief-quick-'")).firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 10), "the Chief's box")
        let field = box.textViews["composer"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "its text")
        XCTAssertTrue(box.buttons["Attach"].exists, "+ to attach")
        XCTAssertTrue(box.buttons["dictate"].exists, "the microphone")
        XCTAssertLessThan(box.frame.height, 80, "a line, not a card")
        keep(app, "chief-line")

        // Its suggestions come up over it, and the box stays above the keyboard.
        field.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "the keyboard")
        field.typeText("Look at @")
        XCTAssertTrue(box.buttons.matching(NSPredicate(format: "label CONTAINS '.'")).firstMatch.waitForExistence(timeout: 8), "the Chief's files to pick")
        XCTAssertLessThanOrEqual(field.frame.maxY, keyboard.frame.minY + 1, "the box under the keyboard")
        keep(app, "chief-suggestions")
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 9) + "Anything blocked?")
        let send = box.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Send to ' OR label BEGINSWITH 'Queue for '")).firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 5), "Send, with words in the box")
        send.tap()
        let said = NSPredicate(format: "label == %@ OR label == %@", "Sent to \(chief)", "Queued for \(chief)")
        XCTAssertTrue(app.staticTexts.matching(said).firstMatch.waitForExistence(timeout: 8), "it says it went to \(chief)")
        XCTAssertEqual(field.value as? String ?? "", field.placeholderValue ?? "", "the box empty again")
        keep(app, "chief-sent")

        // A worker's header says nothing of who manages it.
        let worker = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'session:' AND identifier != %@", "session:\(chief)")).firstMatch
        XCTAssertTrue(worker.waitForExistence(timeout: 5), "a worker in the Space")
        app.swipeDown()
        worker.tap()
        XCTAssertTrue(app.textViews["composer"].firstMatch.waitForExistence(timeout: 10) || app.otherElements["terminal"].exists, "the worker open")
        XCTAssertFalse(app.staticTexts["Managed by"].exists, "no Managed by in a worker's header")
        keep(app, "worker")
    }

    /// The app on the demo host, the Inbox narrowed to the Space.
    private func openSpace(_ name: String? = nil) throws -> (XCUIApplication, String) {
        guard let space = name ?? environment["AH_PORTAL_SPACE"], !space.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_AH_PORTAL_SPACE (a Space on the demo host) and a demo host.")
        }
        continueAfterFailure = true
        let app = XCUIApplication()
        app.launchArguments += ["-AHFreshWindow", "-AHTouchOnly"]
        app.launch()
        try enrollIfNeeded(app)

        let title = app.descendants(matching: .any)["inbox-project"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 20), "the Inbox's title menu")
        title.tap()
        let entry = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", space)).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 8), "\(space) in the Inbox's menu")
        entry.tap()
        return (app, space)
    }

    private func keep(_ app: XCUIApplication, _ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = environment["AH_TOUR_OUT"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(Int(app.windows.firstMatch.frame.width))pt.png"))
        }
    }

    /// A fresh install pairs with the demo host using the setup code it was given.
    private func enrollIfNeeded(_ app: XCUIApplication) throws {
        let address = app.textFields["hostAddress"]
        guard address.waitForExistence(timeout: 4) else { return }
        guard let origin = environment["AH_DEMO_ORIGIN"], let code = environment["AH_DEMO_CODE"] else {
            throw XCTSkip("Not paired: set TEST_RUNNER_AH_DEMO_ORIGIN and TEST_RUNNER_AH_DEMO_CODE.")
        }
        address.tap()
        address.typeText(origin)
        let field = app.textFields["setupCode"]
        field.tap()
        field.typeText(code)
        app.buttons["connectHost"].tap()
        XCTAssertTrue(address.waitForNonExistence(timeout: 20), "pairing with the demo host")
    }
}
