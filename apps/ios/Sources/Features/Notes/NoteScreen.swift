import SwiftUI
import UIKit

/// A note (scratchpad) where a session would be: a pane, the iPad's detail, a phone's pushed
/// page. Its Markdown fills it, typed or dictated, saved as you go; the bar under it hands it
/// on (to an agent, a new session, a file). No agent, model, queue or terminal is shown: there
/// is none.
struct NoteScreen: View {
    let scene: SceneModel
    let key: String
    var compactHeader = false
    var paneFocused = true
    var pane: LayoutNode.Path? = nil
    /// On a phone the navigation bar has the title and the menu.
    var inNavigationBar = false
    @Environment(\.theme) private var theme
    @State private var previewURL: URL?
    @State private var previewItems: [URL] = []
    @State private var textBottom: CGFloat = 0
    @State private var barTop: CGFloat = 0

    /// How much of the text's foot the floating bar covers: the text scrolls up past it.
    private var floor: CGFloat { max(0, textBottom - barTop) }

    private var notes: NotesModel { scene.notes }
    private var id: String? { NoteKey.id(notes.current(key)) }

    var body: some View {
        Group {
            if let id, let summary = notes.summary(id), let doc = notes.document(id) {
                content(id: id, summary: summary, doc: doc)
            } else {
                EmptyState(symbol: "note.text", title: "This Note Is Gone", message: "It was deleted, here or on another device.",
                           action: (title: "Close", run: {
                               // This pane, not whichever has the focus.
                               if let pane { scene.workspace.focus(pane); scene.perform("close-pane") } else { scene.closeSession() }
                           }))
            }
        }
        .background(theme.surface)
        .onAppear { scene.followNote(key) }
        .onChange(of: notes.successors) { scene.followNote(key) }
    }

