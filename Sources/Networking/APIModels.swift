import Foundation

// Typed request/response bodies for `../ah/web/api.ts`. Names follow the web client so a
// reader can move between the two. Unknown fields are ignored; absent optionals stay nil.

/// What a send did (`server/core.ts` SendResult). `delivered` means typed into the agent's
/// terminal: never presented as "the agent got it" until its transcript shows the message.
struct SendResult: Codable, Equatable, Sendable {
    enum Outcome: String, Codable, Sendable { case delivered, queued }
    let outcome: Outcome
    let windowId: String
    let resumed: Bool
    let queued: Int
    let queueId: String?
    /// Queued only because a new agent's UI isn't up yet.
    let starting: Bool?
}

struct QueueItem: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let text: String
    let enter: Bool
    /// Seconds since the epoch.
    let at: Double
}

struct CreatedWindow: Codable, Equatable, Sendable {
    let id: String
    let uid: String
}

struct ResumeResult: Codable, Equatable, Sendable {
    let id: String
    let uid: String
    let resumed: Bool
}

struct NewSessionRequest: Encodable, Equatable, Sendable {
    var preset: String
    var cwd: String
    var session: String
    var label: String
    var resume: Bool = false
    var worktree: Bool? = nil
    var create: Bool? = nil
    var git: Bool? = nil
    var mode: String? = nil
    var model: String? = nil
    var effort: String? = nil
    var extraArgs: String? = nil
}

struct ForkInfo: Codable, Equatable, Sendable {
    let canFork: Bool
    let reason: String?
    let harness: String
    let title: String
    let suggestedName: String
    let branch: String?
    let head: String?
    let dirty: Int
    let busy: Bool
    let mode: String?
    let model: String?
    let effort: String?
    let dangerous: Bool
}

struct ForkRequest: Encodable, Equatable, Sendable {
    var name: String? = nil
    var prompt: String? = nil
    var model: String? = nil
    var effort: String? = nil
    var mode: String? = nil
}

struct ForkResult: Codable, Equatable, Sendable {
    let uid: String
    let id: String
    let harnessId: String
    let worktree: String
    let branch: String
    let base: String
    let prompt: SendResult.Outcome?
}

struct QuestionAnswer: Codable, Equatable, Sendable {
    var picked: [Int]
    var text: String? = nil
    /// Notes on the pick of a question with previews (the dialog's "n to add notes").
    var notes: String? = nil
}

struct SlashCommand: Codable, Equatable, Sendable, Hashable {
    let name: String
    let description: String
    let source: String
}

struct Draft: Codable, Equatable, Sendable {
    let text: String
    /// Milliseconds since the epoch.
    let at: Double
    let device: String
    let client: String
}

struct DraftEnvelope: Codable, Equatable, Sendable { let draft: Draft? }

struct PromptRecord: Codable, Equatable, Sendable, Hashable {
    let text: String
    let at: Double
}

struct Changes: Codable, Equatable, Sendable {
    struct File: Codable, Equatable, Sendable, Hashable {
        let code: String
        let path: String
    }
    let root: String
    let branch: String
    let files: [File]
    let stat: String
    let patch: String
    let truncated: Bool
}

struct BranchList: Codable, Equatable, Sendable {
    struct Branch: Codable, Equatable, Sendable, Hashable {
        let name: String
        let current: Bool
        let remote: Bool
        let worktree: String?
    }
    let current: String?
    let branches: [Branch]
    let dirty: Int
}

struct PullInfo: Codable, Equatable, Sendable {
    let number: Int?
    let url: String?
}

struct SnapshotInfo: Codable, Equatable, Sendable, Identifiable {
    let id: Int
    let uid: String
    let turn: Int
    let commit: String
    let kind: String
    let promptExcerpt: String
    let branch: String
    let createdAt: Double
    let filesChanged: Int
    let insertions: Int
    let deletions: Int
    let skipped: [String]
    let submodules: Bool
}

struct SnapshotList: Codable, Equatable, Sendable {
    let snapshots: [SnapshotInfo]
    let enabled: Bool
    let available: Bool
    let partial: Bool
    let branch: String?
}

struct SnapshotRestore: Codable, Equatable, Sendable {
    let safety: SnapshotInfo
    let restored: SnapshotInfo
    let notified: Bool
}

struct PreviewDTO: Codable, Equatable, Sendable {
    let uid: String
    let target: Int
    let port: Int
    let published: Bool
}

struct PreviewInfo: Codable, Equatable, Sendable {
    let preview: PreviewDTO?
    let ports: [Int]
    let live: Bool
}

struct Subscription: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    let baseUrl: String
    let model: String
    let hasKey: Bool
    let keyHint: String
    let isDefault: Bool
    let envName: String?
}

