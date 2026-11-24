import XCTest

/// The Space Portal's header at the device's width (TestFlight #104 squeezed it on an iPhone: an
/// empty Start Chief capsule, a kind chip wrapped in two, the path cut to "~/co…house"). Against
/// a demo host (scripts/demo/host.mjs) with a Space that has a long folder and no Chief:
///
///     TEST_RUNNER_AH_DEMO_ORIGIN=http://127.0.0.1:47681 TEST_RUNNER_AH_DEMO_CODE=<setup code> \
///     TEST_RUNNER_AH_PORTAL_SPACE='<the Space’s name>' xcodebuild test … \
///     -only-testing:AgentHubNativeUITests/SpacePortalHeaderUITests
///
/// It asserts geometry: the path on one line, the glyph buttons whole, inside the window and
/// clear of the path and of each other, and the Chief of Staff card's button with room for its
/// words. TEST_RUNNER_AH_TOUR_OUT=<folder on the Mac> also keeps the screenshot there.
@MainActor
final class SpacePortalHeaderUITests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment

    func testHeaderFitsTheWidth() throws {
        guard let space = environment["AH_PORTAL_SPACE"], !space.isEmpty else {
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
        XCTAssertTrue(app.descendants(matching: .any)["space-portal-tabs"].firstMatch.waitForExistence(timeout: 10), "the portal of \(space)")

        let window = app.windows.firstMatch.frame
        let path = app.descendants(matching: .any)["space-portal-path"].firstMatch
        XCTAssertTrue(path.waitForExistence(timeout: 5), "the Space's folder")
        XCTAssertLessThan(path.frame.height, 30, "the folder on one line")
        XCTAssertGreaterThan(path.frame.width, window.width * 0.4, "the folder takes the room left, not a sliver")

        let tools = ["space-context-button", "space-new-note", "space-settings-button"].map { app.buttons[$0].firstMatch }
        for tool in tools {
            XCTAssertTrue(tool.waitForExistence(timeout: 5), "\(tool.identifier)")
            XCTAssertTrue(tool.isHittable, "\(tool.identifier) can be tapped")
            XCTAssertGreaterThanOrEqual(tool.frame.width, 24, "\(tool.identifier) keeps its size")
            XCTAssertTrue(window.contains(tool.frame), "\(tool.identifier) inside the window")
            XCTAssertFalse(tool.frame.intersects(path.frame), "\(tool.identifier) clear of the folder")
        }
        for (i, a) in tools.enumerated() {
            for b in tools[(i + 1)...] { XCTAssertFalse(a.frame.intersects(b.frame), "\(a.identifier) and \(b.identifier) apart") }
        }

        // No Chief yet: the card starts one, with its words showing; the header has no button for it.
        let start = app.buttons["space-chief-banner-start"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 5), "the Chief of Staff card")
        XCTAssertGreaterThan(start.frame.width, 120, "Start Chief of Staff has room for its words")
        XCTAssertFalse(app.buttons["space-start-chief"].exists, "no second Start Chief in the header")

        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "space-portal-header"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = environment["AH_TOUR_OUT"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("space-portal-header-\(Int(window.width))pt.png"))
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
