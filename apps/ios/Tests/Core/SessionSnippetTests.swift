import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The line under a session's title in the lists (`SessionSnippet`).
private func row(_ status: String, reply: [String: Any]? = nil, detail: String? = nil, limit: String? = nil, ask: [String: Any]? = nil) throws -> SessionDTO {
    var object: [String: Any] = ["id": "@1", "uid": "u1", "name": "claude", "title": "Users latency", "statusSource": "hook", "project": "orbit-api", "projectPath": "/p/orbit-api", "status": status, "command": "claude", "agent": "claude"]
    if let reply { object["reply"] = reply }
    if let detail { object["detail"] = detail }
    if let limit { object["limit"] = limit }
    if let ask { object["ask"] = ask }
    return try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test func aSessionsLineIsItsLastMessageNotItsLastTool() throws {
    let reply: [String: Any] = ["role": "assistant", "text": "Back to two queries and p95 176 ms.", "at": 1]
    #expect(SessionSnippet.line(try row("idle", reply: reply, detail: "$ git push -q mac origin/main")) == "Back to two queries and p95 176 ms.")
    #expect(SessionSnippet.line(try row("busy", reply: ["role": "user", "text": "check the p95 numbers", "at": 2], detail: "Reading users.ts")) == "You: check the p95 numbers", "working on your message")
    #expect(SessionSnippet.line(try row("waiting", reply: reply, ask: ["kind": "command", "text": "Bash command\n./keys/rotate.sh"])) == "Wants to run ./keys/rotate.sh", "what it asks comes first")
    #expect(SessionSnippet.line(try row("attention", reply: reply, limit: "Session limit · resets 12am")) == "Session limit · resets 12am")
    // A host that predates last messages: what it's doing while it works, nothing once it's done.
    #expect(SessionSnippet.line(try row("busy", detail: "Reading users.ts")) == "Reading users.ts")
    #expect(SessionSnippet.line(try row("idle", detail: "$ git push -q mac origin/main")) == nil)
    #expect(try row("idle", reply: ["role": 7]).reply == nil, "a reply it can't read is left out, not the session")
    // A reply whose first line leads into a list trails off in the row, not on a colon.
    #expect(SessionSnippet.line(try row("idle", reply: ["role": "assistant", "text": "Two findings worth fixing first:", "at": 3])) == "Two findings worth fixing first…")
    #expect(SessionSnippet.ending("Ratio 3:2") == "Ratio 3:2", "a colon inside the line stays")
}
