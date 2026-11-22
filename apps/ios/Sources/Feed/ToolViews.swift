import Foundation

/// What each tool call looks like in the GUI (`apps/server/web/gui/tools.tsx`): a router from
/// tool name to a view kind, its verbs and its one-line summary. The UI layer renders
/// `ToolPresentation`; adding a view is adding a case here.
enum ToolKind: Equatable, Sendable {
    case shell, edit, write, patch, read, search, web, webSearch, webExtract, todos, question, plan, agent, generic

    init(name: String) {
        switch name {
        case "Bash", "shell", "exec", "exec_command", "local_shell", "run_terminal_command", "run_shell_command", "run_command", "bash", "terminal": self = .shell
        case "Edit", "MultiEdit", "NotebookEdit", "search_replace", "replace", "edit", "edit_file", "replace_file_content": self = .edit
        case "Write", "write_file", "write": self = .write
        case "apply_patch": self = .patch
        case "Read", "read_file", "view_file", "read": self = .read
        case "Grep", "Glob", "grep", "grep_search", "glob", "search_files", "find_by_name": self = .search
        case "WebFetch", "web_fetch", "read_url_content": self = .web
        case "WebSearch", "web_search", "search_web": self = .webSearch
        case "web_extract": self = .webExtract
        case "TodoWrite", "update_plan": self = .todos
        case "AskUserQuestion": self = .question
        case "ExitPlanMode", "exit_plan_mode": self = .plan
        case "Task", "Agent": self = .agent
        default: self = .generic
        }
    }

    /// What the agent did ("Ran"), and the present form while it has no result ("Run").
    var verbs: (done: String, now: String?) {
        switch self {
        case .shell: return ("Ran", "Run")
        case .edit: return ("Edited", "Edit")
        case .write: return ("Wrote", "Write")
        case .patch: return ("Patched", "Patch")
        case .read: return ("Read", nil)
        case .search: return ("Searched", "Search")
        case .web, .webExtract: return ("Fetched", "Fetch")
        case .webSearch: return ("Searched the web", "Fetch")
        case .todos: return ("Updated the plan", "Update the plan")
        case .question: return ("Asked", nil)
        case .plan: return ("Proposed a plan", "Propose a plan")
        case .agent: return ("Delegated", "Delegate")
        case .generic: return ("", nil)
        }
    }

    /// Its one-line summary names a file: cut from the middle, keeping the file's name.
    /// Anything else (a command, a question, a query) reads from the start, cut at the end.
    var summaryIsPath: Bool { self == .edit || self == .write || self == .patch || self == .read }

    /// Expanded without a tap: plans and questions are the point of the call.
    var opensByDefault: Bool { self == .todos || self == .question || self == .plan }
    /// Folds once answered: an answered question (or an approved plan) reads fine as one line.
    var foldsWhenDone: Bool { self == .question || self == .plan }
}

enum ToolStatus: String, Equatable, Sendable {
    /// A permission prompt is asking about this call right now.
    case awaiting
    /// No result, and the turn is over: denied or interrupted.
    case stopped
    case running, error, done

    var accessibilityLabel: String {
        switch self {
        case .awaiting: return "Waiting for you"
        case .stopped: return "No result"
        case .running: return "Running"
        case .error: return "Failed"
        case .done: return "Completed"
        }
    }
}

struct ChecklistItem: Equatable, Sendable, Hashable {
    enum State: String, Sendable { case done, active, todo }
    let text: String
    let state: State
}

/// The expanded content of one call, as data.
enum ToolBody: Equatable, Sendable {
    case shell(command: String, description: String?, output: ToolResult?)
    case fileDiff(path: String, lines: [DiffLine], error: ToolResult?)
    case patch(lines: [DiffLine], error: ToolResult?)
    case file(path: String, output: ToolResult?)
    case search(scope: String?, output: ToolResult?)
    case web(url: String?, prompt: String?, output: ToolResult?)
    case checklist([ChecklistItem])
    case questions([AnsweredQuestion], waiting: Bool)
    /// A plan put up for approval (Claude's plan mode), as Markdown.
    case plan(String)
    case delegated(prompt: String?, result: String?)
    case generic(arguments: String?, output: ToolResult?)
}

