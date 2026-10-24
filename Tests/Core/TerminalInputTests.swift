import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func terminalMessagesMatchTheServerWireContract() throws {
    let input = try JSONSerialization.jsonObject(with: JSONEncoder().encode(TerminalInput.input("hi\r"))) as? [String: String]
    #expect(input == ["t": "i", "d": "hi\r"])
    let resize = try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(TerminalInput.resize(columns: 120, rows: 40))
    ) as? [String: Any]
    #expect(resize?["t"] as? String == "r")
    #expect(resize?["c"] as? Int == 120)
    #expect(resize?["r"] as? Int == 40)
    let scroll = try JSONSerialization.jsonObject(
        with: JSONEncoder().encode(TerminalInput.scroll(lines: 900, column: nil, row: nil))
    ) as? [String: Any]
    #expect(scroll?["n"] as? Int == 500)
    #expect(scroll?["c"] == nil)
    #expect(scroll?["r"] == nil)
}


@Test func theKeyRowShowsWithoutAKeyboardUnlessChosenOtherwise() throws {
    var preferences = DevicePreferences()
    #expect(preferences.showsKeyBar(hardwareKeyboard: false))
    #expect(!preferences.showsKeyBar(hardwareKeyboard: true))
    preferences.keyBar = .on
    #expect(preferences.showsKeyBar(hardwareKeyboard: true))
    preferences.keyBar = .off
    #expect(!preferences.showsKeyBar(hardwareKeyboard: false))
    // The old switch: off stays off, on becomes "without a keyboard".
    let off = try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"keyBarVisible": false}"#.utf8))
    #expect(off.keyBar == .off)
    let on = try JSONDecoder().decode(DevicePreferences.self, from: Data(#"{"keyBarVisible": true}"#.utf8))
    #expect(on.keyBar == .auto)
}
