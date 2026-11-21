import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Run in Terminal: what a snippet types, and which shell takes it.

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
