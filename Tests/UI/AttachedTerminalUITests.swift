import XCTest

/// A real companion shell, against the disposable transcript fixture. Skips without a host.
@MainActor
final class AttachedTerminalUITests: XCTestCase {
    func testSnippetOpensAnAttachedTerminalAndTheMenuReopensIt() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let origin = environment["AH_ATTACHED_ORIGIN"], let code = environment["AH_ATTACHED_CODE"] else {
            throw XCTSkip("Needs a disposable attached-terminal host and setup code.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["AH_EPHEMERAL"] = "1"
        app.launch()
        let address = app.textFields["hostAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        address.tap()
        address.typeText(origin)
        let setup = app.textFields["setupCode"]
        setup.tap()
        setup.typeText(code)
        app.buttons["connectHost"].tap()
        XCTAssertTrue(address.waitForNonExistence(timeout: 20))
        let session = app.staticTexts["Attached terminal demo"].firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 20))
        session.tap()
        let send = app.buttons["Send to terminal"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15))
        send.tap()
        let stop = app.buttons["Stop Terminal"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 15), "the companion shell opens in a panel")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "native-attached-terminal-iphone"
        shot.lifetime = .keepAlways
        add(shot)
        app.buttons["Close"].firstMatch.tap()
        app.buttons["Session menu"].tap()
        app.buttons["Terminal"].firstMatch.tap()
        XCTAssertTrue(stop.waitForExistence(timeout: 15), "the session menu reopens its companion shell")
    }
}