    private func content(id: String, summary: NotesModel.Summary, doc: NoteDocument) -> some View {
        VStack(spacing: 0) {
            if !inNavigationBar {
                NoteHeader(scene: scene, id: id, summary: summary, doc: doc, compact: compactHeader, pane: pane)
            }
            if summary.sync == .conflict { NoteConflictBar(scene: scene, id: id) }
            // The text and its bar stand on the keyboard themselves (the session screens'
            // hosts leave the keyboard out of SwiftUI's safe area).
            AboveKeyboard {
                // The bar floats over the text, as Notes' does: the text runs to the screen's
                // edge, under the bar's glass, and scrolls clear of it.
                ZStack(alignment: .bottom) {
                    VStack(spacing: 0) {
                        if doc.preview {
                            NotePreview(markdown: doc.markdown, floor: floor) { doc.preview = false }
                        } else {
                            // What it carries (SCR-7): tiles over the words, as in a session's box.
                            if !doc.box.attachments.isEmpty {
                                AttachmentTiles(composer: doc.box)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 14)
                                    .padding(.top, 10)
                                    .accessibilityElement(children: .contain)
                                    .accessibilityIdentifier("note-attachments")
                            }
                            NoteEditor(scene: scene, key: NoteKey.key(id), doc: doc, takesMedia: doc.api != nil, floor: floor)
                        }
                    }
                    .ignoresSafeArea(.container, edges: .bottom)
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { textBottom = $0 }
                    VStack(spacing: 6) {
                        // The files @ lists, just over the bar (and the keyboard, while it's up).
                        if !doc.preview, !doc.box.suggestions.isEmpty {
                            SuggestionList(items: doc.box.suggestions, index: doc.box.suggestionIndex) { doc.box.accept($0) }
                                .frame(maxWidth: 560)
                                .padding(.horizontal, 10)
                        }
                        NoteBar(scene: scene, id: id, doc: doc)
                            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { barTop = $0 }
                    }
                }
            }
        }
        // Its pictures and files load from its host, and open in Quick Look.
        .environment(\.hostFiles, doc.files.map { files in
            HostFiles(
                load: { [api = doc.api] path in try? await api?.file(path) },
                open: { path in await preview(path, files: files) },
                browse: { sources, index in await browse(sources, at: index, files: files) },
                kept: files,
                mentions: doc.box.mentionLookup)
        })
        .quickLook($previewURL, in: previewItems)
        .task(id: ObjectIdentifier(doc)) { await doc.dictation.refresh() }
        .onDisappear {
            // Leaving it isn't deleting it: what was typed is kept, a dictation finishes into it,
            // and a recording waiting for Try Again is still there when it's opened again.
            doc.dictation.leave(into: doc.box)
            notes.flush()
        }
        .onChange(of: doc.box.events.count) {
            for event in doc.box.takeEvents() {
                switch event {
                case .notice(let text): scene.toast(text)
                case .failed(let text): scene.toast(text, error: true)
                default: break
                }
            }
        }
        .onChange(of: notes.notices) {
            for text in notes.takeNotices() { scene.toast(text) }
        }
    }

    private func preview(_ source: String, files: HostFileStore) async {
        guard let url = await files.local(source) else {
            QuickLookOrigin.set(nil)
            scene.toast("Couldn’t open \(Uploads.stripTimestamp((source as NSString).lastPathComponent))", error: true)
            return
        }
        previewItems = [url]
        previewURL = url
    }

    /// The note's pictures in Quick Look together, at the one tapped (as a message's are).
    private func browse(_ sources: [String], at index: Int, files: HostFileStore) async {
        guard sources.indices.contains(index) else { return }
        let found = await withTaskGroup(of: (Int, URL?).self) { group in
            for (i, source) in sources.enumerated() { group.addTask { (i, await files.local(source)) } }
            var found: [Int: URL] = [:]
            for await (i, url) in group { found[i] = url }
            return found
        }
        guard let tapped = found[index] else { return await preview(sources[index], files: files) }
        previewItems = sources.indices.compactMap { found[$0] }
        previewURL = tapped
    }

    /// The words under the title: where it's filed and how it syncs.
    static func place(_ summary: NotesModel.Summary, scene: SceneModel) -> String {
        [summary.project.map(\.name), syncWords(summary, scene: scene)].compactMap { $0 }.joined(separator: " · ")
    }

    /// Where what's typed is kept, said plainly: it's saved as it's typed, not on leaving.
    static func savedWords(_ summary: NotesModel.Summary) -> String {
        summary.project.map { "Saved to \($0.name)" } ?? "Saved"
    }

    static func syncWords(_ summary: NotesModel.Summary, scene: SceneModel) -> String {
        let host = summary.syncOrigin.flatMap { scene.app.account(origin: $0)?.hostname } ?? "your host"
        switch summary.sync {
        case .local: return "On this device only"
        case .pending: return "Not synced yet"
        case .synced: return "Synced with \(host)"
        case .conflict: return "Changed on another device too"
        case .unsupported: return "\(host) can’t keep notes yet"
        case .refused(let why): return "Not synced: \(why)"
        }
    }

    static func syncSymbol(_ state: NotesModel.SyncState) -> String {
        switch state {
        case .local: return "iphone"
        case .pending: return "arrow.triangle.2.circlepath"
        case .synced: return "checkmark.icloud"
        case .conflict: return "exclamationmark.triangle"
        case .unsupported, .refused: return "icloud.slash"
        }
    }
}

/// The title (tap to rename), where it's filed, how it syncs, Edit/Preview and the menu.
private struct NoteHeader: View {
    let scene: SceneModel
    let id: String
    let summary: NotesModel.Summary
    let doc: NoteDocument
    let compact: Bool
    let pane: LayoutNode.Path?
    @Environment(\.theme) private var theme
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var renameFocused: Bool
    @State private var name = ""

