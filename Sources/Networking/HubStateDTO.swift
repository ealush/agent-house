import Foundation

/// API 28 state (`../ah/server/core.ts` State), pinned in SOURCE.json. Fields an older
/// server may omit get the defaults `web/api.ts normalize()` gives them. These values
/// stay in memory or in the sealed cache; the scene journal never stores them.
struct HubStateDTO: Codable, Equatable, Sendable {
    static let supportedAPIVersion = 28

    var api: Int
    var hostname: String
    var hosts: [HostDTO]
    var home: String
    var defaultSession: String
    var sessions: [String]
    var windows: [SessionDTO]
    var history: [HistoryItemDTO]
    var presets: [PresetDTO]
    var omarchy: OmarchyStampDTO?
    var focus: FocusDTO?
    var review: ReviewStateDTO?
    /// What this host can do beyond the base API, by name → contract version (`portable`,
    /// `uploads`, …). Nil from a host that predates it: it has none of them.
    var features: [String: Int]?
    /// Scratchpads on the host (`notes` 1): when `cursor` moves, there are changes to pull.
    var notes: NotesStateDTO?
    /// Scheduled work (`jobs` 1): what's next, running, waiting for your decision, uncertain.
    var jobs: JobsStateDTO?

    /// The host offers `name` at `version` or later.
    func supports(_ name: String, version: Int = 1) -> Bool { (features?[name] ?? 0) >= version }

    init(
        api: Int = supportedAPIVersion, hostname: String, hosts: [HostDTO], home: String = "", defaultSession: String = "",
        sessions: [String] = [], windows: [SessionDTO], history: [HistoryItemDTO] = [], presets: [PresetDTO] = [],
        omarchy: OmarchyStampDTO? = nil, focus: FocusDTO? = nil, review: ReviewStateDTO? = nil, features: [String: Int]? = nil, notes: NotesStateDTO? = nil,
        jobs: JobsStateDTO? = nil
    ) {
        self.api = api
        self.hostname = hostname
        self.hosts = hosts
        self.home = home
        self.defaultSession = defaultSession
        self.sessions = sessions
        self.windows = windows
        self.history = history
        self.presets = presets
        self.omarchy = omarchy
        self.focus = focus
        self.review = review
        self.features = features
        self.notes = notes
        self.jobs = jobs
    }

    private enum CodingKeys: String, CodingKey {
        case api, hostname, hosts, home, defaultSession, sessions, windows, history, presets, omarchy, focus, review, features, notes, jobs
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        api = try c.decode(Int.self, forKey: .api)
        hostname = try c.decode(String.self, forKey: .hostname)
        hosts = try c.decodeIfPresent([HostDTO].self, forKey: .hosts) ?? [HostDTO(name: hostname, isSelf: true, online: true)]
        home = try c.decodeIfPresent(String.self, forKey: .home) ?? ""
        defaultSession = try c.decodeIfPresent(String.self, forKey: .defaultSession) ?? ""
        sessions = try c.decodeIfPresent([String].self, forKey: .sessions) ?? []
        windows = try c.decode([SessionDTO].self, forKey: .windows)
        history = try c.decodeIfPresent([HistoryItemDTO].self, forKey: .history) ?? []
        presets = try c.decodeIfPresent([PresetDTO].self, forKey: .presets) ?? []
        omarchy = try c.decodeIfPresent(OmarchyStampDTO.self, forKey: .omarchy)
        focus = try c.decodeIfPresent(FocusDTO.self, forKey: .focus)
        review = try c.decodeIfPresent(ReviewStateDTO.self, forKey: .review)
        features = try? c.decodeIfPresent([String: Int].self, forKey: .features)
        notes = try? c.decodeIfPresent(NotesStateDTO.self, forKey: .notes)
        jobs = try? c.decodeIfPresent(JobsStateDTO.self, forKey: .jobs)
    }

    func validate() throws {
        guard api == Self.supportedAPIVersion else {
            throw StateError.unsupportedAPI(api)
        }
        guard !hostname.isEmpty,
              hosts.allSatisfy({ !$0.name.isEmpty }),
              Set(hosts.map(\.name)).count == hosts.count,
              windows.allSatisfy({ !$0.id.isEmpty && !$0.uid.isEmpty }),
              Set(windows.map(\.uid)).count == windows.count,
              Set(windows.map(\.id)).count == windows.count else {
            throw StateError.invalidIdentity
        }
    }

    enum StateError: Error, Equatable {
        case unsupportedAPI(Int)
        case invalidIdentity
        case snapshotRequired
        case nullRequiredField
    }
}

struct HostDTO: Codable, Equatable, Sendable {
    let name: String
    let isSelf: Bool
    let online: Bool

    private enum CodingKeys: String, CodingKey {
        case name, online
        case isSelf = "self"
    }
}

