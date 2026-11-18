import Foundation

/// A window's notes (scratchpads): they open, tile, restore and switch like sessions (by key,
/// "note:<id>"), but nothing about them asks a host. What they hand on goes through the same
/// paths a typed message, a draft or New session do.
extension SceneModel {
    var notes: NotesModel { app.notes }

    /// The note in front: the focused pane's, or the one this window shows.
    var focusedNoteID: String? {
        if let key = workspace.focusedKey { return NoteKey.id(notes.current(key)) }
        if case .session(let key) = route { return NoteKey.id(notes.current(key)) }
        return nil
    }

    func noteTitle(_ key: String) -> String? {
        guard let id = NoteKey.id(key) else { return nil }
        return notes.summary(NoteKey.id(notes.current(key)) ?? id)?.title ?? "Note"
    }

    /// Where a new note is filed: the project of the session in front, on its host.
    var projectInFront: NoteProject? {
        if let id = focusedNoteID, let project = notes.note(id)?.project { return project }
        guard let row = focusedSession?.row, !row.dto.projectPath.isEmpty else { return nil }
        return NoteProject(origin: accountOrigin, host: row.host, path: row.dto.projectPath)
    }

    /// A new note, opened with the keyboard in it. It syncs with this window's account (once
    /// its host keeps notes); `local` keeps it on this device only.
    @discardableResult
    func newNote(markdown: String = "", project: NoteProject?? = nil, local: Bool = false) -> String {
        let note = notes.create(markdown: markdown, project: project ?? projectInFront, syncOrigin: local ? nil : accountOrigin)
        open(note.key)
        requestFocus(.composer(note.key))
        return note.key
    }

    /// A journal whose sessions are all notes (or empty panes): it can come back before the
    /// host answers, offline included.
    nonisolated static func onlyNotes(_ snapshot: SceneSnapshot) -> Bool {
        var keys = snapshot.session.map { [$0.key] } ?? []
        if case .session(let key) = snapshot.route { keys.append(key) }
        for slot in snapshot.workspaces.slots.values {
            keys += slot.layout?.leaves().map(\.sessionKey) ?? []
            if let selected = slot.selected { keys.append(selected) }
        }
        return keys.allSatisfy { NoteKey.isNote($0) || LayoutNode.isPick($0) }
    }

    /// A new note in a chooser pane.
    func newNote(into path: LayoutNode.Path) {
        let note = notes.create(project: projectInFront, syncOrigin: accountOrigin)
        fillPane(path, with: note.key)
        requestFocus(.composer(note.key))
    }

    /// A window still showing a note kept under a new id goes to it.
    func followNote(_ key: String) {
        let now = notes.current(key)
        guard now != key else { return }
        workspace.replaceKey(key, with: now)
        if case .session(key) = route { route = .session(now) }
        scheduleSave()
    }

    // MARK: Commands

    /// Whether a note command can run now (nil: not a note command).
    func noteAvailability(_ id: CommandID) -> Bool? {
        switch id.rawValue {
        case "new-note": return true
        // A note has no link on a host to copy or open elsewhere.
        case "copy-link", "share-link", "open-in-new-window": return focusedNoteID == nil ? nil : false
        case "note-preview", "note-save-file", "note-project", "note-duplicate", "note-delete", "note-new-session", "note-new-session-file", "note-send", "note-insert":
            return focusedNoteID.flatMap { notes.note($0) } != nil
        default: return nil
        }
    }

    /// Runs a note command; false when `id` isn't one.
    func executeNote(_ id: CommandID) -> Bool {
        let note = focusedNoteID
        switch id.rawValue {
        case "new-note": newNote()
        case "note-preview": if let note, let doc = notes.document(note) { doc.preview.toggle() }
        case "note-save-file": if let note { sheet = .noteSaveFile(note) }
        case "note-project": if let note { sheet = .noteProject(note) }
        case "note-duplicate": if let note, let copy = notes.duplicate(note) { open(copy.key) }
        case "note-delete": if let note { sheet = .noteDelete(note) }
        case "note-send": if let note { sheet = .noteSend(note, insert: false) }
        case "note-insert": if let note { sheet = .noteSend(note, insert: true) }
        case "note-new-session": if let note { startSession(fromNote: note, attached: false) }
        case "note-new-session-file": if let note { startSession(fromNote: note, attached: true) }
        default: return false
        }
        return true
    }

