import Foundation

/// Stack review calls on one host (`apps/server/web/reviewApi.ts`).
struct ReviewAPI: Sendable {
    let api: APIClient

    private func s(_ id: String) -> String { "/api/review/stacks/\(APIClient.enc(id))" }
    private func l(_ id: String, _ pr: Int) -> String { "\(s(id))/layers/\(pr)" }

    func repos() async throws -> [ReviewRepo] { try await api.call("GET", "/api/review/repos") }
    func candidates(root: String) async throws -> Candidates { try await api.call("GET", "/api/review/candidates", query: [URLQueryItem(name: "root", value: root)]) }
    func stacks() async throws -> [StackSummary] { try await api.call("GET", "/api/review/stacks") }
    func sessionStack(_ uid: String) async throws -> SessionStack { try await api.call("GET", "/api/review/sessions/\(APIClient.enc(uid))/stack") }
    func sessionCommits(_ uid: String) async throws -> SessionCommits { try await api.call("GET", "/api/review/sessions/\(APIClient.enc(uid))/commits") }
    func openForSession(_ uid: String) async throws -> SessionReviewOpenResult { try await api.call("POST", "/api/review/sessions/\(APIClient.enc(uid))/open") }
    /// Opens a pull request for one branch this session committed on, or every such branch, and the review of it (`features.reviewPulls`).
    func openPulls(_ uid: String, branch: String? = nil) async throws -> SessionReviewOpenResult {
        try await api.call("POST", "/api/review/sessions/\(APIClient.enc(uid))/pulls", json: OpenPullsBody(branch: branch))
    }
    /// A pull request's review from a link to it (`features.reviewLinks`): the stack it's in, else one started from its chain.
    /// `from`: the session (on this host) the link was in.
    func openPull(repo: String, pr: Int, from: String? = nil) async throws -> SessionReviewOpenResult {
        try await api.call("POST", "/api/review/pulls/open", json: OpenPullBody(repo: repo, pr: pr, from: from))
    }
    func settings() async throws -> ReviewSettings { try await api.call("GET", "/api/review/settings") }
    func setSummaryModel(_ id: String?) async throws -> ReviewSettings { try await api.call("PUT", "/api/review/settings", json: SummaryID(summaryId: id)) }

    enum Pick: Sendable, Equatable {
        /// GitHub's chain under one PR.
        case chain(Int)
        /// The PRs you picked, in review order.
        case manual([Int])
        /// A stack GitHub already has.
        case native(Int)
    }

    func create(root: String, pick: Pick, title: String? = nil, from: String? = nil) async throws -> ReviewStack {
        let body = CreateBody(root: root, pr: { if case .chain(let n) = pick { return n }; return nil }(), prs: { if case .manual(let p) = pick { return p }; return nil }(), native: { if case .native(let n) = pick { return n }; return nil }(), title: title, from: from)
        return try await api.call("POST", "/api/review/stacks", json: body)
    }