struct SubscriptionDraft: Encodable, Equatable, Sendable {
    var id: String? = nil
    var name: String
    var baseUrl: String
    var model: String
    /// Only when the user typed a new key; omitted keeps the saved one.
    var apiKey: String? = nil
    var envName: String? = nil
}

struct EnvVar: Codable, Equatable, Sendable, Identifiable {
    var id: String { name }
    let name: String
    /// Null for a secret: the server returns only `hint`.
    let value: String?
    let secret: Bool
    let hint: String?
}

struct EnvState: Codable, Equatable, Sendable {
    struct Export: Codable, Equatable, Sendable, Hashable {
        let name: String
        let subscriptionId: String
        let subscription: String
    }
    struct Stale: Codable, Equatable, Sendable, Hashable {
        let uid: String
        let title: String
        let agent: String
        /// Null when it can restart now; otherwise why not.
        let restart: String?
    }
    let vars: [EnvVar]
    let exports: [Export]
    let stale: [Stale]
}

struct ChatMessage: Codable, Equatable, Sendable, Hashable {
    enum Role: String, Codable, Sendable { case user, assistant }
    let role: Role
    let text: String
    let at: Double
    let id: Int?
}

struct Followup: Codable, Equatable, Sendable, Hashable {
    let title: String
    let kind: String
    let text: String
}

struct ChatReply: Codable, Equatable, Sendable {
    let message: ChatMessage
    let followups: [Followup]
}

struct ChatThread: Codable, Equatable, Sendable {
    let messages: [ChatMessage]
    let subscriptionId: String?
}

struct ChatSummary: Codable, Equatable, Sendable, Identifiable {
    var id: String { uid }
    let uid: String
    let title: String
    let count: Int
    let firstAt: Double
    let lastAt: Double
    let preview: String
}

struct SearchQuery: Equatable, Sendable, Codable, Hashable {
    var q: String
    var scope: String? = nil
    var role: String? = nil
    var project: String? = nil
    var host: String? = nil
    var model: String? = nil
    var limit: Int? = nil
    var offset: Int? = nil
    var from: Double? = nil
    var to: Double? = nil

    /// The query string `web/api.ts search()` builds.
    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "q", value: q)]
        func add(_ name: String, _ value: String?) { if let value, !value.isEmpty { items.append(URLQueryItem(name: name, value: value)) } }
        add("in", scope)
        add("role", role)
        add("p", project)
        add("h", host)
        add("m", model)
        add("limit", limit.map(String.init))
        add("offset", offset.map(String.init))
        add("from", from.map { $0.plainString })
        add("to", to.map { $0.plainString })
        return items
    }
}

struct SearchExcerpt: Codable, Equatable, Sendable, Hashable {
    let seq: Int?
    let msgId: Int?
    let role: String
    let at: Double
    let snippet: String
}

struct SearchHit: Codable, Equatable, Sendable, Hashable {
    let kind: String
    let host: String
    let ref: String?
    let uid: String?
    let harness: String?
    let harnessId: String?
    let title: String
    let cwd: String
    let at: Double
    let matches: Int
    let excerpts: [SearchExcerpt]
}

struct SearchResponse: Codable, Equatable, Sendable {
    struct Note: Codable, Equatable, Sendable, Hashable { let host: String; let error: String }
    let enabled: Bool
    let building: Bool
    let results: [SearchHit]
    let total: Int
    let tookMs: Double
    let notes: [Note]
}

struct SearchStatus: Codable, Equatable, Sendable {
    let enabled: Bool
    let building: Bool
    let sourcesIndexed: Int
    let sourcesKnown: Int
    let entries: Int
    let transcriptEntries: Int
    let chatEntries: Int
    let lastBuiltAt: Double
}

struct WorktreeInfo: Codable, Equatable, Sendable, Identifiable {
    var id: String { path }
    struct Live: Codable, Equatable, Sendable, Hashable { let id: String; let name: String }
    struct Owner: Codable, Equatable, Sendable, Hashable { let id: String; let title: String; let lifecycle: String }
    let path: String
    let branch: String
    let repo: String
    let head: String
    let dirty: Int
    let ahead: Int
    let sizeBytes: Double?
    let logicalBytes: Double?
    let sizePartial: Bool
    let sizeTooLarge: Bool
    let sizeMeasuredAt: Double?
    let lastActivityAt: Double
    let live: [Live]
    let sessions: [Owner]
    let orphan: Bool
}

struct BulkRemoveResult: Codable, Equatable, Sendable {
    let path: String
    let ok: Bool
    let error: String?
    let gone: Bool?
    let reclaimedBytes: Double
}

struct FsEntry: Codable, Equatable, Sendable, Hashable {
    enum Kind: String, Codable, Sendable { case dir, file, other }
    let name: String
    let type: Kind
    let size: Double
    let mtime: Double
}

