import XCTest

/// Pairing on a fresh install. Needs no host: an address that isn't a valid tailnet HTTPS
/// origin is refused before anything leaves the device. Each launch is ephemeral (debug
/// builds), so a simulator that was paired before still opens on pairing.
@MainActor
final class HostSetupUITests: XCTestCase {
    func testPlainHTTPAddressIsRefusedBeforeEnrolling() {
        let app = XCUIApplication()
        app.launchEnvironment["AH_EPHEMERAL"] = "1"
        app.launch()
        let address = app.textFields["hostAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 10), "a fresh install opens on pairing")
        address.tap()
        address.typeText("http://example.com")
        let code = app.textFields["setupCode"]
        code.tap()
        code.typeText("ABCD-EFGH")
        // A form lays out only the rows on screen, and with the keyboard up Connect is below it.
        let connect = app.buttons["connectHost"]
        for _ in 0..<4 {
            if connect.exists { break }
            app.swipeUp()
        }
        XCTAssertTrue(connect.exists, "Connect is there once scrolled to")
        XCTAssertTrue(connect.isEnabled)
        connect.tap()
        XCTAssertTrue(app.descendants(matching: .any)["setupError"].waitForExistence(timeout: 5))
    }

    func testConnectNeedsAnAddressAndACode() {
        let app = XCUIApplication()
        app.launchEnvironment["AH_EPHEMERAL"] = "1"
        app.launch()
        let connect = app.buttons["connectHost"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        XCTAssertFalse(connect.isEnabled)
    }
}
