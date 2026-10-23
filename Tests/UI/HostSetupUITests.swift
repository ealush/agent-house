import XCTest

@MainActor
final class HostSetupUITests: XCTestCase {
    func testInvalidHostShowsValidationError() {
        let app = XCUIApplication()
        app.launch()
        let field = app.textFields["hostAddress"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        // This is also invalid when appended to a previously restored origin.
        field.typeText("http://example.com")
        let save = app.buttons["saveHostAddress"]
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: save)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 10), .completed)
        save.tap()
        XCTAssertTrue(app.descendants(matching: .any)["setupError"].waitForExistence(timeout: 5))
    }
}
