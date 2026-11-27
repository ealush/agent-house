import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@MainActor
private func makeComposer() -> ComposerModel {
    let api = APIClient(
        origin: URL(string: "https://desk.example.ts.net")!,
        transport: URLSessionTransport(),
        credentials: AccountCredentials(token: "t", onRejected: {}),
        device: DeviceDescriptor(name: "iPhone", client: "c1")
    )
    return ComposerModel(api: api, outbox: Outbox(), key: "s1", uid: "s1", isShell: false, draftDebounce: .seconds(3600))
}

@MainActor
@Test func quoteAndReuseChipsKeepTypedDraftCleanAndExpandOnSend() {
    let composer = makeComposer()
    composer.text = "Please simplify this part"

    let quote = composer.addSnippet(kind: .quote, body: "Line one\nLine two")
    #expect(quote != nil)
    // Existing typed draft is untouched and free of raw `>` arrows.
    #expect(composer.text == "Please simplify this part")
    #expect(composer.snippets.count == 1)
    #expect(composer.draftText == "> Line one\n> Line two\n\nPlease simplify this part")

    // Editing a chip updates its body; clearing it removes the chip.
    composer.updateSnippet(quote!.id, body: "Trimmed excerpt")
    #expect(composer.snippets.first?.body == "Trimmed excerpt")
    #expect(composer.draftText == "> Trimmed excerpt\n\nPlease simplify this part")

    composer.updateSnippet(quote!.id, body: "   \n  ")
    #expect(composer.snippets.isEmpty)
    #expect(composer.draftText == "Please simplify this part")
}

@MainActor
@Test func snippetOnlyComposerIsSendableWithoutTypedWords() {
    let composer = makeComposer()
    #expect(composer.isEmpty)
    #expect(!composer.canSend)

    let paste = composer.addSnippet(kind: .paste, body: String(repeating: "a", count: 350))
    #expect(paste != nil)
    #expect(!composer.isEmpty)
    #expect(composer.canSend)
    #expect(composer.text.isEmpty)
    #expect(composer.draftText.count == 350)

    composer.removeSnippet(paste!.id)
    #expect(composer.isEmpty)
}

@Test func largePasteThresholdChipsBigTextWhileKeepingShortPasteInline() {
    let short = "Pasted words that run on long enough to wrap onto a second line in the box."
    #expect(!ComposerModel.shouldChipPaste(short))

    let longByChars = String(repeating: "word ", count: 70) // 350 chars
    #expect(ComposerModel.shouldChipPaste(longByChars))

    let longByLines = (1...9).map { "line \($0)" }.joined(separator: "\n")
    #expect(ComposerModel.shouldChipPaste(longByLines))

    #expect(!ComposerModel.shouldChipPaste("   \n\n  "))
}

@MainActor
@Test func aBoxsMessageIsItsChipsThenItsWords() {
    let composer = makeComposer()
    #expect(composer.message == "")
    composer.addSnippet(kind: .paste, body: "line one\nline two")
    #expect(composer.message == "line one\nline two")
    composer.text = "What does this say?"
    composer.addSnippet(kind: .quote, body: "Quoted")
    // What New session starts with and Review sends: the chips' text first, then the words.
    #expect(composer.message == "line one\nline two\n\n> Quoted\n\nWhat does this say?")
}
