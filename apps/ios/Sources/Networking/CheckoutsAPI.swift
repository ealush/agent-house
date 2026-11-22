import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Checkouts (`apps/server/server/checkouts`, feature `checkouts` 1, docs/spec/18-checkouts.md):
// concurrent agent workspaces with automatic worktree isolation, exclusive writer ownership,
// runtime port allocation, overlap & merge-tree checks, and disk-pressure-aware reclamation.

/// In the state stream: summary of active checkouts, overlaps, and reclaimable storage.
struct CheckoutsStateDTO: Codable, Equatable, Sendable {
    var revision: Int
    var active: Int
    var overlaps: Int
    var reclaimableCount: Int
    var reclaimableBytes: Int
}

struct CheckoutOwnerDTO: Codable, Equatable, Sendable {
    var uid: String
    var title: String
    var agent: String
    var status: String
    var live: Bool
}

struct CheckoutOverlapDTO: Codable, Equatable, Sendable {
    var checkoutId: String
    var branch: String?
    var ownerUid: String?
    var ownerTitle: String?
    var files: [String]
}

struct CheckoutIntegrationDTO: Codable, Equatable, Sendable {
    var checkedAt: Int
    var trunk: String
    var trunkSha: String
    var clean: Bool
    var conflicts: [String]
    var error: String?
}

struct CheckoutPortsDTO: Codable, Equatable, Sendable {
    var start: Int
    var end: Int
}

struct CheckoutDTO: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var repoRoot: String
    var repoName: String
    var path: String
    var kind: String
    var branch: String?
    var baseSha: String
    var baseBranch: String
    var lifecycle: String
    var pinned: Bool
    var exists: Bool
    var owner: CheckoutOwnerDTO?
    var dirty: Int
    var ahead: Int
    var merged: Bool
    var changedFiles: [String]
    var overlaps: [CheckoutOverlapDTO]
    var integration: CheckoutIntegrationDTO?
    var ports: CheckoutPortsDTO?
    var sizeBytes: Int?
    var reclaimable: Bool
    var reclaimReason: String
    var createdAt: Int
    var lastActivityAt: Int
    var archivedAt: Int?
    var reclaimedAt: Int?
}

struct CheckoutStorageSummaryDTO: Codable, Equatable, Sendable {
    struct Counts: Codable, Equatable, Sendable {
        var total: Int
        var active: Int
        var retained: Int
        var archived: Int
        var reclaimed: Int
        var reclaimable: Int
    }
    var totalBytes: Int
    var activeBytes: Int
    var retainedBytes: Int
    var reclaimableBytes: Int
    var counts: Counts
    var gcEnabled: Bool
    var diskFreeBytes: Int?
    var diskBudgetBytes: Int?
    var minFreeBytes: Int?
    var underPressure: Bool
    var overBudget: Bool
}

struct RepositoryConcurrencyDTO: Codable, Equatable, Sendable, Identifiable {
    var repoRoot: String
    var name: String
    var trunk: String
    var activeCount: Int
    var overlapCount: Int
    var checkouts: [CheckoutDTO]
    var storage: CheckoutStorageSummaryDTO
    var id: String { repoRoot }
}

struct CheckoutsOverviewDTO: Codable, Equatable, Sendable {
    var repositories: [RepositoryConcurrencyDTO]
    var checkouts: [CheckoutDTO]
    var storage: CheckoutStorageSummaryDTO
}

struct CheckoutRemoveDTO: Codable, Equatable, Sendable {
    var id: String
    var path: String
    var reclaimedBytes: Int
}

struct CheckoutGcItemDTO: Codable, Equatable, Sendable {
    var id: String
    var path: String
    var branch: String?
    var reason: String
    var reclaimedBytes: Int
    var ok: Bool
    var error: String?
}

struct CheckoutGcResultDTO: Codable, Equatable, Sendable {
    var dryRun: Bool
    var reclaimed: [CheckoutGcItemDTO]
    var skipped: [CheckoutGcItemDTO]
    var reclaimedBytes: Int
    var underPressure: Bool
    var overBudget: Bool
    var diskFreeBytes: Int?
}

private struct CheckoutPinBody: Encodable { let pinned: Bool }
private struct CheckoutGcBody: Encodable { let dryRun: Bool }
private struct EmptyBody: Encodable {}

extension APIClient {
    func checkouts(repo: String? = nil) async throws -> CheckoutsOverviewDTO {
        var query: [URLQueryItem] = []
        if let repo { query.append(URLQueryItem(name: "repo", value: repo)) }
        return try await call("GET", "/api/checkouts", query: query)
    }

    func checkout(_ id: String) async throws -> CheckoutDTO {
        try await call("GET", "/api/checkouts/\(Self.enc(id))")
    }

    func setCheckoutPinned(_ id: String, pinned: Bool) async throws -> CheckoutDTO {
        try await call("POST", "/api/checkouts/\(Self.enc(id))/pin", json: CheckoutPinBody(pinned: pinned))
    }

    func checkCheckout(_ id: String) async throws -> CheckoutDTO {
        try await call("POST", "/api/checkouts/\(Self.enc(id))/check", json: EmptyBody())
    }

    func recreateCheckout(_ id: String) async throws -> CheckoutDTO {
        try await call("POST", "/api/checkouts/\(Self.enc(id))/recreate", json: EmptyBody())
    }

    func removeCheckout(_ id: String, force: Bool = false) async throws -> CheckoutRemoveDTO {
        let query = force ? [URLQueryItem(name: "force", value: "1")] : []
        return try await call("DELETE", "/api/checkouts/\(Self.enc(id))", query: query)
    }

    func runCheckoutsGc(dryRun: Bool = false) async throws -> CheckoutGcResultDTO {
        try await call("POST", "/api/checkouts/gc", json: CheckoutGcBody(dryRun: dryRun))
    }
}
