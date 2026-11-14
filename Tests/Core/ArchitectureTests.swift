import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// The architecture of a layer read from its diff (`ArchitectureOverview`): only what the
// lines show, each claim with its lines.

/// The demo's orbit-api #102: users.ts gains forgetUsers, a new teams route uses it.
private let patch = """
diff --git a/src/routes/users.ts b/src/routes/users.ts
index 1111111..2222222 100644
--- a/src/routes/users.ts
+++ b/src/routes/users.ts
@@ -1,6 +1,10 @@
 import { db } from '../db';
-import { cache } from '../cache';
+import { ttlCache } from '../ttl';

 export async function listUsers() {
   return db.query('select * from users');
 }
+
+export function forgetUsers(ids: string[]) {
+  for (const id of ids) ttlCache.delete(id);
+}
-export function oldHelper() {}
diff --git a/src/routes/teams.ts b/src/routes/teams.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/routes/teams.ts
@@ -0,0 +1,7 @@
+import { forgetUsers } from './users';
+import express from 'express';
+
+export const teams = express.Router();
+teams.post('/teams/:id/leave', async (req, res) => {
+  forgetUsers([req.params.id]);
+  await fetch('https://audit.example.com/leave');
+});
diff --git a/test/users.test.ts b/test/users.test.ts
index 4444444..5555555 100644
--- a/test/users.test.ts
+++ b/test/users.test.ts
@@ -3,3 +3,6 @@ import { listUsers } from '../src/routes/users';
 test('lists', async () => {
   expect(await listUsers()).toHaveLength(2);
 });
+test('forgets', () => {
+  forgetUsers(['a']);
+});
diff --git a/src/legacy.ts b/src/legacy.ts
index 6666666..7777777 100644
--- a/src/legacy.ts
+++ b/src/legacy.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = oldHelper();
 export default x;
"""

private let overview = ArchitectureOverview.read(FileDiff.files(in: patch), head: "abc1234def")

@Test func itSaysWhichPartsOfTheSystemTheLayerTouches() {
    #expect(overview.head == "abc1234def", "it describes that revision and no other")
    #expect(Set(overview.components.map(\.id)) == ["src/routes", "test", "src"])
    #expect(overview.components.first { $0.id == "test" }?.role == .tests)
    #expect(overview.components.first { $0.id == "src/routes" }?.files.count == 2)
    #expect(overview.newFiles == ["src/routes/teams.ts"])
}

@Test func dependenciesAddedAndDroppedComeFromImportLines() throws {
    func edge(_ from: String, _ to: String) -> ArchitectureOverview.Edge? { overview.edges.first { $0.from == from && $0.to == to } }
    let uses = try #require(edge("src/routes/teams.ts", "src/routes/users.ts"), "a relative import resolves to the changed file")
    #expect(uses.change == .added)
    #expect(uses.evidence.first?.number == 1 && uses.evidence.first?.side == .added)
    #expect(edge("src/routes/users.ts", "module:src/ttl")?.change == .added)
    #expect(edge("src/routes/users.ts", "module:src/cache")?.change == .removed)
    #expect(edge("src/routes/users.ts", "module:src/db")?.change == .kept, "context lines show what stays")
    #expect(edge("src/routes/teams.ts", "module:express")?.change == .added)
    let before = overview.graph(after: false)
    let after = overview.graph(after: true)
    #expect(before.edges.contains { $0.to == "module:src/cache" } && !after.edges.contains { $0.to == "module:src/cache" })
    #expect(!before.nodes.contains { $0.id == "src/routes/teams.ts" }, "a new file isn't in the before picture")
    #expect(after.nodes.contains { $0.id == "src/routes/teams.ts" })
}

@Test func entryPointsInterfacesAndUsesAcrossFilesNameTheirLines() throws {
    let route = try #require(overview.claims(.entryPoint).first)
    #expect(route.text == "Route POST /teams/:id/leave")
    #expect(route.certainty == .inDiff)
    #expect(route.evidence.first?.path == "src/routes/teams.ts" && route.evidence.first?.number == 5)
    #expect(overview.claims(.interfaceAdded).map(\.text).contains("forgetUsers is new in users.ts"))
    #expect(overview.claims(.interfaceRemoved).map(\.text) == ["oldHelper is gone from users.ts"])
    let uses = overview.claims(.uses)
    #expect(uses.contains { $0.text == "teams.ts uses forgetUsers from users.ts" && $0.certainty == .inDiff && $0.evidence.count >= 2 })
    let stale = try #require(overview.claims(.staleUse).first)
    #expect(stale.text == "legacy.ts still mentions oldHelper, which users.ts no longer has")
    #expect(stale.certainty == .likely, "a name, not a proven break")
    #expect(overview.claims(.boundary).map(\.text).contains("Reaches the network (1 new line)"))
}