struct AnsweredQuestion: Equatable, Sendable, Hashable {
    let question: String
    let choices: [String]
    let descriptions: [String?]
    let answer: String?

    /// The answer may name several options ("A, B").
    func picked(_ label: String) -> Bool {
        answer?.components(separatedBy: ", ").contains(label) ?? false
    }
}

struct ToolPresentation: Equatable, Sendable {
    let kind: ToolKind
    let label: String
    let summary: String
    let status: ToolStatus
    let truncated: Bool
    private let call: ToolCall
    private let result: ToolResult?

    /// What the card shows opened, worked out only when it's asked for: a diff of the edit, the
    /// file written, the arguments laid out. Every card was built again on each update, open
    /// or not, and an edit's line diff cost milliseconds.
    var body: ToolBody { ToolPresentation.body(kind: kind, call: call, result: result) }
    /// The call's own id: a Delegate card's subagent is found by it (`SubagentNodeDTO.toolCallId`).
    var callId: String { call.id }

    /// `awaiting`: the call a permission prompt asks about; `turnLive`: the session still works or waits.
    init(call: ToolCall, result: ToolResult?, awaiting: Bool = false, turnLive: Bool = true) {
        let kind = ToolKind(name: call.name)
        self.kind = kind
        let running = result == nil
        let verbs = kind.verbs
        let shown = (running ? verbs.now : nil) ?? verbs.done
        label = shown.isEmpty ? ToolPresentation.displayName(call.name) : shown
        summary = ToolPresentation.summary(kind: kind, call: call, result: result)
        if running {
            status = awaiting ? .awaiting : (turnLive ? .running : .stopped)
        } else {
            status = result!.isError ? .error : .done
        }
        truncated = result?.truncated ?? false
        self.call = call
        self.result = result
    }

    /// `mcp__server__tool` → "tool (server)".
    static func displayName(_ name: String) -> String {
        guard name.hasPrefix("mcp__") else { return name }
        let rest = name.dropFirst(5)
        guard let split = rest.range(of: "__") else { return name }
        return "\(rest[split.upperBound...]) (\(rest[..<split.lowerBound]))"
    }

    static func base(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    static func firstLine(_ text: String, max: Int = 120) -> String {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return line.count > max ? String(line.prefix(max - 1)) + "…" : line
    }

    private static func pathArg(_ call: ToolCall) -> String { (call["file_path"] ?? call["path"]).text }

    static func summary(kind: ToolKind, call: ToolCall, result: ToolResult?) -> String {
        switch kind {
        case .shell: return firstLine((call["command"] ?? call["cmd"] ?? call["input"]).text)
        case .edit, .write, .read: return base(pathArg(call))
        case .patch:
            let files = DiffParser.patchLines((call["input"] ?? call["patch"]).text).filter { $0.kind == .file }.map { base($0.text) }
            return files.isEmpty ? "files" : files.joined(separator: ", ")
        case .search: return (call["pattern"] ?? call["query"]).text
        case .web: return (call["url"] ?? call["query"]).text
        case .webSearch: return call["query"].text
        case .webExtract: return call["urls"]?.array?.map(\.text).joined(separator: ", ") ?? call["url"].text
        case .todos:
            guard let items = (call["todos"] ?? call["plan"])?.array else { return "" }
            let done = items.count { $0["status"]?.string == "completed" }
            return "\(done)/\(items.count) done"
        case .question:
            let first = firstLine(call["questions"]?[0]?["question"].text ?? "", max: 80)
            let answers = (result?.data?["answers"]?.object ?? [:]).sorted { $0.key < $1.key }.map(\.value.text)
            return answers.isEmpty ? first : "\(first) → \(answers.joined(separator: " · "))"
        case .agent: return (call["description"] ?? call["subagent_type"]).text
        case .plan:
            // Its title: the first heading, else its first line.
            let plan = call["plan"].text
            let lines = plan.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            let heading = lines.first { $0.hasPrefix("#") }.map { $0.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces) }
            return firstLine(heading ?? lines.first ?? "", max: 80)
        case .generic:
            // The first string argument; keys in a stable order since JSON objects have none here.
            let preferred = ["command", "file_path", "path", "query", "pattern", "url", "description", "prompt", "input"]
            let value = preferred.compactMap { call[$0]?.string }.first
                ?? call.args.keys.sorted().compactMap { call[$0]?.string }.first
            return firstLine(value ?? "", max: 80)
        }
    }