    func link(_ id: String) async throws -> ReviewStack { try await api.call("POST", "\(s(id))/link") }
    func addLayers(_ id: String, prs: [Int]) async throws -> ReviewStack { try await api.call("POST", "\(s(id))/layers", json: ["prs": prs]) }
    func removeLayer(_ id: String, pr: Int) async throws -> ReviewStack { try await api.call("DELETE", l(id, pr)) }
    func stack(_ id: String) async throws -> ReviewStack { try await api.call("GET", s(id)) }
    func update(_ id: String, _ patch: StackPatch) async throws -> ReviewStack { try await api.call("PATCH", s(id), json: patch) }
    func remove(_ id: String) async throws { try await api.perform("DELETE", s(id)) }
    func sync(_ id: String) async throws -> ReviewStack { try await api.call("POST", "\(s(id))/sync") }
    func owners(_ id: String) async throws -> [OwnerSuggestion] { try await api.call("GET", "\(s(id))/owners") }
    func plan(_ id: String) async throws -> PlanText { try await api.call("GET", "\(s(id))/plan") }
    func description(_ id: String, pr: Int) async throws -> PRDescription { try await api.call("GET", "\(l(id, pr))/description") }
    /// A GitHub image through ah (read with the host's gh login), authenticated.
    func image(_ id: String, src: String) async throws -> Data {
        try await api.send(await api.request("GET", "\(s(id))/image", query: [URLQueryItem(name: "src", value: src)]))
    }
    func setLayer(_ id: String, pr: Int, _ patch: LayerPatch) async throws -> ReviewStack { try await api.call("PATCH", l(id, pr), json: patch) }
    func diff(_ id: String, pr: Int, scope: DiffScope) async throws -> DiffOut { try await api.call("GET", "\(l(id, pr))/diff", query: [URLQueryItem(name: "mode", value: scope.rawValue)]) }
    func busy(_ id: String, pr: Int) async throws -> ReviewBusy { try await api.call("GET", "\(l(id, pr))/busy") }
    func summarize(_ id: String, pr: Int, force: Bool = false) async throws -> SummaryStart { try await api.call("POST", "\(l(id, pr))/summary", json: ["force": force]) }
    /// Marking reviewed is a human decision; withdrawing it is `approved: false`.
    /// `head`: the head the approval is for (the one shown). A host that checks it refuses the
    /// approval if the layer has moved on since (409); older hosts approve the current one.
    func approve(_ id: String, pr: Int, approved: Bool = true, head: String? = nil) async throws -> ReviewStack {
        try await api.call("POST", "\(l(id, pr))/approve", json: ApproveBody(approved: approved, head: head))
    }
    func accept(_ id: String, pr: Int, overrides: [Int: String] = [:]) async throws -> ReviewStack {
        try await api.call("POST", "\(l(id, pr))/accept", json: ["overrides": Dictionary(uniqueKeysWithValues: overrides.map { (String($0.key), $0.value) })])
    }
    func importThreads(_ id: String, pr: Int) async throws -> ImportedThreads { try await api.call("POST", "\(l(id, pr))/threads") }
    /// Merge bottom-up to `upTo`. `markReviewed` stays false unless the user explicitly reviewed each layer.
    func mergeStack(_ id: String, method: String?, markReviewed: Bool, upTo: Int?) async throws -> StackMergeResult {
        try await api.call("POST", "\(s(id))/merge", json: MergeStackBody(method: method, markReviewed: markReviewed, upTo: upTo))
    }
    func merge(_ id: String, pr: Int, outOfOrder: Bool = false, expectedHead: String? = nil, approveHead: Bool = false) async throws -> LayerMergeResult {
        try await api.call("POST", "\(l(id, pr))/merge", json: MergeLayerBody(outOfOrder: outOfOrder, expectedHead: expectedHead, approveHead: approveHead ? true : nil))
    }
    func closeLayer(_ id: String, pr: Int, comment: String? = nil, removeIfDone: Bool = false) async throws -> CloseLayerResult {
        try await api.call("POST", "\(l(id, pr))/close", json: CloseLayerBody(comment: comment, removeIfDone: removeIfDone))
    }
    func retarget(_ id: String, pr: Int) async throws -> ReviewStack { try await api.call("POST", "\(l(id, pr))/retarget") }
    func ready(_ id: String, pr: Int) async throws -> ReviewStack { try await api.call("POST", "\(l(id, pr))/ready") }
    /// Every open draft in the stack, bottom up (`reviewReady`).
    func readyAll(_ id: String) async throws -> ReadyAllResult { try await api.call("POST", "\(s(id))/ready") }
    func dispatchText(_ id: String, pr: Int, findings: [Int], extra: String = "", kind: String? = nil, fresh: Bool = false, method: String? = nil) async throws -> String {
        var query = [URLQueryItem(name: "findings", value: findings.map(String.init).joined(separator: ",")), URLQueryItem(name: "extra", value: extra)]
        if let kind { query.append(URLQueryItem(name: "kind", value: kind)) }
        if fresh { query.append(URLQueryItem(name: "fresh", value: "1")) }
        if let method { query.append(URLQueryItem(name: "method", value: method)) }
        struct R: Decodable { let text: String }
        return (try await api.call("GET", "\(l(id, pr))/dispatch", query: query, as: R.self)).text
    }
    /// `postToGitHub` and `attachments` only reach a host with `reviewPost`; they're left out otherwise.
    func dispatch(_ id: String, pr: Int, findings: [Int], text: String?, targetUid: String?, newSessionPreset: String?, kind: String? = nil, comment: InlineComment? = nil, postToGitHub: Bool = false, attachments: [String] = []) async throws -> DispatchResult {
        try await api.call("POST", "\(l(id, pr))/dispatch", json: DispatchBody(findingIds: findings, text: text, targetUid: targetUid, newSession: newSessionPreset.map { ["preset": $0] }, kind: kind, comment: comment, postToGitHub: postToGitHub ? true : nil, attachments: attachments.isEmpty ? nil : attachments))
    }
    func findings(_ id: String, pr: Int? = nil) async throws -> [Finding] {
        try await api.call("GET", "\(s(id))/findings", query: pr.map { [URLQueryItem(name: "pr", value: String($0))] } ?? [])
    }
    func addFinding(_ id: String, _ body: NewFinding) async throws -> Finding { try await api.call("POST", "\(s(id))/findings", json: body) }
    func updateFinding(_ id: String, finding: Int, _ patch: FindingPatch) async throws -> Finding { try await api.call("PATCH", "\(s(id))/findings/\(finding)", json: patch) }
    func deleteFinding(_ id: String, finding: Int) async throws { try await api.perform("DELETE", "\(s(id))/findings/\(finding)") }
    func resolveThread(_ id: String, finding: Int, body: String) async throws -> Finding { try await api.call("POST", "\(s(id))/findings/\(finding)/resolve", json: ["body": body]) }
    func addDecision(_ id: String, text: String, fromPr: Int?) async throws -> ReviewStack { try await api.call("POST", "\(s(id))/decisions", json: DecisionBody(text: text, fromPr: fromPr)) }
    func removeDecision(_ id: String, decision: Int) async throws -> ReviewStack { try await api.call("DELETE", "\(s(id))/decisions/\(decision)") }
    func thread(_ id: String) async throws -> ReviewThread { try await api.call("GET", "\(s(id))/chat") }
    func pickSubscription(_ id: String, subscription: String) async throws { try await api.perform("PUT", "\(s(id))/chat/subscription", json: ["id": subscription]) }
    func ask(_ id: String, pr: Int?, text: String, subscriptionId: String?, context: [AskContext]) async throws -> AskReply {
        try await api.call("POST", "\(s(id))/chat", json: AskBody(text: text, pr: pr, context: context, subscriptionId: subscriptionId))
    }
    func clearThread(_ id: String) async throws { try await api.perform("DELETE", "\(s(id))/chat") }
}