@Test func testsThatMoveWithItAndSourceThatHasNone() {
    #expect(overview.claims(.testsChanged).map(\.text) == ["users.test.ts: 3 added, 0 removed"])
    let untested = overview.claims(.untested).map(\.text)
    #expect(untested.contains("No test named for teams.ts changes in this layer"))
    #expect(!untested.contains { $0.contains("users.ts") }, "users.test.ts moves with it")
    #expect(overview.claims(.untested).allSatisfy { $0.certainty == .likely })
}

@Test func otherLanguagesReadTheirOwnImportsAndDefinitions() {
    #expect(ArchitectureOverview.importSpec("@testable import AgentHubKit", path: "Tests/A.swift") == "AgentHubKit")
    #expect(ArchitectureOverview.importSpec("from app.models import User", path: "app/views.py") == "app.models")
    #expect(ArchitectureOverview.importSpec("use crate::store::Db;", path: "src/main.rs") == "crate::store::Db")
    #expect(ArchitectureOverview.importSpec("const fs = require('node:fs');", path: "bin/cli.js") == "node:fs")
    #expect(ArchitectureOverview.definition("public struct ReviewModel {", path: "Sources/Review/ReviewModel.swift") == "ReviewModel")
    #expect(ArchitectureOverview.definition("    func inner() {}", path: "Sources/A.swift") == nil, "a member isn't the module's interface")
    #expect(ArchitectureOverview.definition("def handler(event):", path: "fn.py") == "handler")
    #expect(ArchitectureOverview.definition("func Serve(addr string) error {", path: "main.go") == "Serve")
    #expect(ArchitectureOverview.entryPoint("if ((m = route('POST', /^\\/api\\/sessions\\/x\\/answer$/))) {") == "Route POST /api/sessions/x/answer")
    #expect(ArchitectureOverview.entryPoint("@main") == "Program entry")
    #expect(ArchitectureOverview.entryPoint("const v = cache.get('users')") == nil, "a map lookup isn't a route")
    #expect(ArchitectureOverview.baseName("Tests/Core/ReviewModelTests.swift") == "reviewmodel")
    #expect(ArchitectureOverview.baseName("server/review.test.ts") == "review")
}

@Test func theGraphLaysOutFromTheEntrySideToWhatEverythingUses() {
    let spots = DiagramLayout.layout(nodes: ["a", "b", "c", "d"], edges: [("a", "b"), ("b", "c"), ("a", "c"), ("c", "a")])
    #expect(spots["a"]?.column == 0)
    #expect(spots["b"]?.column == 1)
    #expect(spots["c"]?.column == 2, "the longest path decides; a cycle back to a is cut")
    #expect(spots["d"] == .init(column: 0, row: 1), "on its own, at the start")
}

@Test func anEmptyOrUnreadableDiffSaysSo() {
    let empty = ArchitectureOverview.read([], head: nil)
    #expect(empty.isEmpty && empty.claims.isEmpty)
    let binary = ArchitectureOverview.read(FileDiff.files(in: "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ"), head: "x")
    #expect(binary.unread == 1)
}

/// A host that records what an approval asked for.
private final class ApprovingHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var bodies: [[String: Any]] = []
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        lock.withLock { bodies.append(body) }
        return (Data(#"{"error":"it is at 9999999 now"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@Test func anApprovalNamesTheHeadItIsFor() async throws {
    let host = ApprovingHost()
    let api = APIClient(origin: URL(string: "https://box.tail.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let review = ReviewAPI(api: api)
    await #expect(throws: APIError.self) { _ = try await review.approve("s1", pr: 102, approved: true, head: "3cac305") }
    #expect(host.bodies.last?["head"] as? String == "3cac305")
    #expect(host.bodies.last?["approved"] as? Bool == true)
    await #expect(throws: APIError.self) { _ = try await review.approve("s1", pr: 102, approved: false) }
    #expect(host.bodies.last?["head"] == nil, "a withdrawal names none")
}
