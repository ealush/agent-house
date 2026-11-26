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

    /// Someone who just installed the app has nothing to connect to yet: pairing says where to
    /// get a host, on the first screen, without scrolling.
    func testFreshInstallPointsAtTheInstallGuide() {
        let app = XCUIApplication()
        app.launchEnvironment["AH_EPHEMERAL"] = "1"
        app.launch()
        let guide = app.descendants(matching: .any)["installGuide"]
        XCTAssertTrue(guide.waitForExistence(timeout: 10))
        XCTAssertTrue(guide.isHittable, "the link is on screen as pairing opens")
        XCTAssertTrue(guide.label.contains("Set one up"), guide.label)
    }

    func testConnectNeedsAnAddressAndACode() {
        let app = XCUIApplication()
        app.launchEnvironment["AH_EPHEMERAL"] = "1"
        app.launch()
        XCTAssertTrue(app.textFields["hostAddress"].waitForExistence(timeout: 10))
        // Below the keyboard on a phone, as in the test above: scrolled to.
        let connect = app.buttons["connectHost"]
        for _ in 0..<4 {
            if connect.exists { break }
            app.swipeUp()
        }
        XCTAssertTrue(connect.exists)
        XCTAssertFalse(connect.isEnabled)
    }
}