struct FocusDTO: Codable, Equatable, Sendable {
    /// The client's session key: a uid, or "<host>/<uid>" for a peer's session.
    let key: String
    let device: String
    let client: String
    /// Milliseconds since the epoch (server `Date.now()`).
    let at: Double
}

struct OmarchyStampDTO: Codable, Equatable, Sendable {
    let name: String
    let at: Double
    let font: String?
}

struct AttachedTerminalDTO: Codable, Equatable, Sendable {
    let id: String
    let cwd: String
    let command: String
    let busy: Bool
}

struct AttachedTerminalResponse: Decodable, Sendable {
    let terminal: AttachedTerminalDTO?
}

/// The attached terminal's text for the chat (`GET …/terminal/text`, attachedTerminal 2).
struct AttachedTerminalText: Decodable, Equatable, Sendable {
    let terminal: AttachedTerminalDTO?
    let last: LastCommandDTO?
    /// What its screen shows now.
    let screen: String?
}

/// The newest command run in the attached terminal, and what it printed.
struct LastCommandDTO: Decodable, Equatable, Sendable {
    /// What was typed, less the prompt when the host could tell it apart.
    let command: String
    /// The line it was typed on, as the terminal shows it (prompt and all).
    let line: String
    let output: String
    /// Still running: the output so far.
    let running: Bool
    /// Only its last lines.
    let truncated: Bool
}

struct SessionDTO: Codable, Equatable, Sendable {
    let terminal: AttachedTerminalDTO?
    /// Transient tmux address; never use this as the navigation identity.
    let id: String
    let uid: String
    let session: String
    let index: Int
    let name: String
    let title: String
    let agent: String?
    let harnessId: String?
    let model: String?
    let statusSource: StatusSource
    let command: String
    let cwd: String
    let project: String
    let projectPath: String
    let branch: String?
    let worktree: Bool
    let status: Status
    let detail: String?
    let limit: String?
    let ask: AskDTO?
    let answerable: Bool
    /// The prompt it waits on, as the host's opaque fingerprint; nil when not waiting, or
    /// from a host that predates it. One-tap answers carry it so a changed prompt refuses them.
    let askId: String?
    let viewers: Int
    let devices: [String]
    let activity: Double
    let createdAt: Double
    let panes: Int
    let pinned: Bool
    let queued: Int
    let order: Double?
    let launch: String?
    let launchModel: String?
    let launchEffort: String?
    let launchMode: String?
    let feed: String?
    let fork: ForkLineage?
    /// The last thing said in its conversation: the agent's reply, or your message while it
    /// works on it (plain words, clipped). Nil from a host that predates it, or before its
    /// transcript has been read.
    let reply: Reply?
    /// Where its conversation came from, when the host carried it over from another agent
    /// or session (`server/portable`). Nil from a host that predates it.
    let continued: ContinuedLineage?
    /// The agents its agent spawned, counted over the whole tree (`features.subagents`). Nil
    /// for an agent the host reads none of (a shell, another harness), or from an older host;
    /// zeros until it spawns one.
    let subagents: SubagentSummaryDTO?

    // Unknown values fail decoding, rather than inventing an idle/safe state.
    enum Status: String, Codable, Sendable {
        case busy, idle, waiting, attention
    }

    enum StatusSource: String, Codable, Sendable {
        case hook, screen, activity
    }

    struct Reply: Codable, Equatable, Sendable {
        /// "assistant" or "user"; anything else reads as the agent's.
        let role: String
        let text: String
        let at: Double
        var isYours: Bool { role == "user" }
    }

    struct ForkLineage: Codable, Equatable, Sendable {
        let parentUid: String
        let parentTitle: String
        let rootUid: String
        let forks: Int
    }

