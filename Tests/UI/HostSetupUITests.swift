import XCTest

/// Pairing on a fresh install. Needs no host: an address that isn't a valid tailnet HTTPS
/// origin is refused before anything leaves the device.
@MainActor
final class HostSetupUITests: XCTestCase {
    func testPlainHTTPAddressIsRefusedBeforeEnrolling() {
        let app = XCUIApplication()
        app.launch()
        let address = app.textFields["hostAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 10), "a fresh install opens on pairing")
        address.tap()
        address.typeText("http://example.com")
        let code = app.textFields["setupCode"]
        code.tap()
        code.typeText("ABCD-EFGH")
        let connect = app.buttons["connectHost"]
        XCTAssertTrue(connect.isEnabled)
        connect.tap()
        XCTAssertTrue(app.descendants(matching: .any)["setupError"].waitForExistence(timeout: 5))
    }

    func testConnectNeedsAnAddressAndACode() {
        let app = XCUIApplication()
        app.launch()
        let connect = app.buttons["connectHost"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        XCTAssertFalse(connect.isEnabled)
    }
}
