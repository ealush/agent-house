import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Portable tests for Space Portal logic, unidirectional supervision DTOs, and Fleet API coding.

private func makeSessionRow(
    uid: String,
    title: String,
    host: String = "hub",
    project: String = "Launch",
    space: String? = nil,
    projectPath: String = "/home/user/spaces/Launch",
    status: SessionDTO.Status = .idle,
    supervision: SupervisionDTO? = nil,
    activity: Int = 0
) throws -> SessionRow {
    var obj: [String: Any] = [
        "id": "@\(uid)",
        "uid": uid,
        "name": title,
        "title": title,
        "statusSource": "activity",
        "project": project,
        "projectPath": projectPath,
        "status": status.rawValue,
        "activity": activity,
    ]
    if let space { obj["space"] = space }
    if let supervision {
        let supData = try JSONEncoder().encode(supervision)
        obj["supervision"] = try JSONSerialization.jsonObject(with: supData)
    }
    let data = try JSONSerialization.data(withJSONObject: obj)
    let dto = try JSONDecoder().decode(SessionDTO.self, from: data)
    return SessionRow(key: uid, host: host, isLocal: true, dto: dto)
}

@Test func sessionDTODecodesSupervisionSpaceAndBusySinceAndStaysBackwardsCompatible() throws {
    let modernJSON = Data("""
    {
      "id": "@1",
      "uid": "u-chief",
      "name": "Launch Chief",
      "statusSource": "hook",
      "project": "api-repo",
      "space": "Launch",
      "projectPath": "/home/user/code/api-repo",
      "status": "busy",
      "busySince": 1730000123,
      "supervision": {
        "role": "chief",
        "space": "Launch",
        "muteAlerts": false,
        "escalateAfterSeconds": 300,
        "tags": ["space-chief"]
      }
    }
    """.utf8)
    let modern = try JSONDecoder().decode(SessionDTO.self, from: modernJSON)
    #expect(modern.busySince == 1730000123)
    #expect(modern.space == "Launch")
    #expect(modern.supervision?.role == .chief)
    #expect(modern.supervision?.space == "Launch")
    #expect(modern.supervision?.escalateAfterSeconds == 300)
    #expect(modern.supervision?.tags == ["space-chief"])

    let legacyJSON = Data("""
    {
      "id": "@2",
      "uid": "u-old",
      "name": "Legacy",
      "statusSource": "activity",
      "project": "Launch",
      "projectPath": "/home/user/spaces/Launch",
      "status": "idle"
    }
    """.utf8)
    let legacy = try JSONDecoder().decode(SessionDTO.self, from: legacyJSON)
    #expect(legacy.busySince == nil)
    #expect(legacy.space == nil)
    #expect(legacy.supervision == nil)
}

@Test func supervisionPatchEncodesSetClearAndKeepProperly() throws {
    let patch = SupervisionPatch(role: .set(.worker), managedBy: .clear, space: .keep)
    let data = try JSONEncoder().encode(patch)
    let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(json["role"] as? String == "worker")
    #expect(json["managedBy"] is NSNull)
    #expect(json.keys.contains("space") == false)
}

@Test func newSessionRequestEncodesOptionalSpaceAndSupervision() throws {
    let req = NewSessionRequest(
        preset: "claude",
        cwd: "/home/user/code/api-repo",
        session: "ah",
        label: "Launch Chief",
        worktree: false,
        space: "Launch",
        supervision: SupervisionDTO(role: .chief, space: "Launch")
    )
    let data = try JSONEncoder().encode(req)
    let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(json["space"] as? String == "Launch")
    let sup = try #require(json["supervision"] as? [String: Any])
    #expect(sup["role"] as? String == "chief")
    #expect(sup["space"] as? String == "Launch")
}

@Test func fleetTaskAndMailDTOsDecodeRealWireShape() throws {
    let tasksJSON = Data("""
    {
      "tasks": [{
        "id": "tk-0000abcd",
        "title": "Draft launch memo",
        "description": "Save under artifacts/launch.md",
        "status": "in_review",
        "priority": 0,
        "ownerUid": "u-chief",
        "assignedUid": "u-worker",
        "space": "Launch",
        "dependsOn": [],
        "verifyCmd": "npm test",
        "lastVerify": {
          "at": 1730000009,
          "command": "npm test",
          "exitCode": 0,
          "ok": true,
          "output": "ok"
        },
        "result": "Ready for review",
        "createdAt": 1730000000,
        "updatedAt": 1730000010
      }]
    }
    """.utf8)
    let taskList = try JSONDecoder().decode(FleetTasksResponseDTO.self, from: tasksJSON)
    let task = try #require(taskList.tasks.first)
    #expect(task.id == "tk-0000abcd")
    #expect(task.status == .inReview)
    #expect(task.priority == 0)
    #expect(task.space == "Launch")
    #expect(task.lastVerify?.ok == true)
    #expect(task.result == "Ready for review")

    let mailJSON = Data("""
    {
      "messages": [{
        "id": "mb-0000abcd",
        "fromUid": "u-worker",
        "toUid": "u-chief",
        "kind": "report",
        "subject": "Draft ready",
        "body": "Saved artifacts/launch.md",
        "createdAt": 1730000050
      }]
    }
    """.utf8)
    let mailList = try JSONDecoder().decode(FleetMailboxResponseDTO.self, from: mailJSON)
    let mail = try #require(mailList.messages.first)
    #expect(mail.id == "mb-0000abcd")
    #expect(mail.kind == .report)
    #expect(mail.toUid == "u-chief")
}