    private enum CodingKeys: String, CodingKey {
        case terminal
        case id, uid, session, index, name, title, agent, harnessId, model, statusSource, command, cwd, project, projectPath
        case branch, worktree, status, detail, limit, ask, answerable, askId, viewers, devices, activity, createdAt, panes, pinned
        case queued, order, launch, launchModel, launchEffort, launchMode, feed, fork, reply, continued, subagents
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        terminal = try c.decodeIfPresent(AttachedTerminalDTO.self, forKey: .terminal)
        id = try c.decode(String.self, forKey: .id)
        uid = try c.decode(String.self, forKey: .uid)
        session = try c.decodeIfPresent(String.self, forKey: .session) ?? ""
        index = try c.decodeIfPresent(Int.self, forKey: .index) ?? 0
        name = try c.decode(String.self, forKey: .name)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? name
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        harnessId = try c.decodeIfPresent(String.self, forKey: .harnessId)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        statusSource = try c.decode(StatusSource.self, forKey: .statusSource)
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        project = try c.decode(String.self, forKey: .project)
        projectPath = try c.decode(String.self, forKey: .projectPath)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        worktree = try c.decodeIfPresent(Bool.self, forKey: .worktree) ?? false
        status = try c.decode(Status.self, forKey: .status)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        limit = try c.decodeIfPresent(String.self, forKey: .limit)
        ask = try c.decodeIfPresent(AskDTO.self, forKey: .ask)
        answerable = try c.decodeIfPresent(Bool.self, forKey: .answerable) ?? false
        askId = try c.decodeIfPresent(String.self, forKey: .askId)
        viewers = try c.decodeIfPresent(Int.self, forKey: .viewers) ?? 0
        devices = try c.decodeIfPresent([String].self, forKey: .devices) ?? []
        activity = try c.decodeIfPresent(Double.self, forKey: .activity) ?? 0
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        panes = try c.decodeIfPresent(Int.self, forKey: .panes) ?? 1
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        queued = try c.decodeIfPresent(Int.self, forKey: .queued) ?? 0
        order = try c.decodeIfPresent(Double.self, forKey: .order)
        launch = try c.decodeIfPresent(String.self, forKey: .launch)
        launchModel = try c.decodeIfPresent(String.self, forKey: .launchModel)
        launchEffort = try c.decodeIfPresent(String.self, forKey: .launchEffort)
        launchMode = try c.decodeIfPresent(String.self, forKey: .launchMode)
        feed = try c.decodeIfPresent(String.self, forKey: .feed)
        fork = try c.decodeIfPresent(ForkLineage.self, forKey: .fork)
        // A reply this build can't read is left out, never the whole session.
        reply = try? c.decodeIfPresent(Reply.self, forKey: .reply)
        continued = try? c.decodeIfPresent(ContinuedLineage.self, forKey: .continued)
        subagents = try? c.decodeIfPresent(SubagentSummaryDTO.self, forKey: .subagents)
    }
}

struct AskDTO: Codable, Equatable, Sendable {
    let kind: Kind
    let text: String
    let questions: [Question]?
    let options: [ScreenOption]?
    let dialog: Dialog?
    /// The agent's startup folder-trust prompt; `accept` is the option that trusts the folder.
    /// A message sent meanwhile waits in the queue until the prompt is answered.
    var trust: Trust? = nil
    /// A screen in front of the agent's prompt (`server/agentgate.ts`): its trust question, a
    /// sign-in, setup. A message sent meanwhile waits in the queue until it's answered.
    var gate: Gate? = nil

    struct Trust: Codable, Equatable, Sendable { let accept: String }

    struct Gate: Codable, Equatable, Sendable {
        /// "trust", "signin" or "setup"; a kind this build doesn't know reads as setup.
        let kind: String
        /// Links on the screen, whole.
        var links: [String]? = nil
        /// A one-time code to enter on another page.
        var code: String? = nil
        /// It takes typed text (a code pasted back, an API key): the line that asks for it.
        var input: String? = nil
        /// Its sign-in link hands back to 127.0.0.1 on the agent's host: only a browser there finishes it.
        var local: Bool? = nil
        /// Where that link hands back to ("http://127.0.0.1:1455/auth/callback"): the address a
        /// browser here stops on, pasted back, lets the host finish the sign-in.
        var callback: String? = nil
        /// Esc goes back a step, as the screen says.
        var back: Bool? = nil
    }

    enum Kind: String, Codable, Sendable {
        case command, tool, question, screen, choice
    }

    struct Question: Codable, Equatable, Sendable {
        let question: String
        let header: String?
        let multiSelect: Bool
        let options: [Option]

        /// Options with previews: Claude Code shows the highlighted one's beside them, takes
        /// notes on the pick, and has no free-text answer.
        var hasPreviews: Bool { options.contains { $0.preview != nil } }
    }

    struct Option: Codable, Equatable, Sendable {
        let label: String
        let description: String?
        let checked: Bool?
        /// What the option looks like (a mockup, a snippet), shown beside the options.
        var preview: String? = nil
    }

    struct ScreenOption: Codable, Equatable, Sendable {
        let key: String
        let label: String
        /// The line under the row ("Sign in from another device with a one-time code").
        var description: String? = nil
    }

    struct Dialog: Codable, Equatable, Sendable {
        let question: String
        let multiSelect: Bool
        let options: [Option]
        let total: Int
        let answered: Int
        /// Drawn with previews; only the option under the dialog's cursor carries its own.
        var previews: Bool? = nil
    }
}

/// An ended or discovered conversation (`server/sessions.ts` HistoryItem).
struct HistoryItemDTO: Codable, Equatable, Sendable {
    /// Registry id for sessions ah ran, `harness:harnessId` for discovered ones.
    let ref: String
    let kind: Kind
    let harness: String
    let harnessId: String?
    let title: String
    let cwd: String
    let project: String
    let model: String?
    /// Seconds since the epoch.
    let at: Double
    let pinned: Bool
    let worktree: String?
    let fork: Lineage?
    /// Where its conversation came from, when the host carried it over (`server/portable`).
    var continued: ContinuedLineage? = nil