    static func body(kind: ToolKind, call: ToolCall, result: ToolResult?) -> ToolBody {
        let failure = result?.isError == true ? result : nil
        switch kind {
        case .shell:
            let description = call["description"].text
            return .shell(command: (call["command"] ?? call["cmd"] ?? call["input"]).text, description: description.isEmpty ? nil : description, output: result)
        case .edit:
            let lines = DiffParser.structuredLines(result?.data?["structuredPatch"])
                ?? DiffParser.replaceLines(before: call["old_string"].text, after: call["new_string"].text)
            return .fileDiff(path: pathArg(call), lines: lines, error: failure)
        case .write:
            let lines = DiffParser.structuredLines(result?.data?["structuredPatch"]) ?? DiffParser.replaceLines(before: "", after: call["content"].text)
            return .fileDiff(path: pathArg(call), lines: lines, error: failure)
        case .patch:
            return .patch(lines: DiffParser.patchLines((call["input"] ?? call["patch"]).text), error: failure)
        case .read:
            return .file(path: pathArg(call), output: result)
        case .search:
            let scope = call["path"].text
            return .search(scope: scope.isEmpty ? nil : scope, output: result)
        case .web, .webSearch, .webExtract:
            let url = call["url"].text
            let prompt = call["prompt"].text
            return .web(url: url.isEmpty ? nil : url, prompt: prompt.isEmpty ? nil : prompt, output: result)
        case .todos:
            let items = (call["todos"] ?? call["plan"])?.array ?? []
            return .checklist(items.map { item in
                let status = item["status"]?.string
                let text = status == "in_progress" ? (item["activeForm"] ?? item["content"] ?? item["step"]).text : (item["content"] ?? item["step"]).text
                return ChecklistItem(text: text, state: status == "completed" ? .done : status == "in_progress" ? .active : .todo)
            })
        case .question:
            let answers = result?.data?["answers"]?.object ?? [:]
            let questions = (call["questions"]?.array ?? []).map { q in
                let options = q["options"]?.array ?? []
                let question = q["question"].text
                return AnsweredQuestion(
                    question: question,
                    choices: options.map { $0["label"].text },
                    descriptions: options.map { $0["description"]?.string },
                    answer: answers[question].map(\.text)
                )
            }
            return .questions(questions, waiting: result == nil)
        case .plan:
            return .plan(call["plan"].text)
        case .agent:
            let prompt = call["prompt"].text
            return .delegated(prompt: prompt.isEmpty ? nil : prompt, result: result?.text)
        case .generic:
            return .generic(arguments: call.args.isEmpty ? nil : JSONValue.object(call.args).json(pretty: true), output: result)
        }
    }
}

/// A run of consecutive calls: shown as its last few (the rest a tap away), or, with
/// steps hidden, as one line unless something in it is asking you.
struct ToolGroupSummary: Equatable, Sendable {
    static let keep = 3
    let count: Int
    let running: Bool
    let failed: Int
    let asking: Bool

    init(calls: [ToolCall], results: [String: ToolResult], awaitingCall: String?, turnLive: Bool) {
        count = calls.count
        running = turnLive && calls.contains { results[$0.id] == nil }
        failed = calls.count { results[$0.id]?.isError == true }
        asking = calls.contains { call in
            call.id == awaitingCall || (ToolKind(name: call.name) == .question && results[call.id] == nil && turnLive)
        }
    }

    /// "4 steps · 1 failed".
    var foldedLabel: String {
        var text = "\(count) step\(count == 1 ? "" : "s")"
        if failed > 0 { text += " · \(failed) failed" }
        return text
    }

    static func hiddenCount(total: Int, showAll: Bool) -> Int {
        showAll ? 0 : max(0, total - keep)
    }
}
