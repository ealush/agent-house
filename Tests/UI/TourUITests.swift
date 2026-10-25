import XCTest

/// Walks the app against a demo host (scripts/demo/host.mjs) following a script of steps, and
/// keeps a screenshot for each `shot`. Skipped unless a tour is given:
///
///     TEST_RUNNER_AH_DEMO_ORIGIN=http://127.0.0.1:47681 TEST_RUNNER_AH_DEMO_CODE=<setup code>
///     TEST_RUNNER_AH_TOUR='shot:inbox;tap:Welcome flow;wait:2;shot:session' xcodebuild test …
///
/// Steps, separated by `;`:
///   shot:<name>           screenshot (kept in the result bundle as <name>)
///   tree:<name>           the accessibility hierarchy, as text
///   tap:<label or id>     the first hittable element with that label or identifier
///   tapat:<x>,<y>         a point, as fractions of the window
///   press:<label or id>   long press
///   pressat:<x>,<y>       long press at a point, as fractions of the window
///   type:<text>           into whatever has focus
///   key:<key>[+cmd+shift+alt+ctrl]  a hardware key (keys: return, escape, tab, up, down,
///                         left, right, delete, space, or one character)
///   swipe:<up|down|left|right>
///   drag:<label>><label>  press, hold and drag one element onto another
///   rotate:<landscape|portrait>
///   wait:<seconds>
///   relaunch              terminate and launch again
///
/// TEST_RUNNER_AH_TOUR_OUT=<folder on the Mac> also writes shots and trees there.
@MainActor
final class TourUITests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment

    func testTour() throws {
        let steps = (environment["AH_TOUR"] ?? "").split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !steps.isEmpty else { throw XCTSkip("No tour: set TEST_RUNNER_AH_TOUR (and a demo host).") }
        continueAfterFailure = true
        let app = XCUIApplication()
        // Every tour starts from a fresh window, not wherever the last one left off.
        app.launchArguments += ["-AHFreshWindow"]
        app.launch()
        try enrollIfNeeded(app)
        for step in steps {
            let (verb, argument) = split(step)
            switch verb {
            case "shot":
                let screenshot = XCUIScreen.main.screenshot()
                save(screenshot.pngRepresentation, argument + ".png")
                let shot = XCTAttachment(screenshot: screenshot)
                shot.name = argument
                shot.lifetime = .keepAlways
                add(shot)
            case "tree":
                save(Data(app.debugDescription.utf8), argument + ".txt")
                let tree = XCTAttachment(string: app.debugDescription)
                tree.name = argument
                tree.lifetime = .keepAlways
                add(tree)
            case "tap":
                element(app, argument)?.tap()
            case "tapat":
                let xy = argument.split(separator: ",").compactMap { Double($0) }
                app.coordinate(withNormalizedOffset: CGVector(dx: xy[0], dy: xy[1])).tap()
            case "press":
                element(app, argument)?.press(forDuration: 1.0)
            case "pressat":
                let xy = argument.split(separator: ",").compactMap { Double($0) }
                app.coordinate(withNormalizedOffset: CGVector(dx: xy[0], dy: xy[1])).press(forDuration: 1.0)
            case "type":
                app.typeText(argument)
            case "key":
                let parts = argument.split(separator: "+").map(String.init)
                var flags: XCUIElement.KeyModifierFlags = []
                for modifier in parts.dropFirst() {
                    switch modifier {
                    case "cmd": flags.insert(.command)
                    case "shift": flags.insert(.shift)
                    case "alt": flags.insert(.option)
                    case "ctrl": flags.insert(.control)
                    default: break
                    }
                }
                app.typeKey(key(parts.first ?? ""), modifierFlags: flags)
            case "swipe":
                switch argument {
                case "up": app.swipeUp()
                case "down": app.swipeDown()
                case "left": app.swipeLeft()
                default: app.swipeRight()
                }
            case "drag":
                let ends = argument.split(separator: ">").map(String.init)
                if ends.count == 2, let from = element(app, ends[0]), let to = element(app, ends[1]) {
                    from.press(forDuration: 0.8, thenDragTo: to)
                }
            case "rotate":
                XCUIDevice.shared.orientation = argument == "portrait" ? .portrait : .landscapeLeft
            case "wait":
                Thread.sleep(forTimeInterval: Double(argument) ?? 1)
            case "relaunch":
                app.terminate()
                app.launch()
            default:
                XCTFail("Unknown tour step \(step)")
            }
        }
    }

    /// With AH_TOUR_OUT (a folder on the Mac running the simulator), also writes each file there.
    private func save(_ data: Data, _ name: String) {
        guard let folder = environment["AH_TOUR_OUT"] else { return }
        try? data.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name))
    }

    private func split(_ step: String) -> (String, String) {
        guard let colon = step.firstIndex(of: ":") else { return (step, "") }
        return (String(step[..<colon]), String(step[step.index(after: colon)...]))
    }

    /// The first element whose identifier or label matches, preferring hittable ones.
    private func element(_ app: XCUIApplication, _ name: String) -> XCUIElement? {
        let query = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@", name, name))
        let deadline = Date().addingTimeInterval(5)
        repeat {
            let all = query.allElementsBoundByIndex
            if let hit = all.first(where: { $0.exists && $0.isHittable }) { return hit }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        XCTFail("No hittable element named \(name)")
        return nil
    }

    private func key(_ name: String) -> String {
        switch name {
        case "return": return XCUIKeyboardKey.return.rawValue
        case "escape": return XCUIKeyboardKey.escape.rawValue
        case "tab": return XCUIKeyboardKey.tab.rawValue
        case "up": return XCUIKeyboardKey.upArrow.rawValue
        case "down": return XCUIKeyboardKey.downArrow.rawValue
        case "left": return XCUIKeyboardKey.leftArrow.rawValue
        case "right": return XCUIKeyboardKey.rightArrow.rawValue
        case "delete": return XCUIKeyboardKey.delete.rawValue
        case "space": return XCUIKeyboardKey.space.rawValue
        default: return name
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
