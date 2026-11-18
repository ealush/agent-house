import SwiftUI

/// A note in the session list: its icon, title and where it's filed, in a session row's place,
/// with no status pill (a note never works or waits).
struct NoteRowView: View {
    let note: NotesModel.Summary
    var dense = false
    var showsProject = false
    let open: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: "note.text")
                    .font(.system(size: dense ? 14 : 18, weight: .semibold))
                    .foregroundStyle(theme.accent)
                    .frame(width: dense ? 22 : 32, height: dense ? 22 : 32)
                    .background(theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: dense ? 6 : 8, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(note.title).font(dense ? .ah(.callout) : .ah(.body)).foregroundStyle(theme.text).lineLimit(1)
                    let detail = [showsProject ? note.project?.name : nil, sync].compactMap { $0 }.joined(separator: " · ")
                    if !detail.isEmpty {
                        Text(detail).font(.ah(.caption)).foregroundStyle(note.sync == .conflict ? theme.danger : theme.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Note, \(note.title)")
        .accessibilityIdentifier("note:\(note.title)")
    }

    /// Only what needs saying: a note in step says nothing.
    private var sync: String? {
        switch note.sync {
        case .synced: return nil
        case .local: return "On this device"
        case .pending: return "Not synced yet"
        case .conflict: return "Two versions"
        case .unsupported: return "Host can’t keep notes yet"
        case .refused: return "Not synced"
        }
    }
}

/// A note's long-press menu in a list.
struct NoteRowMenu: View {
    let note: NotesModel.Summary
    let scene: SceneModel

    var body: some View {
        Button("Open", systemImage: "arrow.up.right") { scene.open(note.key) }
        if !scene.narrow { Button("Open as New Pane", systemImage: "plus.rectangle.on.rectangle") { scene.run(.openAsPane(note.key)) } }
        NoteMenuItems(scene: scene, id: note.id)
    }
}