    enum Kind: String, Codable, Sendable { case ended, saved }
    struct Lineage: Codable, Equatable, Sendable { let parentTitle: String }

    private enum CodingKeys: String, CodingKey { case ref, kind, harness, harnessId, title, cwd, project, model, at, pinned, worktree, fork, continued }

    init(ref: String, kind: Kind, harness: String, harnessId: String?, title: String, cwd: String, project: String, model: String?, at: Double, pinned: Bool, worktree: String?, fork: Lineage?) {
        self.ref = ref
        self.kind = kind
        self.harness = harness
        self.harnessId = harnessId
        self.title = title
        self.cwd = cwd
        self.project = project
        self.model = model
        self.at = at
        self.pinned = pinned
        self.worktree = worktree
        self.fork = fork
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = try c.decode(String.self, forKey: .ref)
        kind = try c.decode(Kind.self, forKey: .kind)
        harness = try c.decode(String.self, forKey: .harness)
        harnessId = try c.decodeIfPresent(String.self, forKey: .harnessId)
        title = try c.decode(String.self, forKey: .title)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        project = try c.decodeIfPresent(String.self, forKey: .project) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model)
        at = try c.decodeIfPresent(Double.self, forKey: .at) ?? 0
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        worktree = try c.decodeIfPresent(String.self, forKey: .worktree)
        fork = try c.decodeIfPresent(Lineage.self, forKey: .fork)
        continued = try? c.decodeIfPresent(ContinuedLineage.self, forKey: .continued)
    }
}

/// An agent this host can launch (`web/api.ts` Preset), as its installed CLI describes it.
struct PresetDTO: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let command: String
    let resume: String?
    let modes: [Choice]?
    let models: [Model]?
    let effort: Effort?
    let defaultModel: String?
    let defaultEffort: String?
    let switchModel: String?
    let switchEffort: String?
    let resetModel: String?
    let resetEffort: String?
    let modeCycle: ModeCycle?
    /// Present when the agent takes a model flag at launch (relaunch can change it).
    let modelArgs: [String]?
    /// Commands that open the agent's own pickers in its terminal.
    let settingsCommands: SettingsCommands?
    let feed: String?
    let available: Bool
    let hidden: Bool?
    /// The agent opens on a folder-trust prompt in a new folder, which the host can accept for you.
    var trust: Trust? = nil

    struct Trust: Codable, Equatable, Sendable { let pattern: String; let accept: String }

    struct Choice: Codable, Equatable, Sendable {
        let id: String
        let name: String
        let dangerous: Bool?
        let description: String?
    }

    struct Model: Codable, Equatable, Sendable {
        let id: String
        let name: String
        let description: String?
        let efforts: [String]?
        let isDefault: Bool?
    }

    struct Effort: Codable, Equatable, Sendable { let levels: [String] }
    struct ModeCycle: Codable, Equatable, Sendable { let key: String }
    struct SettingsCommands: Codable, Equatable, Sendable { let model: String?; let effort: String?; let mode: String? }

    var isShell: Bool { command.trimmingCharacters(in: .whitespaces).isEmpty }
    /// Shown in New session: installed and not hidden on this host.
    var offered: Bool { available && hidden != true }
}

/// Stack review on this host, as the state stream carries it (`web/api.ts` ReviewState).
struct ReviewStateDTO: Codable, Equatable, Sendable {
    let alerts: [Alert]
    let fixing: [Fixing]
    let branches: [Branch]
    let sessions: [SessionLink]?

    var sessionLinks: [SessionLink] { sessions ?? [] }

    struct Alert: Codable, Equatable, Sendable {
        let kind: Kind
        let stackId: String
        let stackTitle: String
        let pr: Int
        let role: String
        let title: String
        let at: Double

        enum Kind: String, Codable, Sendable { case rereview, nopush, ready, restack }
    }

    struct Fixing: Codable, Equatable, Sendable {
        let uid: String
        let stackId: String
        let pr: Int
        let role: String
        let count: Int
        let merge: Bool?
    }

    struct Branch: Codable, Equatable, Sendable {
        let repo: String
        let branch: String
        let stackId: String
        let pr: Int
        let role: String
        let stackTitle: String
    }

    struct SessionLink: Codable, Equatable, Sendable {
        let uid: String
        let key: String
        let stackId: String
        let stackTitle: String
        let pr: Int?
        let role: String
        let relation: String
        let status: String?
        let openFindings: Int
        let readyToMerge: Bool
        let needsYou: Int
    }
}
