import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The Inbox's interrupted cards (`web/InterruptedCard.tsx`): the host's `interruptions` and each
// History item's `interrupted`, read from a host with the feature, and from one before it.

private let withInterruptions = """
{"api":\(HubStateDTO.supportedAPIVersion),"hostname":"desk","windows":[],"features":{"interruptions":2},
 "interruptions":{"count":2,"midTurn":1,"incidents":[{"id":"tmux_server-100","cause":"tmux_server","at":1795800000,"count":2,"midTurn":1,"reviving":false}]},
 "history":[
  {"ref":"a1","kind":"ended","harness":"claude","harnessId":"c1","title":"Fix the login","cwd":"~/p","project":"p","model":null,"at":1795800000,"pinned":false,"worktree":null,"fork":null,
   "interrupted":{"cause":"tmux_server","at":1795800000,"lastSeenAt":1795799990,"incident":"tmux_server-100","lastStatus":"busy","midTurn":true,"failed":{"at":1795800030,"error":"claude: command not found"}}},
  {"ref":"b2","kind":"ended","harness":"codex","harnessId":"x2","title":"Write the docs","cwd":"~/p","project":"p","model":null,"at":1795800000,"pinned":false,"worktree":null,"fork":null,
   "interrupted":{"cause":"tmux_server","at":1795800000,"lastSeenAt":1795799990,"incident":"tmux_server-100","lastStatus":"idle","midTurn":false}}
 ]}
"""

@Test func interruptionsAndEachSessionsCutOffAreReadAndAnOlderHostHasNone() throws {
    let state = try JSONDecoder().decode(HubStateDTO.self, from: Data(withInterruptions.utf8))
    #expect(state.interruptions?.incidents.map(\.id) == ["tmux_server-100"])
    #expect(state.interruptions?.incidents.first?.reviving == false)
    #expect(state.history.first?.interrupted?.failed?.error == "claude: command not found")
    #expect(state.history.last?.interrupted?.midTurn == false)

    let older = try JSONDecoder().decode(HubStateDTO.self, from: Data("""
    {"api":\(HubStateDTO.supportedAPIVersion),"hostname":"desk","windows":[],"history":[{"ref":"a1","kind":"ended","harness":"claude","harnessId":"c1","title":"t","cwd":"~","project":"","model":null,"at":1,"pinned":false,"worktree":null,"fork":null}]}
    """.utf8))
    #expect(older.interruptions == nil)
    #expect(older.history.first?.interrupted == nil)
}

@Test func anIncidentSaysWhatCutItOffWhetherAhIsBringingItBackAndWhyOneDidntCome() throws {
    let state = try JSONDecoder().decode(HubStateDTO.self, from: Data(withInterruptions.utf8))
    let rows = state.history.map { HistoryRow(host: "desk", isLocal: true, dto: $0) }
    var incident = InterruptedIncident(incident: state.interruptions!.incidents[0], sessions: rows)
    #expect(incident.title == "2 sessions were interrupted")
    #expect(incident.line { _ in "3:38 PM" } == "The tmux server stopped at 3:38 PM; 1 was working.")
    #expect(incident.next.hasPrefix("Restoring resumes each in its own conversation, and tells the ones that were working"))
    #expect(incident.failures.map(\.title) == ["Fix the login"])
    #expect(incident.failures.first?.error == "claude: command not found")

    var reviving = state.interruptions!.incidents[0]
    reviving.reviving = true
    incident = InterruptedIncident(incident: reviving, sessions: rows)
    #expect(incident.next == "ah is bringing them back.")

    // One: its title, or, when its row isn't in History, still one.
    let one = InterruptionsStateDTO.Incident(id: "window-1", cause: "window", at: 1, count: 1)
    #expect(InterruptedIncident(incident: one, sessions: [rows[0]]).title == "\(rows[0].dto.title) was interrupted")
    #expect(InterruptedIncident(incident: one, sessions: []).title == "A session was interrupted")
}

@Test func theAlertsLinkToInterruptedOpensTheInbox() {
    // Auto-revive's alerts carry `/#interrupted`: the Inbox, where the cards are.
    if case .inbox = DeepLink(route: "/#interrupted", host: nil) {} else { Issue.record("not the Inbox") }
}