    private var showsSidebarButton: Bool {
        guard !scene.narrow, !scene.workspace.sidebarVisible else { return false }
        guard let pane else { return true }
        return pane.allSatisfy { $0 == .first }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if showsSidebarButton {
                    Button { scene.perform("toggle-sidebar") } label: { Image(systemName: "sidebar.left").headerGlyph() }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Show Sidebar")
                }
                Image(systemName: "note.text")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(theme.accent)
                    .frame(width: 24)
                    .modifier(PaneDragHandle(pane: pane))
                    .accessibilityHidden(true)
                if scene.renamingNote == id {
                    TextField("Title", text: $name)
                        .font(.ah(.headline))
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(theme.tile, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(theme.accent.opacity(0.6), lineWidth: 1))
                        .focused($renameFocused)
                        .submitLabel(.done)
                        .onSubmit(commit)
                        .onKeyPress(.escape) {
                            scene.renamingNote = nil
                            return .handled
                        }
                        .onAppear {
                            name = scene.notes.note(id)?.title.isEmpty == false ? summary.title : ""
                            renameFocused = true
                        }
                        .onChange(of: renameFocused) { if !renameFocused { commit() } }
                        .accessibilityIdentifier("note-title-field")
                } else {
                    Text(summary.title)
                        .font(compact ? .ah(.subheadline).weight(.semibold) : .ah(.headline))
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                        .layoutPriority(1)
                        .accessibilityAddTraits(.isHeader)
                        .onTapGesture(count: 2) { scene.renamingNote = id }
                }
                Spacer(minLength: 8)
                Button {
                    doc.preview.toggle()
                } label: {
                    Image(systemName: doc.preview ? "pencil" : "eye").headerGlyph()
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(doc.preview ? "Edit" : "Preview")
                .accessibilityIdentifier("note-preview-toggle")
                Menu {
                    NoteMenuItems(scene: scene, id: id)
                } label: {
                    Image(systemName: "ellipsis").headerGlyph()
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .accessibilityLabel("Note menu")
            }
            Label(NoteScreen.place(summary, scene: scene), systemImage: NoteScreen.syncSymbol(summary.sync))
                .font(.ah(.caption))
                .foregroundStyle(summary.sync == .conflict ? theme.danger : theme.muted)
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
                .padding(.leading, showsSidebarButton ? 68 : 34)
                .accessibilityIdentifier("note-place")
            // The session it went to (SCR-8): opens it while it runs.
            if let went = scene.noteWentTo(summary.wentTo) {
                Group {
                    if let key = went.key {
                        Button { scene.open(key) } label: { Label("In \(went.title)", systemImage: "text.bubble") }
                            .buttonStyle(.plain)
                            .foregroundStyle(theme.accent)
                    } else {
                        Label("Went to \(went.title) · ended", systemImage: "text.bubble").foregroundStyle(theme.muted)
                    }
                }
                .font(.ah(.caption))
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
                .padding(.leading, showsSidebarButton ? 68 : 34)
                .accessibilityIdentifier("note-went")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, compact ? 8 : 12)
    }

    private func commit() {
        guard scene.renamingNote == id else { return }
        scene.notes.rename(id, to: name)
        scene.renamingNote = nil
    }
}

/// The host's version and this device's differ: both are kept until you choose.
private struct NoteConflictBar: View {
    let scene: SceneModel
    let id: String
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(theme.danger)
            Text(scene.notes.note(id)?.conflict?.deleted == true ? "Deleted on another device while you changed it here." : "Changed on another device too. Both versions are kept.")
                .font(.ah(.callout))
                .foregroundStyle(theme.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button("Compare…") { scene.sheet = .noteCompare(id) }.buttonStyle(.glassProminent)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(theme.danger.opacity(0.08))
        .accessibilityElement(children: .combine)
    }
}

/// The Markdown as it reads, through the transcript's renderer: its pictures and files over
/// the words, as a message's are, each a chip where it was put.
private struct NotePreview: View {
    let markdown: String
    /// The floating bar's height over its foot.
    var floor: CGFloat = 0
    let edit: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        var known: [String: String] = [:]
        let shown = NoteText.shown(markdown, known: &known)
        let attachments = shown.uploads.map { Attachment.upload($0.upload) }
        ScrollView {
            Group {
                if markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Nothing written yet.").foregroundStyle(theme.muted)
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        if !attachments.isEmpty { AttachmentStrip(attachments: attachments, alignment: .leading) }
                        MarkdownView(shown.text, uploads: Dictionary(shown.uploads.map { ($0.token, $0.upload.path) }, uniquingKeysWith: { a, _ in a }), gallery: attachments.filter { $0.look != .file }.map(\.source))
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
        .contentMargins(.bottom, floor, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .onTapGesture(count: 2, perform: edit)
        .accessibilityIdentifier("note-preview")
    }
}

/// Over the text's foot, floating as Notes' tools do: the microphone (and ✕ while it listens)
/// in one capsule of glass, what to do with the note in another. No band of its own: the text
/// shows between and under them.
private struct NoteBar: View {
    let scene: SceneModel
    let id: String
    let doc: NoteDocument
    @Environment(\.theme) private var theme
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44

    var body: some View {
        VStack(spacing: 8) {
            if DictationCard.shows(doc.dictation, in: doc.box, wavesElsewhere: true) {
                DictationCard(dictation: doc.dictation, composer: doc.box, waves: false)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }
            GlassEffectContainer {
                HStack(spacing: 8) {
                    tools
                    Spacer(minLength: 4)
                    ViewThatFits(in: .horizontal) {
                        actions(words: true)
                        actions(words: false)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        // A soft edge, as a scroll view has under a toolbar: the words fade out there rather
        // than run into the glass. Down to the screen's edge; it takes no touches.
        .background(alignment: .top) {
            LinearGradient(stops: [.init(color: theme.surface.opacity(0), location: 0), .init(color: theme.surface.opacity(0.85), location: 0.55)],
                           startPoint: .top, endPoint: .bottom)
                .padding(.top, -12)
                .ignoresSafeArea(.container, edges: .bottom)
                .allowsHitTesting(false)
        }
        .animation(.smooth(duration: 0.2), value: doc.dictation.isDictating)
    }

    private var tools: some View {
        HStack(spacing: ButtonGroup.spacing) {
            if doc.dictation.isDictating {
                DictationCancel(dictation: doc.dictation, composer: doc.box).frame(width: control)
            }
            // Pictures and files, uploaded to its host and kept in it (SCR-7).
            if doc.api != nil, !doc.dictation.isDictating {
                AttachMenu(composer: doc.box).frame(width: control).accessibilityIdentifier("note-attach")
            }
            DictationMic(dictation: doc.dictation, composer: doc.box) { if doc.preview { doc.preview = false } }
                .frame(width: control)
            // Beside the microphone, not over the text: they stay as the words go in.
            if doc.dictation.isListening {
                DictationWaves(levels: doc.dictation.levels, count: doc.dictation.levelCount, color: theme.accent)
                    .frame(height: 28)
                    .frame(maxWidth: 180)
                    .padding(.trailing, 10)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, ButtonGroup.inset)
        .frame(minHeight: control + 4)
        .glassEffect(.regular.interactive(), in: Capsule())
    }

    private func actions(words: Bool) -> some View {
        HStack(spacing: words ? 4 : ButtonGroup.spacing) {
            // This bar's note, whichever pane has the focus.
            action("Send", symbol: "paperplane", words: words, id: "note-send") { scene.sheet = .noteSend(id, insert: false) }
            action("New Session", symbol: "plus.square", words: words, id: "note-new-session") { scene.startSession(fromNote: id, attached: false) }
            action("Save as File", symbol: "square.and.arrow.down", words: words, id: "note-save-file") { scene.sheet = .noteSaveFile(id) }
        }
        .padding(.horizontal, words ? 8 : ButtonGroup.inset)
        .frame(minHeight: control + 4)
        .glassEffect(.regular.interactive(), in: Capsule())
    }

    private func action(_ title: String, symbol: String, words: Bool, id: String, run: @escaping () -> Void) -> some View {
        // Not while its words or files are still coming: what goes would be missing them.
        let waiting = doc.dictation.isBusy || doc.box.isUploading
        return Button {
            Haptics.tap()
            run()
        } label: {
            Group {
                if words {
                    Label(title, systemImage: symbol).labelStyle(.titleAndIcon).font(.ah(.subheadline).weight(.medium))
                        .padding(.horizontal, 8)
                        .frame(height: control - 12)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: control * 0.41, weight: .medium))
                        .frame(width: control, height: control - 12)
                }
            }
            .foregroundStyle(waiting ? theme.muted : theme.accent)
            .contentShape(Capsule())
            .contentShape(.hoverEffect, Capsule())
            .hoverEffect(.highlight)
            .touchTarget()
        }
        .buttonStyle(.ahPress)
        .disabled(waiting)
        .accessibilityLabel(title)
        .accessibilityIdentifier(id)
    }
}

/// Everything a note's menu offers: the header's, the phone bar's (`NoteHostController`), a
/// row's long press.
struct NoteMenuItems: View {
    let scene: SceneModel
    let id: String

    var body: some View {
        let items = NoteActions.items(scene: scene, id: id).filter { !$0.isEmpty }
        ForEach(Array(items.enumerated()), id: \.offset) { _, section in
            Section {
                ForEach(section, id: \.title) { item in
                    Button(role: item.destructive ? .destructive : nil) { item.run() } label: { Label(item.title, systemImage: item.symbol) }
                        .disabled(!item.enabled)
                }
            }
        }
    }
}

/// A note's actions, once, for SwiftUI menus and UIKit's.
@MainActor
enum NoteActions {
    struct Item {
        let title: String
        let symbol: String
        var destructive = false
        var enabled = true
        let run: () -> Void
    }

    static func items(scene: SceneModel, id: String) -> [[Item]] {
        let notes = scene.notes
        guard let note = notes.note(id) else { return [] }
        let open = { scene.goTo(note.key) }
        var sync: [Item] = []
        if note.syncOrigin == nil, let origin = scene.accountOrigin {
            let host = scene.app.account(origin: origin)?.hostname ?? "your host"
            sync.append(Item(title: "Sync with \(host)", symbol: "icloud.and.arrow.up") { notes.setSync(id, origin: origin) })
        } else if notes.canKeepLocal(id) {
            sync.append(Item(title: "Keep Only on This Device", symbol: "iphone") { notes.setSync(id, origin: nil) })
        } else {
            sync.append(Item(title: "Duplicate on This Device Only", symbol: "iphone") {
                if let copy = notes.duplicate(id, syncOrigin: .some(nil)) { scene.open(copy.key) }
            })
        }
        // Not while a file it carries is still on its way: what goes would be missing it.
        let ready = !notes.isUploading(id)
        // The session it went to, while it runs (SCR-8).
        let went = scene.noteWentTo(note.sessions.first).flatMap { w in w.key.map { key in Item(title: "Open “\(w.title)”", symbol: "text.bubble") { scene.open(key) } } }
        return [
            went.map { [$0] } ?? [],
            [
                Item(title: "Send to Agent…", symbol: "paperplane", enabled: ready) { open(); scene.sheet = .noteSend(id, insert: false) },
                Item(title: "Put in a Session’s Box…", symbol: "text.insert", enabled: ready) { open(); scene.sheet = .noteSend(id, insert: true) },
                Item(title: "New Session from Note", symbol: "plus.square", enabled: ready) { scene.startSession(fromNote: id, attached: false) },
                Item(title: "New Session with Note Attached", symbol: "doc.badge.plus", enabled: ready) { scene.startSession(fromNote: id, attached: true) },
                Item(title: "Save as File…", symbol: "square.and.arrow.down", enabled: ready) { open(); scene.sheet = .noteSaveFile(id) },
            ],
            [
                Item(title: note.project.map { "Space: \($0.name)…" } ?? "File Under a Space…", symbol: "folder") { open(); scene.sheet = .noteProject(id) },
                Item(title: "Rename…", symbol: "pencil") { open(); scene.renamingNote = id },
            ] + sync,
            [
                Item(title: "Copy Text", symbol: "doc.on.doc") {
                    notes.flushText(id)
                    UIPasteboard.general.string = notes.note(id)?.markdown
                    scene.toast("Copied the note")
                },
                Item(title: "Duplicate", symbol: "plus.square.on.square") { if let copy = notes.duplicate(id) { scene.open(copy.key) } },
                Item(title: "Delete…", symbol: "trash", destructive: true) { scene.sheet = .noteDelete(id) },
            ],
        ]
    }

    static func menu(scene: SceneModel, id: String) -> [UIMenuElement] {
        items(scene: scene, id: id).map { section in
            UIMenu(options: .displayInline, children: section.map { item in
                let action = UIAction(title: item.title, image: UIImage(systemName: item.symbol), attributes: item.destructive ? .destructive : []) { _ in item.run() }
                if !item.enabled { action.attributes.insert(.disabled) }
                return action
            })
        }
    }
}
