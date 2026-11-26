import SwiftUI

// Commits: what a session's agent committed, on the stack it's building. The chip above the
// box counts them; its list shows each one under its branch and PR, and a commit opens its
// PR's layer in Review (`SessionCommits`, `apps/server` `GET /api/review/sessions/:uid/commits`).

/// The Commits chip, one of the chips over the box (`LaunchChips`, `SettingChipLabel`):
/// "Commits 3", and as the row runs short of room, the count alone, then the glyph. Only there
/// once the session has committed something.
struct CommitsChip: View {
    let session: SessionModel
    let scene: SceneModel
    var density: LaunchChipsDensity = .full
    /// Where it is on screen: the iPad's popover points at the chip that was tapped.
    @State private var frame: CGRect = .zero

    var body: some View {
        let count = session.commits.commits.count
        Button {
            Haptics.selection()
            scene.chipAnchor = frame
            scene.sheet = .commits(session.key)
        } label: {
            SettingChipLabel(name: "Commits", symbol: CommitGlyph.symbol, value: density == .symbols ? nil : "\(count)", spoken: count == 1 ? "1 commit" : "\(count) commits", labelled: density == .full)
        }
        .buttonStyle(.plain)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
        .accessibilityIdentifier("commits-chip")
        .accessibilityHint("Shows what it committed, each opening its review")
        // The count changes in place.
        .animation(nil, value: count)
    }
}

enum CommitGlyph {
    static let symbol = "circle.and.line.horizontal"
}

// MARK: The list

/// A session's commits, newest first, under the branch (and PR) each is on. A commit opens its
/// PR's layer in Review, starting the session's review first when there's none yet.
struct SessionCommitsSheet: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    /// The commit whose review is being started.
    @State private var starting: String?
    @State private var error: String?

    var body: some View {
        let model = session.commits
        NavigationStack {
            content(model)
                .navigationTitle("Commits")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { scene.sheet = nil }.keyboardShortcut(.cancelAction) }
                }
                .background(theme.background)
        }
        .task { await model.load() }
        .tint(theme.accent)
    }

    @ViewBuilder
    private func content(_ model: SessionCommitsModel) -> some View {
        switch model.phase {
        case .idle, .loading where model.value == nil:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unsupported:
            ContentUnavailableView("No Commits Here", systemImage: CommitGlyph.symbol, description: Text("This session’s host can’t list what it committed."))
        case .failed(let message) where model.value == nil:
            ContentUnavailableView {
                Label("Couldn’t Load Commits", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        default:
            if let value = model.value, !value.commits.isEmpty {
                list(value, model: model)
            } else {
                ContentUnavailableView("No Commits Yet", systemImage: CommitGlyph.symbol, description: Text("What \(agentName) commits on this branch shows here, each one a tap from its review."))
            }
        }
    }

    private func list(_ value: SessionCommits, model: SessionCommitsModel) -> some View {
        List {
            if let error {
                Banner(text: error, tone: .error, action: ("Dismiss", { self.error = nil }))
                    .listRowBackground(Color.clear)
            }
            ForEach(value.byBranch, id: \.branch) { group in
                Section {
                    ForEach(group.commits) { commit in
                        CommitRow(commit: commit, target: value.target(of: commit), starting: starting == commit.sha) { pick(commit, in: value) }
                    }
                    .ahRow()
                } header: {
                    BranchHeader(branch: value.branch(of: group.commits[0]), name: group.branch)
                }
            }
            Section {
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    if case .failed(let message) = model.phase { Text("Not updated: \(message)") }
                    Text(value.since > 0 ? "Committed since this session started, on its branches and not yet on \(value.stack.trunk)." : "On its branches and not yet on \(value.stack.trunk).")
                }
            }
        }
        .listStyle(.insetGrouped)
        // Opaque ground and cards, as Subagents': at half height the sheet's glass washed out.
        .ahFormGround()
        .refreshable { await model.load() }
        .accessibilityIdentifier("commits-list")
    }

    private var agentName: String { session.launch.preset?.name ?? session.history?.dto.harness.capitalized ?? "the agent" }

    private func pick(_ commit: SessionCommits.Commit, in value: SessionCommits) {
        switch value.target(of: commit) {
        case .review(let route):
            Haptics.selection()
            scene.sheet = nil
            scene.openReview(route)
        case .start(let pick, let pr):
            guard starting == nil else { return }
            starting = commit.sha
            Haptics.tap()
            Task {
                defer { starting = nil }
                do {
                    let created = try await ReviewAPI(api: session.api).create(root: value.stack.root, pick: pick, from: session.ref)
                    scene.sheet = nil
                    scene.toast("Started review for this session")
                    scene.openReview(ReviewRoute(stack: created.id, pr: created.layers.contains { $0.pr == pr } ? pr : created.next))
                    await session.commits.load()
                } catch {
                    self.error = APIError.wrap(error).message
                }
            }
        case .nowhere:
            break
        }
    }
}

/// A branch of the session's stack: its name, its PR, and where that PR stands in review.
private struct BranchHeader: View {
    let branch: SessionStack.Branch?
    let name: String
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch").imageScale(.small)
            Text(name).font(.ahMono(.caption)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 6)
            if let pr = branch?.pr {
                Text("#\(pr.number)").font(.ah(.caption).weight(.semibold)).monospacedDigit()
                if let layer = branch?.layer {
                    Text(layer.status.word).foregroundStyle(LayerColor.tag(layer.status, theme))
                } else if pr.state != "OPEN" {
                    Text(pr.state.capitalized)
                } else if pr.draft {
                    Text("Draft")
                }
            } else {
                Text("No pull request yet")
            }
        }
        .font(.ah(.caption))
        .foregroundStyle(theme.muted)
        .textCase(nil)
        .accessibilityElement(children: .combine)
    }
}

/// One commit: what it says, its hash, what it changed and when; where a tap takes it.
private struct CommitRow: View {
    let commit: SessionCommits.Commit
    let target: SessionCommits.Target
    let starting: Bool
    let pick: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: pick) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(commit.subject).font(.ah(.body).weight(.medium)).foregroundStyle(target == .nowhere ? theme.text2 : theme.text).lineLimit(2)
                    HStack(spacing: 8) {
                        Text(commit.short).font(.ahMono(.caption)).foregroundStyle(theme.muted)
                        if commit.additions + commit.deletions > 0 {
                            Text("+\(commit.additions) −\(commit.deletions)").font(.ahMono(.caption2)).foregroundStyle(theme.faint)
                        }
                        Text(Date(timeIntervalSince1970: commit.at).formatted(.relative(presentation: .named))).font(.ah(.caption)).foregroundStyle(theme.faint).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                trailing
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(target == .nowhere)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(commit.subject), \(commit.short)")
        .accessibilityHint(hint)
        .accessibilityAddTraits(target == .nowhere ? [] : .isButton)
        .accessibilityIdentifier("commit:\(commit.short)")
        .contextMenu {
            Button("Copy Commit Hash", systemImage: "doc.on.doc") { UIPasteboard.general.string = commit.sha }
        }
    }

    @ViewBuilder
    private var trailing: some View {
        switch target {
        case .review, .start:
            if starting { ProgressView().controlSize(.small) } else { Image(systemName: "chevron.right").font(.ah(.footnote).weight(.semibold)).foregroundStyle(theme.faint) }
        case .nowhere:
            EmptyView()
        }
    }

    private var hint: String {
        switch target {
        case .review: return "Opens its review"
        case .start: return "Starts this session’s review and opens it there"
        case .nowhere: return "Its branch has no pull request yet"
        }
    }
}
