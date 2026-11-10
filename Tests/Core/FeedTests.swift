import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Ports of ../ah/test/gui.test.ts and test/feed.test.ts expectations for the client side.

private func entry(_ seq: Int, _ role: FeedEntry.Role, _ parts: [FeedPart]) -> FeedEntry {
    FeedEntry(seq: seq, id: String(seq), role: role, step: "message", at: Double(seq) * 1000, parts: parts)
}

private let call = ToolCall(id: "c1", name: "Bash", args: ["command": .string("pnpm test --filter auth"), "description": .string("Run the auth tests")])
private let result = ToolResult(callId: "c1", text: "ok", isError: false, data: nil, images: nil, truncated: nil)

@Test func snapshotsReplaceAppendsMergeBySeqAndOlderPagesGoInFront() {
    var s = FeedReducer.reduce(.initial, .message(.snapshot(reason: .initial, harness: "claude", entries: [entry(5, .user, [.text("hi")]), entry(6, .assistant, [.toolCall(call)])], floor: 0, head: 6, hasOlder: true)))
    #expect(s.status == .live)
    #expect(s.epoch == 0, "the first snapshot is not a rebuild")
    // An overlapping delivery dedupes; the result folds into its call by id.
    s = FeedReducer.reduce(s, .message(.append(entries: [entry(6, .assistant, [.toolCall(call)]), entry(7, .tool, [.toolResult(result)])], head: 7)))
    #expect(s.entries.map(\.seq) == [5, 6, 7])
    #expect(s.results["c1"] == result)
    s = FeedReducer.reduce(s, .older(FeedPage(entries: [entry(2, .user, [.text("older")])], hasOlder: false)))
    #expect(s.entries.map(\.seq) == [2, 5, 6, 7])
    #expect(!s.hasOlder)
    // A rotated transcript rebuilds the projection.
    let rotated = FeedReducer.reduce(s, .message(.snapshot(reason: .rotated, harness: "claude", entries: [entry(1, .user, [.text("new")])], floor: 0, head: 1, hasOlder: false)))
    #expect(rotated.entries.map(\.seq) == [1])
    #expect(rotated.epoch == 1)
    #expect(rotated.results.isEmpty)
}

@Test func cachedPagesNeverOverwriteTheLiveStreamAndDisconnectsAreVisible() {
    let cached = FeedReducer.reduce(.initial, .cached(harness: "codex", entries: [entry(1, .user, [.text("cached")])], hasOlder: true))
    #expect(cached.entries.count == 1)
    #expect(cached.status == .connecting, "a cache is not live data")
    let live = FeedReducer.reduce(cached, .message(.snapshot(reason: .initial, harness: "codex", entries: [entry(9, .user, [.text("live")])], floor: 0, head: 9, hasOlder: false)))
    #expect(FeedReducer.reduce(live, .cached(harness: "codex", entries: [entry(1, .user, [.text("stale")])], hasOlder: true)) == live)
    #expect(FeedReducer.reduce(live, .disconnected).status == .connecting)
    let gone = FeedReducer.reduce(live, .message(.unavailable(reason: "no-adapter")))
    #expect(gone.status == .unavailable && gone.entries.isEmpty && gone.reason == "no-adapter")
}