@Test func spacePortalLogicSupportsMultipleChiefsMultiRepoMembershipAndScopedExclusion() throws {
    let chiefA = try makeSessionRow(
        uid: "c1", title: "Launch Chief", project: "Launch", projectPath: "/home/user/spaces/Launch",
        supervision: SupervisionDTO(role: .chief, space: "Launch")
    )
    let chiefB = try makeSessionRow(
        uid: "c2", title: "Launch QA Chief", project: "api-repo", space: "Launch", projectPath: "/home/user/code/api-repo",
        supervision: SupervisionDTO(role: .chief, space: "Launch")
    )
    // Explicitly scoped to Trips even though its folder is Launch — must NOT appear in Launch.
    let scopedElsewhere = try makeSessionRow(
        uid: "c3", title: "Trips Chief", project: "Launch", projectPath: "/home/user/spaces/Launch",
        supervision: SupervisionDTO(role: .chief, space: "Trips")
    )
    let worker = try makeSessionRow(
        uid: "w1", title: "Copywriter", project: "web-repo", space: "Launch", projectPath: "/home/user/code/web-repo",
        supervision: SupervisionDTO(role: .worker, managedBy: "c1")
    )
    let unmanaged = try makeSessionRow(
        uid: "u1", title: "Loose Multi-Repo Session", project: "mobile-repo", space: "Launch", projectPath: "/home/user/code/mobile-repo"
    )

    let all = [chiefA, chiefB, scopedElsewhere, worker, unmanaged]
    let chiefs = SpacePortalLogic.chiefsInSpace(all, spaceName: "Launch", spacePath: "~/spaces/Launch", host: "hub", home: "/home/user")
    #expect(chiefs.map(\.uid) == ["c1", "c2"])

    let launchProject = InboxProject(host: "hub", name: "Launch")
    #expect(launchProject.holds(worker))
    #expect(launchProject.holds(unmanaged))

    let workers = SpacePortalLogic.workersOf(all, chiefUid: "c1", host: "hub")
    #expect(workers.map(\.uid) == ["w1"])

    let loose = SpacePortalLogic.unmanagedInSpace(all, spaceName: "Launch", host: "hub")
    #expect(loose.map(\.uid) == ["u1"])

    let brief = SpacePortalLogic.buildSpaceChiefBrief(
        spaceName: "Launch Q1",
        spacePath: "/home/user/code/api-repo",
        spaceKind: .repo,
        sessions: [worker, unmanaged],
        customInstructions: "Focus on press kit first.",
        contextPath: "/home/user/.local/state/ah/spaces/sp-12345678"
    )
    #expect(brief.contains("'Launch Q1'"))
    #expect(brief.contains("/home/user/.local/state/ah/spaces/sp-12345678/artifacts/"))
    #expect(brief.contains("AGENTS.md"))
    #expect(brief.contains("Copywriter (w1"))
    #expect(brief.contains("Focus on press kit first."))
}

@Test func spacePortalTabsAdaptToSpaceKindContextAndFleetSupport() {
    #expect(SpacePortalTab.tabs(plain: true, supportsSpaceContext: false, supportsFleet: true) == [.sessions, .notes, .files, .tasks, .memory])
    #expect(SpacePortalTab.tabs(plain: false, supportsSpaceContext: true, supportsFleet: true) == [.sessions, .notes, .files, .tasks, .memory])
    #expect(SpacePortalTab.tabs(plain: false, supportsSpaceContext: false, supportsFleet: true) == [.sessions, .notes, .files, .tasks])
    #expect(SpacePortalTab.tabs(plain: false, supportsSpaceContext: false, supportsFleet: false) == [.sessions, .notes, .files])
    #expect(SpacePortalTab.tabs(plain: false, hasFolder: false, supportsSpaceContext: true, supportsFleet: true) == [.sessions, .tasks, .memory])
}