struct FsListing: Codable, Equatable, Sendable {
    let path: String
    let parent: String?
    let entries: [FsEntry]
    let roots: [String]?
}

enum DirState: String, Codable, Sendable { case dir, new, file, missing, outside }

struct DirStatus: Codable, Equatable, Sendable {
    let state: DirState
    let root: String
}

struct HarnessInfo: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    let command: String
    let custom: Bool
    let installed: Bool
    let hidden: Bool
    let version: String?
    let checkedAt: Double?
    let changes: [String]
}

struct Harnesses: Codable, Equatable, Sendable {
    struct Suggestion: Codable, Equatable, Sendable, Hashable { let command: String; let name: String }
    let agents: [HarnessInfo]
    let suggestions: [Suggestion]
}

struct HooksStatus: Codable, Equatable, Sendable {
    struct Claude: Codable, Equatable, Sendable { let wired: Int; let of: Int; let file: String }
    struct Codex: Codable, Equatable, Sendable { let wired: Bool; let otherNotify: Bool; let file: String }
    struct Audit: Codable, Equatable, Sendable {
        struct Last: Codable, Equatable, Sendable { let at: Double; let ask: String; let screen: String }
        let checked: Int
        let missed: Int
        let last: Last?
    }
    let claude: Claude
    let codex: Codex
    let audit: [String: Audit]?
}

struct OmarchyTheme: Codable, Equatable, Sendable {
    let name: String
    let mode: String
    let colors: [String: String]
    let font: String?
}

struct MessagesResult: Codable, Equatable, Sendable {
    let messages: [String]
}

struct UploadedPath: Codable, Equatable, Sendable { let path: String }

struct OKResult: Codable, Equatable, Sendable { let ok: Bool? }

struct ClearedUploads: Codable, Equatable, Sendable {
    let ok: Bool
    let removed: Int
}

struct Hello: Codable, Equatable, Sendable {
    let ah: Bool
    let hostname: String
    let auth: Bool
}

struct AuthStatus: Codable, Equatable, Sendable {
    let enabled: Bool
    let enrolled: Bool
    let authenticated: Bool
    let password: Bool
}

/// Settings → Security (`server/auth.ts` overview + recent audit).
struct AuthOverview: Codable, Equatable, Sendable {
    struct Passkey: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let label: String
        let rpID: String
        let createdAt: Double
        let lastUsedAt: Double
    }
    struct SignIn: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let label: String
        let via: String
        let createdAt: Double
        let lastSeenAt: Double
        let expiresAt: Double
        let current: Bool
        let native: Bool?
        let deviceId: String?
    }
    struct Device: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let label: String
        let createdAt: Double
        let lastUsedAt: Double
        let current: Bool
    }
    struct Token: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let createdAt: Double
        let lastUsedAt: Double
    }
    let passkeys: [Passkey]
    let sessions: [SignIn]
    let devices: [Device]?
    let tokens: [Token]
    let password: Bool
    let enabled: Bool
    let idleHours: Double
    let maxDays: Double
    let audit: [JSONValue]?
}

struct SetupCode: Codable, Equatable, Sendable {
    let code: String
    let ttlMinutes: Int
}

struct APNsStatus: Codable, Equatable, Sendable {
    struct Registration: Codable, Equatable, Sendable {
        struct Events: Codable, Equatable, Sendable { let waiting: Bool; let done: Bool }
        let environment: String
        let events: Events
        let preview: String
        let at: Double
    }
    let configured: Bool
    let topic: String?
    let registration: Registration?
}

struct SummaryResult: Codable, Equatable, Sendable { let summary: String }
struct ModelsResult: Codable, Equatable, Sendable { let models: [String] }
struct SwitchModeResult: Codable, Equatable, Sendable { let switched: Bool }
struct RelaunchResult: Codable, Equatable, Sendable { let uid: String; let id: String }
struct ChooseResult: Codable, Equatable, Sendable { let ok: Bool; let label: String }
struct BranchSwitch: Codable, Equatable, Sendable { let branch: String }
struct PromptsResult: Codable, Equatable, Sendable { let prompts: [FeedPrompt] }
struct PreviewStart: Codable, Equatable, Sendable { let preview: PreviewDTO }
struct BulkRemoveResponse: Codable, Equatable, Sendable { let results: [BulkRemoveResult] }
struct HooksAction: Codable, Equatable, Sendable { let messages: [String]; let status: HooksStatus }

/// `bind`: a Hyprland binding to paste by hand (the host never edits its bindings).
struct DesktopStatus: Codable, Equatable, Sendable {
    let installed: Bool
    let omarchy: Bool
    let url: String
    let file: String
    let bind: String
}

struct DesktopAction: Codable, Equatable, Sendable { let messages: [String]; let status: DesktopStatus }

struct CreatedToken: Codable, Sendable { let token: String }
