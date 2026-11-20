import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

private func dto(_ status: String, detail: String? = nil, ask: [String: Any]? = nil, answerable: Bool = false, limit: String? = nil, askId: String? = nil, queued: Int = 0, reply: (role: String, text: String)? = nil) throws -> SessionDTO {
    var object: [String: Any] = ["id": "@1", "uid": "u1", "name": "keys", "title": "Rotate keys", "statusSource": "hook", "project": "infra", "projectPath": "/p/infra", "status": status, "command": "claude", "agent": "claude", "answerable": answerable, "queued": queued]
    if let askId { object["askId"] = askId }
    if let detail { object["detail"] = detail }
    if let ask { object["ask"] = ask }
    if let limit { object["limit"] = limit }
    if let reply { object["reply"] = ["role": reply.role, "text": reply.text, "at": 5] }
    return try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test func aSessionsLiveActivitySaysWhatItsDoingAsksOrHit() throws {
    let working = SessionActivityRules.state(of: try dto("busy", detail: "Editing keys.ts\nmore"), since: 9, privatePreview: false)
    #expect(working == .init(phase: .working, detail: "Editing keys.ts", answerable: false, since: 9))
    let asks = SessionActivityRules.state(of: try dto("waiting", ask: ["kind": "command", "text": "Bash command\n./rotate.sh"], answerable: true), since: 9, privatePreview: false)
    #expect(asks == .init(phase: .waiting, detail: "Wants to run ./rotate.sh", answerable: true, since: 9))
    #expect(SessionActivityRules.state(of: try dto("attention", limit: "Session limit · resets 12am"), since: 9, privatePreview: false).phase == .limited)
    #expect(SessionActivityRules.state(of: try dto("idle"), since: 9, privatePreview: false) == .init(phase: .finished, detail: nil, answerable: false, since: 9))
    #expect(SessionActivityRules.state(of: try dto("busy", detail: "Editing keys.ts"), since: 9, privatePreview: true).detail == nil, "a private preview says nothing about it")
    #expect(SessionActivityRules.line(String(repeating: "x", count: 300))?.count == 120)
}

@Test func aSessionsLiveActivitySaysWhatWasSaidLastNotTheToolItRuns() throws {
    let said = (role: "assistant", text: "Merging #161 now,\nthen   TestFlight.")
    let working = SessionActivityRules.state(of: try dto("busy", detail: "$ gh pr merge 161 --merge", reply: said), since: 9, privatePreview: false)
    #expect(working.detail == "Merging #161 now, then TestFlight.", "the agent's words, on one line, not its command")
    let yours = SessionActivityRules.state(of: try dto("busy", detail: "$ ls", reply: (role: "user", text: "Push to main")), since: 9, privatePreview: false)
    #expect(yours.detail == "You: Push to main", "working on your message, not answered yet")
    let done = SessionActivityRules.state(of: try dto("attention", reply: said), since: 9, privatePreview: false)
    #expect(done == .init(phase: .finished, detail: "Merging #161 now, then TestFlight.", answerable: false, since: 9), "finished: its answer")
    #expect(SessionActivityRules.state(of: try dto("idle", reply: (role: "user", text: "hi")), since: 9, privatePreview: false).detail == nil, "finished on your words: nothing to show")
    let asks = SessionActivityRules.state(of: try dto("waiting", ask: ["kind": "command", "text": "Bash command\n./rotate.sh"], answerable: true, reply: said), since: 9, privatePreview: false)
    #expect(asks.detail == "Wants to run ./rotate.sh", "a question still says what it asks")
    #expect(SessionActivityRules.state(of: try dto("busy", detail: "$ ls", reply: said), since: 9, privatePreview: true).detail == nil, "a private preview says nothing about it")
    #expect(SessionActivityRules.lastSaid(.init(role: "assistant", text: String(repeating: "x", count: 300), at: 1))?.count == 120)
}

@Test func aSessionsLiveActivityFollowsItFromStartingToFinished() throws {
    var follow = SessionActivityRules.Follow(began: 100, shown: SessionActivityRules.starting(at: 100))
    #expect(follow.shown?.phase == .starting, "sent, not yet seen at work")
    #expect(SessionActivityRules.step(&follow, dto: try dto("attention"), now: 101, privatePreview: false) == .wait, "the message hasn't reached it yet: nothing ends it")
    #expect(SessionActivityRules.step(&follow, dto: try dto("busy", detail: "Reading", queued: 2), now: 102, privatePreview: false) == .update(.init(phase: .working, detail: "Reading", answerable: false, since: 100, queued: 2)), "starting hands its clock to working; the queue is counted")
    #expect(SessionActivityRules.step(&follow, dto: try dto("busy", detail: "Reading", queued: 2), now: 103, privatePreview: false) == .wait, "nothing new")
    let asked = SessionActivityRules.step(&follow, dto: try dto("waiting", ask: ["kind": "command", "text": "Bash command\n./rotate.sh"], answerable: true, askId: "p1"), now: 140, privatePreview: false)
    #expect(asked == .update(.init(phase: .waiting, detail: "Wants to run ./rotate.sh", answerable: true, since: 140, prompt: "p1")), "needing you starts its own clock and carries the prompt its buttons answer")
    #expect(SessionActivityRules.step(&follow, dto: try dto("busy"), now: 150, privatePreview: false) == .update(.init(phase: .working, detail: nil, answerable: false, since: 150)))
    #expect(SessionActivityRules.step(&follow, dto: try dto("attention"), now: 200, privatePreview: false) == .end(.init(phase: .finished, detail: nil, answerable: false, since: 200)))
}

@Test func aSessionThatGoesAwayMidTurnDidntFinish() throws {
    var working = SessionActivityRules.Follow(began: 100, started: true, shown: .init(phase: .working, detail: nil, answerable: false, since: 100))
    #expect(SessionActivityRules.step(&working, dto: nil, now: 120, privatePreview: false) == .end(.init(phase: .failed, detail: nil, answerable: false, since: 120)), "ended or killed with work in hand")
    var done = SessionActivityRules.Follow(began: 100, started: true, shown: .init(phase: .finished, detail: nil, answerable: false, since: 110))
    #expect(SessionActivityRules.step(&done, dto: nil, now: 120, privatePreview: false) == .end(.init(phase: .finished, detail: nil, answerable: false, since: 120)), "closed after it finished: finished")
    #expect(SessionActivityState(phase: .failed, detail: nil, answerable: false, since: 1).isOver)
}

@Test func aFewLiveActivitiesAtOnceTheOneLongestWithoutNewsGivesWay() {
    #expect(SessionActivityRules.evict([("a", 10, false), ("b", 20, false)]) == nil, "room for one more")
    #expect(SessionActivityRules.evict([("a", 10, false), ("b", 20, true), ("c", 30, false)]) == "b", "a finished one first")
    #expect(SessionActivityRules.evict([("a", 30, false), ("b", 10, false), ("c", 20, false)]) == "b", "else the oldest")
}

@Test func aPhaseFromANewerHostIsShownAsUnknownNeverGuessed() throws {
    let state = try JSONDecoder().decode(SessionActivityState.self, from: Data(#"{"phase":"migrating","detail":"x","answerable":true,"since":5}"#.utf8))
    #expect(state.phase == .unknown)
    #expect(!state.isOver)
    let failed = try JSONDecoder().decode(SessionActivityState.self, from: Data(#"{"phase":"failed","detail":null,"answerable":false,"since":5}"#.utf8))
    #expect(failed.phase == .failed && failed.isOver)
}

@Test func anOutOfDateLiveActivityStopsItsClockRatherThanCountingOn() {
    let working = SessionActivityState(phase: .working, detail: nil, answerable: false, since: 5)
    #expect(working.shownPhase(stale: false) == .working)
    #expect(working.shownPhase(stale: true) == .unknown, "nothing moved it: not known, never still at it")
    let waiting = SessionActivityState(phase: .waiting, detail: nil, answerable: true, since: 5)
    #expect(waiting.shownPhase(stale: true) == .unknown)
    let finished = SessionActivityState(phase: .finished, detail: nil, answerable: false, since: 5)
    #expect(finished.shownPhase(stale: true) == .finished, "where it ended up stays true")
}

@Test func theAppKeepsAQuietTurnFromGoingOutOfDateWhileItRuns() {
    #expect(!SessionActivityRules.looksAgain(staleAt: 700, now: 200, staleAfter: 600), "just shown")
    #expect(SessionActivityRules.looksAgain(staleAt: 700, now: 450, staleAfter: 600), "half its time gone")
    #expect(SessionActivityRules.looksAgain(staleAt: 700, now: 900, staleAfter: 600), "out of date already (back from the background)")
    #expect(SessionActivityRules.looksAgain(staleAt: nil, now: 0, staleAfter: 600), "picked up from before: not known")
}

@Test func aLiveActivityForATurnTooQuickToSeeEndsAfterAMinute() throws {
    var follow = SessionActivityRules.Follow(began: 100)
    #expect(SessionActivityRules.step(&follow, dto: try dto("attention"), now: 150, privatePreview: false) == .wait)
    #expect(SessionActivityRules.step(&follow, dto: try dto("attention"), now: 161, privatePreview: false) == .end(.init(phase: .finished, detail: nil, answerable: false, since: 161)))
    var never = SessionActivityRules.Follow(began: 100, shown: SessionActivityRules.starting(at: 100))
    #expect(SessionActivityRules.step(&never, dto: nil, now: 120, privatePreview: false) == .wait, "not there yet: give it the minute")
    #expect(SessionActivityRules.step(&never, dto: nil, now: 161, privatePreview: false) == .end(.init(phase: .failed, detail: nil, answerable: false, since: 161)), "never seen at work and gone: it didn't happen")
}

@Test func theHostsLiveActivityPushDecodesAsTheAppsOwnState() throws {
    // `aps.content-state` as server/apns.ts sends it.
    let pushed = #"{"phase":"waiting","detail":"Wants to run pnpm test","answerable":true,"since":1763112000}"#
    let state = try JSONDecoder().decode(SessionActivityState.self, from: Data(pushed.utf8))
    #expect(state == .init(phase: .waiting, detail: "Wants to run pnpm test", answerable: true, since: 1_763_112_000))
    let quiet = try JSONDecoder().decode(SessionActivityState.self, from: Data(#"{"phase":"finished","detail":null,"answerable":false,"since":1}"#.utf8))
    #expect(quiet.isOver && quiet.detail == nil)
}

@Test func notificationPreferencesSavedBeforeLiveActivitiesKeepTheirValues() throws {
    let saved = #"{"enabled":true,"needsYou":false,"finished":true,"privatePreview":true}"#
    let prefs = try JSONDecoder().decode(DevicePreferences.Notifications.self, from: Data(saved.utf8))
    #expect(prefs.enabled && !prefs.needsYou && prefs.finished && prefs.privatePreview)
    #expect(prefs.liveActivities, "on unless turned off")
}
