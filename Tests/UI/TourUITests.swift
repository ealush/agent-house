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
///   type:<text>           into whatever has focus (`\n` presses Return)
///   erase:<label or id>   delete everything in a focused text field, by the on-screen keyboard
///   key:<key>[+cmd+shift+alt+ctrl]  a hardware key (keys: return, escape, tab, up, down,
///                         left, right, delete, space, or one character)
///   swipe:<up|down|left|right>
///   drag:<label>><label>  press, hold and drag one element onto another
///   dragat:<x>,<y>><x>,<y>  drag from one point to another, as fractions of the window
///   pressdragat:<x>,<y>><x>,<y>  press and hold, then drag on to another point (selecting text)
///   pressdragin:<label>@<x>,<y>><x>,<y>  the same inside an element, as fractions of its frame
///   rotate:<landscape|portrait>
///   wait:<seconds>
///   relaunch              terminate and launch again
///   home                  go to the Home Screen
///   activate              bring the app back to the front
///   sb-tap:<label>        tap on the Home Screen, Spotlight or a notification (SpringBoard)
///   sb-press:<label>      long press there (an app icon's quick actions, a notification)
///   spotlight             open Spotlight from the Home Screen
///   notifications         pull down Notification Center
///   sb-type:<text>        type into SpringBoard (Spotlight's field, a notification's reply)
///   sb-wait:<text>        wait up to two minutes for SpringBoard to show something containing it
///   open-app:<bundle id>  bring another app forward; tap, press, type and tree act on it
///   use-app               back to Agent Hub as the app the steps act on
///
/// TEST_RUNNER_AH_TOUR_OUT=<folder on the Mac> also writes shots and trees there.
@MainActor
final class TourUITests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func testTour() throws {
        let steps = (environment["AH_TOUR"] ?? "").split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !steps.isEmpty else { throw XCTSkip("No tour: set TEST_RUNNER_AH_TOUR (and a demo host).") }
        continueAfterFailure = true
        let app = XCUIApplication()
        // Every tour starts from a fresh window, not wherever the last one left off.
        app.launchArguments += ["-AHFreshWindow"]
        // As a phone in the hand: no hardware keyboard, whatever the simulator has.
        if environment["AH_TOUCH_ONLY"] == "1" { app.launchArguments += ["-AHTouchOnly"] }
        app.launch()
        try enrollIfNeeded(app)
        var target = app
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
                save(Data(target.debugDescription.utf8), argument + ".txt")
                let tree = XCTAttachment(string: target.debugDescription)
                tree.name = argument
                tree.lifetime = .keepAlways
                add(tree)
            case "tap":
                element(target, argument)?.tap()
            case "tapat":
                let xy = argument.split(separator: ",").compactMap { Double($0) }
                app.coordinate(withNormalizedOffset: CGVector(dx: xy[0], dy: xy[1])).tap()
            case "press":
                element(target, argument)?.press(forDuration: 1.0)
            case "pressat":
                let xy = argument.split(separator: ",").compactMap { Double($0) }
                app.coordinate(withNormalizedOffset: CGVector(dx: xy[0], dy: xy[1])).press(forDuration: 1.0)
            case "type":
                // `\n` is Return on the on-screen keyboard.
                target.typeText(argument.replacingOccurrences(of: "\\n", with: "\n"))
            case "erase":
                // The on-screen keyboard's Delete, until the field holds nothing (a draft the
                // host kept from an earlier tour).
                // By identifier, hittable or not: a grown composer under the keyboard isn't.
                let field = app.descendants(matching: .any).matching(identifier: argument).firstMatch
                if field.exists {
                    for _ in 0..<8 {
                        let left = (field.value as? String) ?? ""
                        if left.isEmpty || left == field.placeholderValue { break }
                        target.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: min(left.count + 4, 400)))
                    }
                }
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
            case "swipein":
                // `swipein:left@~Welcome`: a flick across that element (a row's swipe actions).
                let parts = argument.split(separator: "@", maxSplits: 1).map(String.init)
                if parts.count == 2, let inside = element(app, parts[1]) {
                    switch parts[0] {
                    case "left": inside.swipeLeft()
                    case "up": inside.swipeUp()
                    case "down": inside.swipeDown()
                    default: inside.swipeRight()
                    }
                }
            case "drag":
                let ends = argument.split(separator: ">").map(String.init)
                if ends.count == 2, let from = element(app, ends[0]), let to = element(app, ends[1]) {
                    from.press(forDuration: 0.8, thenDragTo: to)
                }
            case "dragat":
                // A plain drag between two points, as fractions of the window (scrolls, dismisses).
                let ends = argument.split(separator: ">").map { $0.split(separator: ",").compactMap { Double($0) } }
                if ends.count == 2, ends.allSatisfy({ $0.count == 2 }) {
                    let at = { (p: [Double]) in target.coordinate(withNormalizedOffset: CGVector(dx: p[0], dy: p[1])) }
                    at(ends[0]).press(forDuration: 0.05, thenDragTo: at(ends[1]))
                }
            case "pressdragat":
                // A finger held still long enough to pick a word, then dragged slowly on.
                let ends = argument.split(separator: ">").map { $0.split(separator: ",").compactMap { Double($0) } }
                if ends.count == 2, ends.allSatisfy({ $0.count == 2 }) {
                    let at = { (p: [Double]) in target.coordinate(withNormalizedOffset: CGVector(dx: p[0], dy: p[1])) }
                    at(ends[0]).press(forDuration: 0.8, thenDragTo: at(ends[1]), withVelocity: .slow, thenHoldForDuration: 0.3)
                }
            case "pressdragin":
                let parts = argument.split(separator: "@", maxSplits: 1).map(String.init)
                let ends = (parts.last ?? "").split(separator: ">").map { $0.split(separator: ",").compactMap { Double($0) } }
                if parts.count == 2, ends.count == 2, ends.allSatisfy({ $0.count == 2 }), let inside = element(app, parts[0]) {
                    let at = { (p: [Double]) in inside.coordinate(withNormalizedOffset: CGVector(dx: p[0], dy: p[1])) }
                    at(ends[0]).press(forDuration: 0.8, thenDragTo: at(ends[1]), withVelocity: .slow, thenHoldForDuration: 0.3)
                }
            case "flickat":
                // A finger's flick: no hold before it moves, and fast (a held drag reads as a
                // press, which a text view answers with its caret and edit menu).
                let ends = argument.split(separator: ">").map { $0.split(separator: ",").compactMap { Double($0) } }
                if ends.count == 2, ends.allSatisfy({ $0.count == 2 }) {
                    let at = { (p: [Double]) in target.coordinate(withNormalizedOffset: CGVector(dx: p[0], dy: p[1])) }
                    at(ends[0]).press(forDuration: 0, thenDragTo: at(ends[1]), withVelocity: .fast, thenHoldForDuration: 0)
                }
            case "rotate":
                XCUIDevice.shared.orientation = argument == "portrait" ? .portrait : .landscapeLeft
            case "wait":
                Thread.sleep(forTimeInterval: Double(argument) ?? 1)
            case "relaunch":
                app.terminate()
                app.launch()
            case "terminate":
                app.terminate()
            case "url":
                // A link opened from outside (agenthub: or a host's web link), as the system hands it over.
                if let url = URL(string: argument) { app.open(url) }
            case "home":
                XCUIDevice.shared.press(.home)
            case "activate":
                app.activate()
            case "open-app":
                target = XCUIApplication(bundleIdentifier: argument)
                target.activate()
            case "use-app":
                target = app
                app.activate()
            case "sb-tap":
                element(springboard, argument)?.tap()
            case "sb-press":
                element(springboard, argument)?.press(forDuration: 1.2)
            case "sb-wait":
                let shown = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", argument)).firstMatch
                XCTAssertTrue(shown.waitForExistence(timeout: 120), "SpringBoard never showed \(argument)")
            case "sb-type":
                springboard.typeText(argument)
            case "spotlight":
                springboard.swipeDown()
            case "notifications":
                let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.005))
                top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.7)))
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
        if name.hasPrefix("~") {
            // `~text`: the first hittable element whose label contains it (a notification's text).
            let query = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", String(name.dropFirst())))
            let deadline = Date().addingTimeInterval(8)
            repeat {
                if let hit = query.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable }) { return hit }
                Thread.sleep(forTimeInterval: 0.25)
            } while Date() < deadline
            XCTFail("No hittable element containing \(name.dropFirst())")
            return nil
        }
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
