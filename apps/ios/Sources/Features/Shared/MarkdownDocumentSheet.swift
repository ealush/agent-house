import SwiftUI
import UIKit

/// A Markdown file on the host, to read as a page (`markdownDocument`): an agent's review or
/// plan, a README.
struct MarkdownDocument: Identifiable, Hashable, Sendable {
    let path: String
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
}

/// One more thing the page offers beside Copy and Share, where it was opened from (the Files
/// panel's Mention, the Space's Copy Path).
struct MarkdownDocumentAction {
    let title: String
    let systemImage: String
    let run: @MainActor () -> Void
}

extension View {
    /// `document` drawn as the conversation draws Markdown, in a sheet over this, rather than as
    /// Quick Look's plain text. Its pictures load from beside it; a link to another Markdown file
    /// opens it on the page's own stack (Back returns), and any other file opens as one does here.
    func markdownDocument(_ document: Binding<MarkdownDocument?>, extra: MarkdownDocumentAction? = nil, fetch: @escaping @Sendable (String) async throws -> Data) -> some View {
        modifier(MarkdownDocumentPresenter(document: document, extra: extra, fetch: fetch))
    }
}

private struct MarkdownDocumentPresenter: ViewModifier {
    @Binding var document: MarkdownDocument?
    let extra: MarkdownDocumentAction?
    let fetch: @Sendable (String) async throws -> Data
    @Environment(\.hostFiles) private var hostFiles

    func body(content: Content) -> some View {
        content.sheet(item: $document) { document in
            MarkdownDocumentSheet(root: document, extra: extra, outside: hostFiles, fetch: fetch)
        }
    }
}

/// The documents opened from the first, as a navigation stack's path (a link's push), and a
/// file opened in Quick Look from here.
@MainActor
@Observable
private final class DocumentPages {
    var path: [MarkdownDocument] = []
    var previewURL: URL?
}

private struct MarkdownDocumentSheet: View {
    let root: MarkdownDocument
    let extra: MarkdownDocumentAction?
    /// How files open where it was opened from (a video streams, a picture opens among the
    /// message's); none from a panel, whose files open in Quick Look from here.
    let outside: HostFiles?
    let fetch: @Sendable (String) async throws -> Data
    @State private var pages = DocumentPages()

    var body: some View {
        @Bindable var pages = pages
        NavigationStack(path: $pages.path) {
            MarkdownDocumentPage(document: root, extra: extra, closes: true, fetch: fetch)
                .navigationDestination(for: MarkdownDocument.self) { document in
                    MarkdownDocumentPage(document: document, extra: nil, closes: false, fetch: fetch)
                }
        }
        .environment(\.hostFiles, files)
        .quickLook($pages.previewURL)
    }

    /// The page's pictures load from the host; its links open on the page's stack (Markdown) or
    /// as files open where it came from.
    private var files: HostFiles {
        let fetch = fetch, pages = pages, outside = outside
        var files = outside ?? HostFiles(load: { path in try? await fetch(path) })
        files.open = { path in
            if Markdown.isDocument(path) {
                QuickLookOrigin.set(nil)
                pages.path.append(MarkdownDocument(path: path))
            } else if let open = outside?.open {
                await open(path)
            } else if case .inline(let data) = WidgetModel.imageSource(path) {
                // A picture drawn here (a diagram), not fetched.
                pages.previewURL = MarkdownDocumentSheet.temporaryCopy(data, named: "Diagram.png")
            } else if let data = try? await fetch(path) {
                pages.previewURL = MarkdownDocumentSheet.temporaryCopy(data, named: (path as NSString).lastPathComponent)
            }
        }
        // One at a time from here: the page's pictures aren't a message's gallery.
        files.browse = nil
        return files
    }

    private static func temporaryCopy(_ data: Data, named name: String) -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return (try? data.write(to: url, options: [.completeFileProtection])) == nil ? nil : url
    }
}

private struct MarkdownDocumentPage: View {
    let document: MarkdownDocument
    let extra: MarkdownDocumentAction?
    /// The first page closes the sheet; the ones pushed from it go Back.
    let closes: Bool
    let fetch: @Sendable (String) async throws -> Data
    @State private var shown: Shown = .loading
    @State private var source = false
    @State private var copied = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    /// Bigger than this, it's not a page to read here (Share still hands it on).
    static let limit = 4 << 20

    private enum Shown {
        case loading
        case failed(String)
        case read(text: String, blocks: [MarkdownBlock])
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.surface)
            .navigationTitle(document.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if closes {
                    ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                }
                if case .read(let text, _) = shown {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button {
                            withAnimation(.snappy) { source.toggle() }
                        } label: {
                            Label(source ? "Show Formatted" : "Show Source", systemImage: source ? "doc.richtext" : "chevron.left.forwardslash.chevron.right")
                        }
                        .tint(.primary)
                        .accessibilityIdentifier("markdown-document-source")
                        Menu {
                            Button(copied ? "Copied" : "Copy Markdown", systemImage: "doc.on.doc") { copy(text) }
                            ShareLink(item: text, subject: Text(document.name)) { Label("Share…", systemImage: "square.and.arrow.up") }
                            if let extra { Button(extra.title, systemImage: extra.systemImage) { extra.run() } }
                        } label: {
                            Label("More", systemImage: "ellipsis")
                        }
                        .tint(.primary)
                    }
                }
            }
            .task(id: document.path) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch shown {
        case .loading:
            ProgressView().controlSize(.large)
        case .failed(let why):
            ContentUnavailableView("Couldn’t Open \(document.name)", systemImage: "doc.questionmark", description: Text(why))
        case .read(let text, let blocks):
            ScrollView {
                Group {
                    if source {
                        Text(text)
                            .font(.ahMono(.footnote))
                            .foregroundStyle(theme.text)
                            .textSelection(.enabled)
                    } else {
                        // Selectable as a message's words are, with only the system's Copy.
                        MarkdownView(blocks: blocks)
                            .environment(\.textMenu, TextMenu { _ in [] })
                    }
                }
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding()
            }
            .accessibilityIdentifier("markdown-document")
        }
    }

    private func load() async {
        let path = document.path
        do {
            let data = try await fetch(path)
            guard data.count <= Self.limit else {
                shown = .failed("It’s \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)), too big to read here.")
                return
            }
            let text = String(decoding: data, as: UTF8.self)
            let folder = (path as NSString).deletingLastPathComponent
            let blocks = await Task.detached(priority: .userInitiated) { Markdown.resolving(Markdown.parse(text), in: folder) }.value
            shown = .read(text: text, blocks: blocks)
        } catch is CancellationError {
        } catch {
            shown = .failed(APIError.wrap(error).message)
        }
    }

    private func copy(_ text: String) {
        UIPasteboard.general.string = text
        Haptics.success()
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}