@Test func projectionGroupsTurnsAndConsecutiveToolCalls() {
    let second = ToolCall(id: "c2", name: "Read", args: ["file_path": .string("/repo/web/app.tsx")])
    let blocks = FeedProjection.project([
        entry(1, .user, [.text("fix it")]),
        entry(2, .assistant, [.reasoning("thinking"), .toolCall(call)]),
        entry(3, .assistant, [.toolCall(second)]),
        entry(4, .tool, [.toolResult(result)]),
        entry(5, .assistant, [.text("Done.")]),
        entry(6, .system, [.notice(kind: .compacted, text: "Conversation compacted")]),
        entry(7, .assistant, [.text("After.")]),
    ])
    #expect(blocks.count == 4)
    guard case .agent(_, _, _, let items) = blocks[1] else { Issue.record("expected an agent turn"); return }
    #expect(items.count == 3, "reasoning, one tool group of two, then prose")
    if case .tools(_, let calls) = items[1] { #expect(calls.map(\.id) == ["c1", "c2"]) } else { Issue.record("expected a tool group") }
    #expect(blocks[1].text == "Done.", "a block copies as its prose only")
    if case .notice(_, _, _, let kind, _) = blocks[2] { #expect(kind == .compacted) } else { Issue.record("expected a notice") }
    #expect(FeedProjection.lastAssistantText([entry(1, .assistant, [.text("a")]), entry(2, .assistant, [.toolCall(call)])]) == "a", "a trailing tool-only turn is skipped")
}

@Test func handoffHelpersMatchTheWebClient() async throws {
    #expect(FeedProjection.handoffText(summary: " s ", latest: " l ") == "Session summary:\ns\n\nLatest reply:\nl")
    #expect(FeedProjection.handoffText(summary: "", latest: "l") == "l")
    let prompt = FeedProjection.continuePrompt(from: "Claude", cwd: "/w/app", branch: "fix", transcript: "", latest: " last ")
    #expect(prompt.hasPrefix("You are picking up a conversation that was running in Claude, in this same directory (/w/app, branch fix)."))
    #expect(prompt.hasSuffix("<previous-conversation>\nlast\n</previous-conversation>"))
    #expect(FeedProjection.continuePrompt(from: "Codex", cwd: "/w", branch: nil, transcript: "", latest: "").contains("(The earlier conversation had no readable messages.)"))
    let long = String(repeating: "a", count: 500) + "\n\n" + String(repeating: "b", count: 100)
    #expect(FeedProjection.clipTail(long, max: 150) == String(repeating: "b", count: 100))
    actor Pages {
        var pages = [FeedPage(entries: [entry(10, .assistant, [.toolCall(call)])], hasOlder: true), FeedPage(entries: [entry(4, .user, [.text("q")]), entry(5, .assistant, [.text("the reply")])], hasOlder: true)]
        func next() -> FeedPage { pages.removeFirst() }
    }
    let pages = Pages()
    let text = try await FeedProjection.readLastAssistant { _, _ in await pages.next() }
    #expect(text == "the reply")
}

@Test func toolViewsNameWhatTheAgentDidAndWhetherItFinished() {
    let shell = ToolPresentation(call: call, result: nil)
    #expect(shell.label == "Run")
    #expect(shell.summary == "pnpm test --filter auth")
    #expect(shell.status == .running)
    #expect(ToolPresentation(call: call, result: nil, awaiting: true).status == .awaiting)
    #expect(ToolPresentation(call: call, result: nil, turnLive: false).status == .stopped, "no result and the turn is over")
    let done = ToolPresentation(call: call, result: result)
    #expect(done.label == "Ran")
    #expect(done.status == .done)
    let failed = ToolResult(callId: "c1", text: "boom", isError: true, data: nil, images: nil, truncated: true)
    #expect(ToolPresentation(call: call, result: failed).status == .error)
    #expect(ToolPresentation(call: call, result: failed).truncated)

    let edit = ToolCall(id: "e", name: "Edit", args: ["file_path": .string("/a/b/calc.py"), "old_string": .string("x = 1\ny = 2"), "new_string": .string("x = 1\ny = 3")])
    let editView = ToolPresentation(call: edit, result: nil)
    #expect(editView.summary == "calc.py")
    guard case .fileDiff(_, let lines, _) = editView.body else { Issue.record("expected a diff"); return }
    #expect(lines.map(\.kind) == [.ctx, .del, .add], "an unchanged line stays context")

    let plan = ToolCall(id: "t", name: "TodoWrite", args: ["todos": .array([
        .object(["content": .string("a"), "status": .string("completed")]),
        .object(["content": .string("b"), "activeForm": .string("Doing b"), "status": .string("in_progress")]),
        .object(["content": .string("c"), "status": .string("pending")]),
    ])])
    let planView = ToolPresentation(call: plan, result: nil)
    #expect(planView.summary == "1/3 done")
    #expect(planView.body == .checklist([.init(text: "a", state: .done), .init(text: "Doing b", state: .active), .init(text: "c", state: .todo)]))
    #expect(ToolPresentation.displayName("mcp__github__create_issue") == "create_issue (github)")
    #expect(ToolPresentation(call: ToolCall(id: "x", name: "mcp__s__t", args: ["query": .string("q")]), result: nil).label == "t (s)")

    let patch = ToolCall(id: "p", name: "apply_patch", args: ["input": .string("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch")])
    #expect(ToolPresentation(call: patch, result: nil).summary == "a.ts")
}

@Test func toolGroupsFoldButNeverHideAQuestion() {
    let question = ToolCall(id: "q", name: "AskUserQuestion", args: ["questions": .array([.object(["question": .string("Which?")])])])
    let group = ToolGroupSummary(calls: [call, question], results: ["c1": result], awaitingCall: nil, turnLive: true)
    #expect(group.asking)
    #expect(group.running)
    #expect(group.foldedLabel == "2 steps")
    #expect(ToolGroupSummary.hiddenCount(total: 5, showAll: false) == 2)
}

@Test func aPlanUpForApprovalReadsAsThePlan() {
    let plan = ToolCall(id: "p", name: "ExitPlanMode", args: ["plan": .string("## Move sessions to Postgres\n\n1. Add a table\n2. Use it")])
    let waiting = ToolPresentation(call: plan, result: nil, awaiting: true)
    #expect(waiting.kind == .plan && waiting.label == "Propose a plan" && waiting.status == .awaiting)
    #expect(waiting.summary == "Move sessions to Postgres", "named by its heading")
    #expect(waiting.body == .plan("## Move sessions to Postgres\n\n1. Add a table\n2. Use it"))
    #expect(ToolKind.plan.opensByDefault && ToolKind.plan.foldsWhenDone, "open while it asks, one line once decided")
    let approved = ToolPresentation(call: plan, result: ToolResult(callId: "p", text: "User has approved your plan.", isError: false, data: nil, images: nil, truncated: nil))
    #expect(approved.label == "Proposed a plan" && approved.status == .done)
}

@Test func diffsInEveryShapeAgentsProduce() {
    let git = DiffParser.patchLines("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -10,2 +10,3 @@ func\n ctx\n-gone\n+new\n+more")
    #expect(git.map(\.kind) == [.file, .hunk, .ctx, .del, .add, .add])
    #expect(git[1].text == "… func")
    #expect(git[2].number == 10 && git[3].number == 11 && git[4].number == 11 && git[5].number == 12)
    let structured = DiffParser.structuredLines(.array([.object(["oldStart": .number(3), "newStart": .number(3), "lines": .array([.string(" a"), .string("-b"), .string("+c")])])]))
    #expect(structured?.map(\.number) == [nil, 3, 4, 4])
    let files = FileDiff.files(in: "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/two.txt b/two.txt\n@@ -0,0 +1 @@\n+c")
    #expect(files.map(\.path) == ["one.txt", "two.txt"])
    #expect(files[0].additions == 1 && files[0].deletions == 1)
}

@Test func widgetsDecodeEveryDocumentedTypeAndKeepUnknownOnesAsData() throws {
    func widget(_ json: String) throws -> WidgetModel { WidgetModel(try JSONDecoder().decode(Widget.self, from: Data(json.utf8))) }
    #expect(try widget(#"{"type":"card","title":"T","body":"**b**","tone":"weird","actions":[{"label":"Go","reply":"go now"},{}]}"#)
        == .card(title: "T", body: "**b**", tone: .info, actions: [.init(label: "Go", reply: "go now", description: nil), .init(label: "Option 2", reply: "Option 2", description: nil)]))
    #expect(try widget(#"{"type":"choices","prompt":"Next?","options":[{"label":"Again","reply":"again"},"Stop"]}"#)
        == .choices(prompt: "Next?", options: [.init(label: "Again", reply: "again", description: nil), .init(label: "Stop", reply: "Stop", description: nil)]))
    #expect(try widget(#"{"type":"table","columns":["a","b"],"rows":[[1,"x"],{"a":2,"b":"y"}]}"#) == .table(title: "", columns: ["a", "b"], rows: [["1", "x"], ["2", "y"]]))
    #expect(try widget(#"{"type":"checklist","items":[{"text":"a","done":true},{"text":"b","done":"in_progress"},"c"]}"#)
        == .checklist(title: "", items: [.init(text: "a", state: .done), .init(text: "b", state: .active), .init(text: "c", state: .todo)]))
    #expect(try widget(#"{"type":"bar-chart","unit":"ms","data":[{"label":"a","value":5},{"label":"bad","value":"x"},{"label":"b","value":10}]}"#)
        == .barChart(title: "", unit: "ms", data: [.init(label: "a", value: 5), .init(label: "b", value: 10)]))
    #expect(WidgetModel.barFractions([.init(label: "a", value: 5), .init(label: "b", value: 10)]) == [0.5, 1])
    #expect(try widget(#"{"type":"progress","value":150,"max":0}"#) == .progress(label: "", value: 100, max: 100))
    guard case .links(_, let links) = try widget(#"{"type":"links","items":[{"label":"Docs","url":"https://example.com"},{"label":"Plan","url":"~/plan.md"},{"label":"Bad","url":"javascript:alert(1)"}]}"#) else { Issue.record("links"); return }
    #expect(links.map(\.target) == [.web(URL(string: "https://example.com")!), .hostFile("~/plan.md"), .unsupported("javascript:alert(1)")])
    #expect(try widget(#"{"type":"image","src":"https://tracker.example/x.png"}"#) == .image(title: "", source: .unavailable("https://tracker.example/x.png"), alt: "", caption: ""), "no remote images")
    #expect(try widget(#"{"type":"image","src":"data:image/png;base64,iVBORw0K"}"#) == .image(title: "", source: .inline(Data(base64Encoded: "iVBORw0K")!), alt: "", caption: ""))
    guard case .unknown(let type, let title, let json) = try widget(#"{"type":"sparkline","title":"S","points":[1,2]}"#) else { Issue.record("unknown"); return }
    #expect(type == "sparkline" && title == "S" && json.contains("\"points\""))
}

@Test func theRailListsEveryMessageYouSentOldestFirstThenWhatsSending() {
    let prompts = [FeedPrompt(seq: 2, at: 1, text: "first"), FeedPrompt(seq: 9, at: 3, text: "second")]
    let blocks: [FeedBlock] = [
        .user(key: "9", seq: 9, at: 3, parts: [.text("second, as drawn")]),
        .agent(key: "10", seq: 10, at: 4, items: []),
        .user(key: "14", seq: 14, at: 5, parts: [.text("third")]),
    ]
    let items = FeedProjection.railItems(prompts: prompts, blocks: blocks, outgoing: [(id: 7, text: "fourth")])
    #expect(items.map(\.id) == ["2", "9", "14", "out:7"])
    #expect(items.map(\.text) == ["first", "second, as drawn", "third", "fourth"], "what's drawn wins over the host's list")
    #expect(items.last?.seq == nil)
    // The lit tick: the newest at the end, else the last of yours at or above the top.
    #expect(FeedProjection.activeRail(items, topSeq: nil, atLatest: true) == 3)
    #expect(FeedProjection.activeRail(items, topSeq: 10, atLatest: false) == 1)
    #expect(FeedProjection.activeRail(items, topSeq: 1, atLatest: false) == 0)
    #expect(FeedProjection.activeRail([], topSeq: 3, atLatest: false) == nil)
}

@Test func pastFifteenTicksTheRailIsAWindowAroundWhatYouRead() {
    #expect(FeedProjection.railRange(count: 6, lead: 5) == 0..<6)
    #expect(FeedProjection.railRange(count: 40, lead: 0) == 0..<15)
    #expect(FeedProjection.railRange(count: 40, lead: 20) == 13..<28)
    #expect(FeedProjection.railRange(count: 40, lead: 39) == 25..<40)
}

@Test func whileItWorksTheBoxSaysItQueuesAndHowToSendNow() {
    #expect(ComposerModel.placeholder(isShell: false, working: true, queued: 0, touchOnly: false).contains("⌘↵ sends now"))
    #expect(ComposerModel.placeholder(isShell: false, working: true, queued: 2, touchOnly: false).contains("steers the next"))
    #expect(ComposerModel.placeholder(isShell: false, working: true, queued: 0, touchOnly: true) == "Add to the queue · sent when it’s free", "no key hints without a keyboard")
    #expect(ComposerModel.placeholder(isShell: false, working: false, queued: 0, touchOnly: true, agent: "Claude Code") == "Message Claude Code", "on touch, / and @ wait in the composer's tray")
    #expect(ComposerModel.placeholder(isShell: false, working: false, queued: 0, touchOnly: true, waiting: true) == "Reply to answer")
    #expect(ComposerModel.placeholder(isShell: false, working: false, queued: 0, touchOnly: true, ended: true) == "Message to resume")
    // Narrow: whole hints drop from the end.
    let width: (String) -> Double = { Double($0.count) }
    #expect(ComposerModel.fitting("Send a follow-up · / commands · @ files", width: 30, measure: width) == "Send a follow-up · / commands")
    #expect(ComposerModel.fitting("Send a follow-up · / commands · @ files", width: 5, measure: width) == "Send a follow-up")
    #expect(ComposerModel.placeholder(isShell: false, working: false, queued: 0, touchOnly: false) == "Message the agent · / commands · @ files")
    #expect(ComposerModel.placeholder(isShell: true, working: true, queued: 0, touchOnly: false) == "Type or paste a command")
}

@Test func eachAnsweredTurnKnowsHowLongItTook() {
    let entries = [
        entry(1, .assistant, [.text("From before you came in")]),
        entry(3, .user, [.text("Fix the login flash")]),
        entry(5, .assistant, [.toolCall(call)]),
        entry(8, .tool, [.toolResult(result)]),
        entry(15, .assistant, [.text("Fixed.")]),
        entry(20, .user, [.text("Thanks")]),
        entry(21, .assistant, [.text("Anytime.")]),
    ]
    let durations = FeedProjection.turnDurations(entries)
    #expect(durations["5"] == 12, "from the message at 3 s to the last answer at 15 s")
    #expect(durations["21"] == 1)
    #expect(durations["1"] == nil, "a turn whose question isn't in view")
    #expect(FeedProjection.project(entries).contains { $0.id == "5" }, "keyed by the agent block that answers")
}

@Test func aLongSessionsSnapshotReadsInOneLine() throws {
    // ah sends a snapshot as one line of JSON; a session full of screenshots runs to megabytes.
    let big = String(repeating: "x", count: 5_000_000)
    let entry = #"{"seq":1,"id":"a","role":"assistant","step":"llm_call","at":0,"parts":[{"type":"text","text":"\#(big)"}]}"#
    let line = Data("event: snapshot\ndata: {\"type\":\"snapshot\",\"reason\":\"initial\",\"harness\":\"claude\",\"entries\":[\(entry)],\"floor\":0,\"head\":1,\"hasOlder\":false}\n\n".utf8)
    var parser = ServerSentEventParser(maximumLineBytes: FeedStream.largestEvent, maximumEventBytes: FeedStream.largestEvent)
    let events = try parser.append(line)
    guard case .snapshot(_, _, let entries, _, _, _)? = try FeedMessage.decode(try #require(events.first)) else { Issue.record("not a snapshot"); return }
    #expect(entries.first?.parts == [.text(big)])
    var old = ServerSentEventParser()
    #expect(throws: ServerSentEventParser.ParseError.lineTooLarge, "the old 1 MiB line limit is what kept it out") { _ = try old.append(line) }
}

@Test func anOddPartDoesNotKeepTheEntryAway() throws {
    let json = #"{"seq":3,"id":"b","role":"assistant","step":"llm_call","at":0,"parts":[{"type":"widget","widget":{"title":"no type"}},{"type":"text","text":"still here"}]}"#
    let entry = try JSONDecoder().decode(FeedEntry.self, from: Data(json.utf8))
    #expect(entry.parts == [.unknown(type: "widget"), .text("still here")])
}

@MainActor
@Test func aSentBubbleLeavesOnceTheTranscriptHasItEvenBeforeTheRequestAnswers() {
    let outbox = Outbox()
    outbox.now = { 1000 }
    let sending = outbox.add(key: "a", text: "Add a  skip button", state: .sending)
    let older = outbox.add(key: "a", text: "Something else", state: .sent)
    outbox.retireSent(key: "a", userTurns: [(at: 999, text: "Add a skip button")])
    #expect(outbox.items.map(\.id) == [older], "the one the transcript shows leaves, sending or not")
    _ = sending
    // An identical message from long before isn't this one.
    let again = outbox.add(key: "a", text: "Something else", state: .sending)
    outbox.retireSent(key: "a", userTurns: [(at: 900, text: "Something else")])
    #expect(outbox.items.map(\.id) == [older, again])
}