    /// Deleted (asked first, `Sheet.noteDelete`): its panes ask what goes there instead.
    func deleteNote(_ id: String) {
        let key = NoteKey.key(id)
        notes.delete(id)
        if workspace.layout != nil { workspace.replaceKey(key, with: LayoutNode.pickKey()) }
        if case .session(key) = route { closeSession() } else if workspace.selected == key { workspace.open(nil) }
        pruneSessions()
        scheduleSave()
        toast("Deleted the note")
    }

    // MARK: Handing on

    /// New session (the same screen, every choice still yours) with the note as its first
    /// message, or attached as a Markdown file, in the note's project where this window can
    /// reach it. The note itself isn't touched.
    func startSession(fromNote id: String, attached: Bool) {
        notes.flushText(id)
        guard let note = notes.note(id) else { return }
        var context = NewSessionContext()
        if let project = note.project, project.origin == nil || project.origin == accountOrigin, let hub {
            context.cwd = project.path
            context.host = project.host == hub.hostname ? nil : project.host
        }
        context.label = note.shownTitle
        if attached {
            context.attachment = .init(name: NoteFiles.fileName(for: note), data: Data(note.markdown.utf8))
        } else {
            context.prompt = note.markdown
        }
        beginNewSession(context)
    }

    enum Combine: Sendable { case replace, below, above }

    /// A note put into a box that may hold a draft: only Replace lets the draft go.
    nonisolated static func combined(draft: String, note: String, _ combine: Combine) -> String {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return note }
        switch combine {
        case .replace: return note
        case .below: return draft + "\n\n" + note
        case .above: return note + "\n\n" + draft
        }
    }

    /// What a session's box holds (to ask before putting a note in with it): this window's
    /// box, or, for a session not on screen whose box hasn't read it yet, the draft the host
    /// keeps for it. Nil: the host couldn't say, so ask anyway rather than risk it.
    func existingDraft(_ key: String) async -> String? {
        let here = sessionIfOpen(key)?.composer.text ?? ""
        if !here.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return here }
        guard let hub, let row = hub.row(key) else { return here }
        do {
            return try await hub.client(forKey: key).draft(row.dto.uid)?.text ?? here
        } catch {
            return nil
        }
    }

    /// The whole note in a session's box, to edit and send yourself, combined as asked with
    /// `draft` (what was there). Then that session, with the keyboard in its box.
    func insertNote(_ id: String, into key: String, draft: String, combine: Combine) {
        notes.flushText(id)
        guard let note = notes.note(id), let composer = session(key)?.composer else { return }
        // The box's own text if it has more by now (typed while this was asked).
        let current = composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? draft : composer.text
        let text = Self.combined(draft: current, note: note.markdown, combine)
        composer.text = text
        composer.caret = text.utf16.count
        goTo(key)
        requestFocus(.composer(key))
        toast("The note is in the box; send it when it’s ready")
    }
}

/// What a note is called as a file: its title, made safe ("Session restoration ideas.md").
enum NoteFiles {
    static func fileName(for note: Note) -> String {
        let base = note.shownTitle.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|\n\r\t")).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        return (base.isEmpty ? "Note" : String(base.prefix(80))) + ".md"
    }

    /// A relative path inside a project: no leading slash, `..`, `.`, empty parts or `.git`
    /// (the host refuses these too; asking here says why before anything is sent).
    static func problem(_ path: String) -> String? {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return "Name the file." }
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("~") { return "A path inside the project, not from the top of the disk." }
        if trimmed.contains("\\") { return "Use / between folders." }
        let parts = trimmed.split(separator: "/", omittingEmptySubsequences: false)
        if parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) { return "No empty, . or .. parts in the path." }
        if parts.contains(where: { $0.lowercased() == ".git" }) { return "Not inside .git." }
        return nil
    }
}