@Test func jobDTODecodesCreatedByForChiefWakes() throws {
    let data = Data("""
    {
      "id": "job-1",
      "name": "Wake Launch Chief on waiting",
      "state": "scheduled",
      "action": { "kind": "send", "target": "c1", "text": "ping" },
      "trigger": { "kind": "session", "uid": "*", "on": "waiting" },
      "createdBy": "system:chief:c1",
      "createdAt": 1730000000,
      "updatedAt": 1730000000
    }
    """.utf8)
    let job = try JSONDecoder().decode(JobDTO.self, from: data)
    #expect(job.createdBy == "system:chief:c1")
    #expect(job.trigger == .session(uid: "*", on: "waiting"))
}

@Test func hashSessionCompletionLeadsWithTheMostRecent() throws {
    let chief = try makeSessionRow(
        uid: "chief-1", title: "Launch Chief", project: "Launch",
        supervision: SupervisionDTO(role: .chief, space: "Launch")
    )
    let subWorker = try makeSessionRow(
        uid: "sub-1", title: "Copywriter", project: "Launch",
        supervision: SupervisionDTO(role: .worker, managedBy: "chief-1")
    )
    let sameSpacePeer = try makeSessionRow(
        uid: "peer-1", title: "Designer", project: "Launch"
    )
    let otherSpace = try makeSessionRow(
        uid: "other-1", title: "Infra Ops", project: "Ops"
    )

    let text = "Coordinate with #co"
    let trigger = try #require(CompletionTrigger.at(text, caret: text.utf16.count))
    #expect(trigger.kind == .session)
    #expect(trigger.query == "co")

    let allRanked = CompletionTrigger.sessions(
        [chief, otherSpace, sameSpacePeer, subWorker],
        query: "",
        currentUid: "chief-1",
        currentSpace: "Launch"
    )
    // Equally recent: its sub-sessions, then its Space's.
    #expect(allRanked.map(\.value) == ["#sub-1 ", "#peer-1 ", "#other-1 "])
    #expect(allRanked[0].label == "Copywriter")
    #expect(allRanked[0].detail?.contains("Sub-session") == true)

    // The most recently active leads, wherever it is.
    let recentOther = try makeSessionRow(uid: "other-2", title: "Release Notes", project: "Ops", activity: 300)
    let recentPeer = try makeSessionRow(uid: "peer-2", title: "Researcher", project: "Launch", activity: 200)
    let recent = CompletionTrigger.sessions(
        [chief, otherSpace, sameSpacePeer, subWorker, recentPeer, recentOther],
        query: "",
        currentUid: "chief-1",
        currentSpace: "Launch"
    )
    #expect(recent.map(\.value) == ["#other-2 ", "#peer-2 ", "#sub-1 ", "#peer-1 ", "#other-1 "])
    let recentMatch = CompletionTrigger.sessions([subWorker, recentOther], query: "re", currentUid: "chief-1", currentSpace: "Launch")
    #expect(recentMatch.map(\.value) == ["#other-2 "])

    let filtered = CompletionTrigger.sessions(
        [chief, otherSpace, sameSpacePeer, subWorker],
        query: "copy",
        currentUid: "chief-1",
        currentSpace: "Launch"
    )
    #expect(filtered.map(\.value) == ["#sub-1 "])
    let applied = trigger.applying(filtered[0], to: text)
    #expect(applied.text == "Coordinate with #sub-1 ")
}

@Test func canonicalProjectPathStripsWorktreesAndInboxDropsWorktreeAndCacheNoise() throws {
    #expect(LaunchState.canonicalProjectPath("~/code/.worktrees/agent-house/claude-17fd") == "~/code/agent-house")
    #expect(LaunchState.canonicalProjectPath("/home/user/code/.worktrees/ah/gemini-5d7b/apps/ios") == "/home/user/code/ah")
    #expect(LaunchState.canonicalProjectPath("~/code/agent-house") == "~/code/agent-house")

    #expect(InboxProject.isNoiseName("claude-8a5d") == true)
    #expect(InboxProject.isNoiseName("gemini-5d7b") == true)
    #expect(InboxProject.isNoiseName("home-ealush-.cache-ah-uploads") == true)
    #expect(InboxProject.isNoiseName("scratch", path: "~/.cache/ah/scratch") == true)
    #expect(InboxProject.isNoiseName("agent-house", path: "~/code/agent-house") == false)
    #expect(InboxProject.isNoiseName("Launch Q1", path: "~/spaces/Launch Q1") == false)

    let liveRow = try makeSessionRow(
        uid: "s1",
        title: "Working",
        project: "agent-house",
        projectPath: "~/code/.worktrees/agent-house/claude-17fd"
    )
    #expect(LaunchState.newestProject([liveRow]) == "~/code/agent-house")
    #expect(
        SpacePortalLogic.expandSpacePath("~/code/.worktrees/agent-house/claude-17fd", home: "/home/user")
            == "/home/user/code/agent-house"
    )
}
