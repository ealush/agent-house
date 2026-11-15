import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Run in Terminal: what a snippet types, and which shell takes it.

private func row(_ uid: String, agent: String? = nil, command: String = "zsh", cwd: String = "/p/ah", host: String = "desk", activity: Double = 0) throws -> SessionRow {
    var object: [String: Any] = ["id": "%\(uid)", "uid": uid, "name": uid, "title": uid, "statusSource": "activity", "project": "ah", "projectPath": "/p/ah", "status": "idle", "command": command, "cwd": cwd, "activity": activity]
    if let agent { object["agent"] = agent }
    let dto = try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object))
    return SessionRow(key: host == "desk" ? uid : "\(host)/\(uid)", host: host, isLocal: host == "desk", dto: dto)
}

@Test func codeInNoLanguageOrAShellsRunsAndOtherCodeDoesNot() {
    #expect(ShellRun.runs(language: nil))
    #expect(ShellRun.runs(language: ""))
    #expect(ShellRun.runs(language: "bash"))
    #expect(ShellRun.runs(language: "Shell"))
    #expect(ShellRun.runs(language: "console"))
    #expect(!ShellRun.runs(language: "swift"))
    #expect(!ShellRun.runs(language: "json"))
    #expect(!ShellRun.runs(language: "ts"))
}

@Test func aSnippetLosesThePromptMarksButNotItsCommand() {
    #expect(ShellRun.command("  npm test\n") == "npm test")
    // Claude Code's `!`: in a shell it negates, and `&&` would skip what follows.
    #expect(ShellRun.command("! cd ~/code/ah && git pull") == "cd ~/code/ah && git pull")
    // A prompt before every line is copied with the commands.
    #expect(ShellRun.command("$ cd ah\n$ pnpm build") == "cd ah\npnpm build")
    // Output under a prompted line keeps the lot: which lines to run isn't for us to guess.
    #expect(ShellRun.command("$ ls\nREADME.md") == "$ ls\nREADME.md")
    // `!` inside a command, or `!` with no space, is the shell's own.
    #expect(ShellRun.command("git log --oneline | grep !fix") == "git log --oneline | grep !fix")
    #expect(ShellRun.command("!!") == "!!")
    #expect(ShellRun.command(" \n ").isEmpty)
}

@Test func theShellIsOneAtItsPromptInTheSessionsFolderOnItsHost() throws {
    let session = try row("agent", agent: "claude", command: "claude")
    let older = try row("s1", activity: 10)
    let newer = try row("s2", command: "-zsh", activity: 20)
    let busy = try row("s3", command: "node", activity: 30)
    let elsewhere = try row("s4", cwd: "/p/other", activity: 40)
    let peer = try row("s5", host: "laptop", activity: 50)
    let agent = try row("a2", agent: "codex", command: "codex", activity: 60)
    let rows = [session, older, newer, busy, elsewhere, peer, agent]
    // The one used last of the shells waiting at a prompt in the same folder, on the same host.
    #expect(ShellRun.shell(for: session, among: rows)?.uid == "s2")
    // None waiting: a new one is started.
    #expect(ShellRun.shell(for: session, among: [session, busy, elsewhere, peer, agent]) == nil)
}