struct StackPatch: Encodable, Equatable, Sendable {
    var title: String? = nil
    var planPath: String?? = nil
    var mergeMethod: String? = nil
    var order: [Int]? = nil
    var ownerUid: String?? = nil
    var originUid: String?? = nil
    var state: String? = nil

    private enum CodingKeys: String, CodingKey { case title, planPath, mergeMethod, order, ownerUid, originUid, state }

    /// Omitted fields stay as they are; an explicit nil inside clears (`null`).
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        if let planPath { try c.encode(planPath, forKey: .planPath) }
        try c.encodeIfPresent(mergeMethod, forKey: .mergeMethod)
        try c.encodeIfPresent(order, forKey: .order)
        if let ownerUid { try c.encode(ownerUid, forKey: .ownerUid) }
        if let originUid { try c.encode(originUid, forKey: .originUid) }
        try c.encodeIfPresent(state, forKey: .state)
    }
}

struct LayerPatch: Encodable, Equatable, Sendable {
    var role: String? = nil
    var skipped: Bool? = nil
    var ownerUid: String?? = nil

    private enum CodingKeys: String, CodingKey { case role, skipped, ownerUid }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(role, forKey: .role)
        try c.encodeIfPresent(skipped, forKey: .skipped)
        if let ownerUid { try c.encode(ownerUid, forKey: .ownerUid) }
    }
}

struct NewFinding: Encodable, Equatable, Sendable {
    var ownerPr: Int
    var foundOnPr: Int? = nil
    var title: String
    var body: String? = nil
    var severity: String? = nil
    var path: String? = nil
    var lineStart: Int? = nil
    var lineEnd: Int? = nil
}

struct FindingPatch: Encodable, Equatable, Sendable {
    var state: String? = nil
    var severity: String? = nil
    var title: String? = nil
    var body: String? = nil
    var ownerPr: Int? = nil
    var note: String?? = nil

    private enum CodingKeys: String, CodingKey { case state, severity, title, body, ownerPr, note }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(state, forKey: .state)
        try c.encodeIfPresent(severity, forKey: .severity)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(body, forKey: .body)
        try c.encodeIfPresent(ownerPr, forKey: .ownerPr)
        if let note { try c.encode(note, forKey: .note) }
    }
}

private struct SummaryID: Encodable { let summaryId: String? }
private struct OpenPullsBody: Encodable { let branch: String? }
private struct OpenPullBody: Encodable {
    let repo: String
    let pr: Int
    let from: String?
}
private struct CreateBody: Encodable {
    let root: String
    let pr: Int?
    let prs: [Int]?
    let native: Int?
    let title: String?
    let from: String?
}
private struct MergeStackBody: Encodable { let method: String?; let markReviewed: Bool; let upTo: Int? }
private struct MergeLayerBody: Encodable { let outOfOrder: Bool; let expectedHead: String?; let approveHead: Bool? }
private struct CloseLayerBody: Encodable { let comment: String?; let removeIfDone: Bool }
private struct DispatchBody: Encodable { let findingIds: [Int]; let text: String?; let targetUid: String?; let newSession: [String: String]?; let kind: String?; let comment: InlineComment?; let postToGitHub: Bool?; let attachments: [String]? }
private struct DecisionBody: Encodable {
    let text: String
    let fromPr: Int?
    private enum CodingKeys: String, CodingKey { case text, fromPr }
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        try c.encode(fromPr, forKey: .fromPr)
    }
}
private struct AskBody: Encodable { let text: String; let pr: Int?; let context: [AskContext]; let subscriptionId: String? }

private struct ApproveBody: Encodable {
    let approved: Bool
    let head: String?
}

