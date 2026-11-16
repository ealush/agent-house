import SwiftUI

/// Review's landing: stacks in progress, and starting a review.
struct ReviewHomeView: View {
    @Bindable var scene: SceneModel
    @State var model: ReviewModel
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var starting = false
    /// The list has been asked for and answered once (with stacks, none, or an error).
    @State private var loaded = false

    var body: some View {
        List {
            Section { } header: {
                let waiting = model.stacks.reduce(0) { $0 + $1.needsYou }
                AhLargeTitle(title: "Review", tagline: model.stacks.isEmpty ? nil : "\(model.stacks.count) stack\(model.stacks.count == 1 ? "" : "s") in review\(waiting > 0 ? ". \(waiting) need\(waiting == 1 ? "s" : "") you." : ".")").textCase(nil)
            }
            if let error = model.error { Banner(text: error, tone: .error).listRowBackground(Color.clear) }
            if model.stacks.isEmpty && !loaded {
                // Until the host has answered once: the shape of what's coming, not an empty
                // page that then says there's nothing (before it knows).
                ForEach(0..<2, id: \.self) { _ in StackPlaceholder().ahRow() }
            } else if model.stacks.isEmpty && !model.loading.contains("stacks") {
                EmptyState(symbol: "square.stack.3d.up", title: "No Stacks in Review", message: "Start from a PR chain, a GitHub stack, or PRs you pick.", action: ("Start a Review", { starting = true }))
                    .listRowBackground(Color.clear)
            }
            ForEach(model.stacks) { stack in
                Button {
                    scene.openReview(ReviewRoute(stack: stack.id))
                } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(stack.title).font(.ah(.headline)).foregroundStyle(theme.text)
                                Text("\(stack.repo) → \(stack.trunk)").font(.ah(.caption)).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            if stack.needsYou > 0 {
                                Text("\(stack.needsYou) need\(stack.needsYou == 1 ? "s" : "") you")
                                    .font(.ah(.caption).weight(.semibold))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(theme.brand.opacity(0.14), in: Capsule())
                                    .foregroundStyle(theme.accent)
                            }
                        }
                        SpineBar(spine: stack.spine)
                        HStack {
                            Text(stack.statusLine).font(.ah(.caption)).foregroundStyle(theme.muted)
                                .contentTransition(.numericText())
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.ah(.footnote).weight(.semibold))
                                .foregroundStyle(theme.faint)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .ahRow()
            }
        }
        .ahPage("Review")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { starting = true } label: { Label("Start a Review", systemImage: "plus").foregroundStyle(theme.background) }
                    .buttonStyle(.glassProminent)
                    .tint(theme.text)
            }
        }
        // Stacks arriving, leaving or changing places move there, rather than cut.
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: model.stacks.map(\.id))
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: loaded)
        .task {
            await model.loadList()
            loaded = true
        }
        .refreshable { await model.loadList() }
        .sheet(isPresented: $starting) {
            NavigationStack { StartReviewView(model: model) { id in starting = false; scene.openReview(ReviewRoute(stack: id)) } }
        }
    }
}

/// The stack as one bar, bottom layer first: a segment per layer in its status's color, with
/// its PR number under it while they fit.
struct SpineBar: View {
    let spine: [StackSummary.Spine]
    /// Each segment's PR number under it (while they fit).
    var numbered = true
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(spine, id: \.pr) { layer in
                VStack(alignment: .leading, spacing: 4) {
                    Capsule()
                        .fill(LayerColor.color(layer.status, theme))
                        .frame(height: 6)
                    if numbered, spine.count <= 8 {
                        Text("#\(layer.pr)").font(.ah(.caption2).monospacedDigit()).foregroundStyle(theme.faint)
                    }
                }
                .frame(maxWidth: 140)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("#\(layer.pr) \(layer.status.word)")
            }
        }
    }
}

/// A stack's layers as its spine, with the count that matters under it: how many are
/// reviewed or landed, of how many.
struct StackProgress: View {
    let layers: [Layer]
    @Environment(\.theme) private var theme

    var body: some View {
        let done = layers.filter { $0.status == .approved || $0.status == .merged }.count
        let live = layers.filter { $0.status != .closed && $0.status != .skipped }.count
        VStack(alignment: .leading, spacing: 6) {
            SpineBar(spine: layers.map { StackSummary.Spine(pr: $0.pr, role: $0.role, status: $0.status) }, numbered: false)
            Text(live == 0 ? "No open layers" : done == live ? "All \(live) reviewed" : "\(done) of \(live) reviewed")
                .font(.ah(.caption).weight(.medium).monospacedDigit())
                .foregroundStyle(done == live && live > 0 ? theme.done : theme.text2)
                .contentTransition(.numericText())
        }
        .animation(.snappy(duration: 0.3), value: layers.map(\.status))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(live == 0 ? "No open layers" : "\(done) of \(live) layers reviewed")
    }
}

/// A stack's row before the list has loaded: its shape, breathing.
private struct StackPlaceholder: View {
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Capsule().fill(theme.text.opacity(0.1)).frame(width: 180, height: 12)
            Capsule().fill(theme.text.opacity(0.07)).frame(width: 120, height: 8)
            Capsule().fill(theme.text.opacity(0.07)).frame(height: 6)
        }
        .padding(.vertical, 8)
        .breathing()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading reviews")
    }
}

/// A layer status's color in the shared vocabulary.
enum LayerColor {
    static func color(_ status: LayerStatus, _ theme: Theme) -> Color {
        switch status.tone {
        case .needs: return theme.brand
        case .busy: return theme.run
        case .ready: return theme.done
        case .merged: return theme.done.opacity(0.5)
        case .off: return theme.faint.opacity(0.4)
        case .todo: return theme.faint
        }
    }

    /// The same for a status written out in a tag: merged and switched-off layers stay
    /// readable, where a mark of theirs fades.
    static func tag(_ status: LayerStatus, _ theme: Theme) -> Color {
        switch status.tone {
        case .needs: return theme.brand
        case .busy: return theme.run
        case .ready, .merged: return theme.done
        case .off, .todo: return theme.muted
        }
    }
}

/// A new review: pick a repo, then GitHub's chain under a PR, a GitHub stack, or PRs by hand.
private struct StartReviewView: View {
    let model: ReviewModel
    let created: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @State private var repo: ReviewRepo?
    @State private var candidates: Candidates?
    @State private var picked: [Int] = []
    @State private var error: String?

    var body: some View {
        List {
            Group {
            if let error { Banner(text: error, tone: .error) }
            if repo == nil {
                Section("Repository") {
                    ForEach(model.repos, id: \.root) { r in
                        Button {
                            repo = r
                            Task {
                                do { candidates = try await model.review.candidates(root: r.root) } catch { self.error = APIError.wrap(error).message }
                            }
                        } label: {
                            // The checkout as well as the repository: one repo checked out three
                            // times (worktrees) read as the same line three times.
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(r.repo).foregroundStyle(theme.text)
                                    Text("\(Self.checkout(r.root)) · onto \(r.trunk)").font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.head)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").font(.ah(.footnote).weight(.semibold)).foregroundStyle(theme.faint)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else if let candidates {
                if !candidates.native.isEmpty {
                    Section("GitHub stacks") {
                        ForEach(candidates.native, id: \.number) { stack in
                            Button { start(.native(stack.number)) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("Stack #\(stack.number)").foregroundStyle(theme.text)
                                        Text("\(stack.prs.map { "#\($0)" }.joined(separator: " → ")) onto \(stack.base)").font(.ah(.caption)).foregroundStyle(theme.muted)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.ah(.footnote).weight(.semibold)).foregroundStyle(theme.faint)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Section("A chain: pick its top PR") {
                    ForEach(candidates.trees) { tree in TreeRow(tree: tree, depth: 0, pick: { start(.chain($0)) }) }
                }
                Section("Or pick PRs, in review order") {
                    ForEach(flatten(candidates.trees), id: \.number) { pr in
                        Button {
                            if let i = picked.firstIndex(of: pr.number) { picked.remove(at: i) } else { picked.append(pr.number) }
                        } label: {
                            HStack {
                                Image(systemName: picked.contains(pr.number) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(picked.contains(pr.number) ? theme.accent : theme.faint)
                                    .contentTransition(.symbolEffect(.replace))
                                Text("#\(pr.number)").foregroundStyle(theme.muted).monospacedDigit()
                                Text(pr.title).foregroundStyle(theme.text).lineLimit(1)
                                if let order = picked.firstIndex(of: pr.number) { Spacer(); Text("\(order + 1)").foregroundStyle(theme.muted).monospacedDigit() }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(pr.inStack != nil)
                    }
                    // The one action here, said with its count, and only once there's a pick.
                    Button { start(.manual(picked)) } label: {
                        Text(picked.isEmpty ? "Pick PRs to review" : "Review \(picked.count) PR\(picked.count == 1 ? "" : "s")").fontWeight(.semibold).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(theme.accentStrong)
                    .disabled(picked.isEmpty)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                }
            } else {
                ProgressView()
            }
            }
            .ahRow()
        }
        .ahFormGround()
        .navigationTitle("Start a Review")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) } }
        .task { if model.repos.isEmpty { await model.loadList() } }
    }

    /// A checkout by its last two folders (`.worktrees/orbit-api`, `files/orbit-api`): enough
    /// to tell a repository's checkouts apart.
    static func checkout(_ root: String) -> String {
        root.split(separator: "/").suffix(2).joined(separator: "/")
    }

    private func flatten(_ trees: [CandidateTree]) -> [Candidate] {
        trees.flatMap { [$0.pr] + flatten($0.children) }
    }

    private func start(_ pick: ReviewAPI.Pick) {
        guard let repo else { return }
        Task {
            if let id = await model.create(root: repo.root, pick: pick, title: nil) { created(id) } else { error = model.error }
        }
    }

    private struct TreeRow: View {
        let tree: CandidateTree
        let depth: Int
        let pick: (Int) -> Void
        @Environment(\.theme) private var theme
        var body: some View {
            Button {
                pick(tree.pr.number)
            } label: {
                HStack(spacing: 8) {
                    // A child sits under its parent with the branch's own glyph, not spaces.
                    if depth > 0 {
                        Image(systemName: "arrow.turn.down.right").font(.ah(.caption)).foregroundStyle(theme.faint).padding(.leading, CGFloat(depth - 1) * 14)
                    }
                    Text("#\(tree.pr.number)").foregroundStyle(theme.muted).monospacedDigit()
                    Text(tree.pr.title).foregroundStyle(theme.text).lineLimit(1)
                    Spacer(minLength: 8)
                    Text("+\(tree.pr.additions)").foregroundStyle(theme.done)
                    Text("−\(tree.pr.deletions)").foregroundStyle(theme.danger)
                }
                .font(.ah(.callout))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(tree.pr.inStack != nil)
            ForEach(tree.children) { child in TreeRow(tree: child, depth: depth + 1, pick: pick) }
        }
    }
}

/// One stack: what it is for, where it stands, what's next, and every layer.
struct StackCockpitView: View {
    @Bindable var scene: SceneModel
    @Bindable var model: ReviewModel
    let route: ReviewRoute
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var mergingStack = false
    @State private var managing = false
    @State private var decision = ""
    /// The layers' list has the keyboard, for j/k (and the arrows) to walk them.
    @FocusState private var spineFocused: Bool

    var body: some View {
        Group {
            if let stack = model.stack {
                if sizeClass == .regular && !scene.narrow {
                    HStack(spacing: 0) {
                        spine(stack).frame(width: 320)
                        Divider()
                        if model.layer != nil {
                            LayerView(scene: scene, model: model)
                        } else {
                            EmptyState(symbol: "square.stack.3d.up", title: "Pick a Layer", message: "Its evidence and decision show here.")
                        }
                    }
                } else {
                    spine(stack)
                }
            } else if let error = model.error {
                Banner(text: error, tone: .error).padding()
            } else if model.removed {
                EmptyState(symbol: "trash", title: "Review Deleted", message: "It’s gone from the list too.")
            } else {
                ProgressView()
            }
        }
        // Deleted from its Manage sheet: back to the list, not a page spinning for a stack
        // that isn't there.
        .onChange(of: model.removed) { _, gone in if gone { scene.reviewPath = [] } }
        // On a phone the page opens on the stack's card, its title in full: the bar names
        // the place (a truncated second copy of the title read as a mistake).
        .navigationTitle(scene.narrow ? "Stack" : (model.stack?.title ?? "Stack"))
        .navigationBarTitleDisplayMode(scene.narrow ? .inline : .automatic)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Sync with GitHub").tint(.primary)
                // A phone has it in the bar at the bottom, beside what to review next.
                if !scene.narrow {
                    Button { mergingStack = true } label: { Label("Merge the stack", systemImage: "arrow.triangle.merge") }
                        .disabled(model.stack == nil)
                        .tint(.primary)
                }
                Button { managing = true } label: { Label("Manage", systemImage: "slider.horizontal.3") }
                    .disabled(model.stack == nil)
                    .tint(.primary)
            }
        }
        // On a phone a layer is its own page, which picks it; here it would only race that one.
        .task(id: route) { await model.open(route, selecting: !scene.narrow) }
        .sheet(isPresented: $mergingStack) {
            if let stack = model.stack { StackMergeSheet(model: model, stack: stack) }
        }
        .sheet(isPresented: $managing) {
            if let stack = model.stack { StackManageSheet(model: model, stack: stack) }
        }
    }

    private func spine(_ stack: ReviewStack) -> some View {
        // On a phone a layer pushes, so no row stays lit after coming back.
        List(selection: Binding(get: { scene.narrow ? nil : model.selectedPR }, set: { pr in if let pr { Task { await model.select(pr) } } })) {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    // The stack's name is read here: a phone's bar says "Stack", and beside a
                    // layer the bar above the two columns carries the layer's number.
                    Text(stack.title).font(.ah(.title3).weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    Text("\(stack.repo) → \(stack.trunk)").font(.ah(.caption)).foregroundStyle(theme.muted)
                    // Where the whole stack stands, before any one layer: a segment a layer,
                    // and how many are done.
                    StackProgress(layers: stack.layers).padding(.vertical, 4)
                    if let next = stack.next, let layer = stack.layers.first(where: { $0.pr == next }) {
                        // Where to start, as the way in to it.
                        Button {
                            if scene.narrow { scene.reviewPath.append(ReviewRoute(stack: stack.id, pr: layer.pr)) } else { Task { await model.select(layer.pr) } }
                        } label: {
                            Label("Up next: \(layer.name) — \(layer.title)", systemImage: "arrow.right.circle.fill")
                                .font(.ah(.subheadline).weight(.semibold))
                                .multilineTextAlignment(.leading)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(theme.accentStrong)
                        .padding(.top, 4)
                    }
                    if let origin = stack.origin {
                        Button { scene.open(origin.key) } label: { Label("Made in “\(origin.title)”", systemImage: "terminal") }.font(.ah(.caption))
                    }
                    if let owner = stack.owner, owner.uid != stack.origin?.uid {
                        Button { scene.open(owner.key) } label: { Label("Fixes go to “\(owner.title)”", systemImage: "wrench.and.screwdriver") }.font(.ah(.caption))
                    }
                    if let syncError = stack.syncError { Text(syncError).font(.ah(.caption)).foregroundStyle(theme.danger) }
                }
            }
            .ahRow(scene.narrow)
            // The lists' overline, as every page's sections have it (the system's grey header
            // made this one page read as Settings).
            Section {
                ForEach(stack.layers) { layer in
                    LayerRow(layer: layer, pushes: scene.narrow)
                        .tag(layer.pr)
                        .background {
                            if scene.narrow {
                                NavigationLink("", value: ReviewRoute(stack: stack.id, pr: layer.pr)).opacity(0)
                            }
                        }
                }
            } header: {
                AhSectionHeader(title: "Layers, bottom to top", count: stack.layers.count)
            }
            .ahRow(scene.narrow)
            Section {
                ForEach(stack.decisions) { decision in
                    Text(decision.text).font(.ah(.callout))
                        // Red by tint, not role: the row stays until the host's stack comes back.
                        .swipeActions { Button { Task { await model.removeDecision(decision.id) } } label: { Image(systemName: "pin.slash") }.accessibilityLabel("Unpin").tint(theme.swipe(\.danger)) }
                }
                HStack(spacing: 10) {
                    Image(systemName: "pin").foregroundStyle(theme.faint).accessibilityHidden(true)
                    TextField("Pin a decision the whole stack follows", text: $decision)
                }
                    .font(.ah(.callout))
                    .onSubmit {
                        let text = decision.trimmingCharacters(in: .whitespacesAndNewlines)
                        decision = ""
                        if !text.isEmpty { Task { await model.addDecision(text) } }
                    }
            } header: {
                AhSectionHeader(title: stack.decisions.isEmpty ? "Decisions" : "Pinned decisions", count: stack.decisions.isEmpty ? nil : stack.decisions.count)
            }
            .ahRow(scene.narrow)
            if stack.planPath != nil {
                Section {
                    if let plan = model.plan?.text { MarkdownView(plan, compact: true) } else { Button("Show the Plan") { Task { await model.loadPlan() } } }
                } header: {
                    AhSectionHeader(title: "Plan")
                }
                .ahRow(scene.narrow)
            }
        }
        .listStyle(.sidebar)
        // j/k walk the layers when not typing, as on the web. They only reach a view that
        // has the keyboard: on the page around the list they never arrived.
        .focusable(!scene.narrow)
        .focused($spineFocused)
        .focusEffectDisabled()
        .onKeyPress(phases: .down) { press in
            guard !scene.narrow, let current = model.selectedPR, let index = stack.layers.firstIndex(where: { $0.pr == current }) else { return .ignored }
            switch press.characters {
            case "j": if index + 1 < stack.layers.count { Task { await model.select(stack.layers[index + 1].pr) } }
            case "k": if index > 0 { Task { await model.select(stack.layers[index - 1].pr) } }
            default: return .ignored
            }
            return .handled
        }
        .onAppear { if scene.hardwareKeyboard && !scene.narrow { spineFocused = true } }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if scene.narrow { stackBar(stack) }
        }
    }

    /// On a phone, the stack's next step under the thumb: the layer to review next, and the
    /// merge once anything can land.
    @ViewBuilder
    private func stackBar(_ stack: ReviewStack) -> some View {
        let plan = StackMergePlan(stack: stack, method: stack.mergeMethod)
        let open = stack.layers.filter { $0.state == "open" }
        // The host's next if it still wants your review, else the lowest layer that does.
        let unreviewed = open.filter { !$0.approved || !$0.samePatch }
        let next = stack.next.flatMap { pr in unreviewed.first { $0.pr == pr } } ?? unreviewed.first
        if next != nil || !plan.lands.isEmpty {
            GlassEffectContainer(spacing: 10) {
                // Side by side while they fit, one over the other at the largest type sizes.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { stackActions(stack, next: next, plan: plan, open: open) }
                    VStack(spacing: 8) { stackActions(stack, next: next, plan: plan, open: open) }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 8)
            .transition(.blurReplace)
        }
    }

    @ViewBuilder
    private func stackActions(_ stack: ReviewStack, next: Layer?, plan: StackMergePlan, open: [Layer]) -> some View {
        if let next {
            Button {
                Haptics.selection()
                scene.reviewPath.append(ReviewRoute(stack: stack.id, pr: next.pr))
            } label: {
                Label("Review \(next.name)", systemImage: "arrow.right.circle")
                    .font(.ah(.subheadline).weight(.semibold))
                    .foregroundStyle(theme.accentInk)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.glassProminent)
            .tint(theme.accentStrong)
        }
        if !plan.lands.isEmpty {
            let words = plan.lands.count == open.count ? "Merge the stack…" : "Merge \(plan.lands.count) layer\(plan.lands.count == 1 ? "" : "s")…"
            if next == nil {
                Button { mergingStack = true } label: {
                    Label(words, systemImage: "arrow.triangle.merge")
                        .font(.ah(.subheadline).weight(.semibold))
                        .foregroundStyle(theme.background)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.glassProminent)
                .tint(theme.done)
            } else {
                Button { mergingStack = true } label: {
                    Label(words, systemImage: "arrow.triangle.merge")
                        .font(.ah(.subheadline).weight(.semibold))
                        .padding(.vertical, 6)
                }
                .buttonStyle(.glass)
            }
        }
    }
}

/// A layer pushed on a phone. A link or a restored window can land here with its stack still
/// to load.
struct LayerPage: View {
    @Bindable var scene: SceneModel
    @Bindable var model: ReviewModel
    let route: ReviewRoute
    @State private var shown = false

    var body: some View {
        Group {
            // Once shown, the page follows the model within its stack: a merge moves on to the
            // next layer ahead of the path, which catches up when the merge sheet goes.
            if model.layer != nil, model.stack?.id == route.stack, shown || model.selectedPR == route.pr {
                LayerView(scene: scene, model: model)
            } else if let error = model.error {
                Banner(text: error, tone: .error).padding()
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onChange(of: model.selectedPR == route.pr && model.stack?.id == route.stack, initial: true) { _, here in
            if here { shown = true }
        }
        .task(id: route) {
            if model.stack?.id != route.stack {
                await model.open(route)
            } else if let pr = route.pr, model.selectedPR != pr {
                await model.select(pr)
            }
        }
    }
}

private struct LayerRow: View {
    let layer: Layer
    /// On a phone the row pushes the layer's page: it says so with the list's chevron (the
    /// link under it is hidden, and its own went with it).
    var pushes = false
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 10) {
            details
            if pushes {
                Image(systemName: "chevron.right")
                    .font(.ah(.footnote).weight(.semibold))
                    .foregroundStyle(theme.faint)
                    .accessibilityHidden(true)
            }
        }
    }

    private var details: some View {
        let confidence = LayerConfidence(layer: layer)
        return VStack(alignment: .leading, spacing: 4) {
            // The title gets two lines: one cut most of them off mid-word on a phone.
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(layer.name).font(.ah(.subheadline).weight(.semibold)).monospacedDigit()
                Text(layer.title).font(.ah(.subheadline)).lineLimit(2)
                Spacer(minLength: 6)
                StatusTag(text: layer.status.word, color: LayerColor.tag(layer.status, theme))
            }
            HStack(spacing: 8) {
                Label(confidence.checksText, systemImage: checksSymbol(confidence.checks)).foregroundStyle(checksColor(confidence.checks))
                if layer.blocking > 0 { Label("\(layer.blocking) blocking", systemImage: "exclamationmark.octagon").foregroundStyle(theme.danger) }
                else if layer.open > 0 { Label("\(layer.open) open", systemImage: "flag").foregroundStyle(theme.muted) }
                if confidence.review == .changedSinceReview { Label("changed", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(theme.accent) }
            }
            .font(.ah(.caption2))
        }
        .accessibilityElement(children: .combine)
    }

    private func checksSymbol(_ outcome: Checks.Outcome) -> String {
        switch outcome {
        case .none: return "questionmark.circle"
        case .pending: return "clock"
        case .failing: return "xmark.circle"
        case .passing: return "checkmark.circle"
        }
    }

    private func checksColor(_ outcome: Checks.Outcome) -> Color {
        switch outcome {
        case .none: return theme.limited
        case .pending: return theme.run
        case .failing: return theme.danger
        case .passing: return theme.done
        }
    }
}

/// One layer as a decision: understand it, inspect the evidence, challenge it, verify it,
/// decide, and merge exactly what you reviewed. The decision floats at the bottom, where the
/// thumb is, whatever's been scrolled to; a tapped line turns it into that line's actions.
struct LayerView: View {
    @Bindable var scene: SceneModel
    @Bindable var model: ReviewModel
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    @State private var selectedLines: (path: String, index: Int, lines: [DiffLine])?
    @State private var addingFinding = false
    @State private var dispatching: String?? = nil
    /// The layer the merge sheet was opened for: the page moves on to the next layer once it
    /// merges, and the sheet stays with this one to say how it went.
    @State private var mergeTarget: Layer?
    @State private var resolving: Finding?
    /// Files folded shut in the diff, by path.
    @State private var folded: Set<String> = []
    /// Files shown whole (past the first 300 lines): a line was asked for further down.
    @State private var whole: Set<String> = []
    @FocusState private var asking: Bool
    /// Asked something on this page: the thread's answers are followed to the field. The
    /// thread arriving on its own (the page opening) leaves the layer at its top.
    @State private var followingAsk = false

    var body: some View {
        if let layer = model.layer, let confidence = model.confidence, let stack = model.stack {
            ScrollViewReader { proxy in
                ScrollView {
                    // Lazy, a file to a section: only the files in sight are built (a long
                    // layer built every line of every file before it drew anything, and again
                    // on each tap), and the file being read keeps its name, its counts and
                    // its Viewed box pinned at the top.
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        header(layer).padding(.bottom, 28)
                        understand(layer).padding(.bottom, 28)
                        architecture(layer, proxy).padding(.bottom, 28)
                        inspectHead(layer, proxy).padding(.bottom, 12)
                        diffFiles(layer, proxy)
                        challenge(layer, stack, proxy).id("challenge").padding(.top, 28)
                        verify(layer, confidence).padding(.top, 28)
                    }
                    .padding()
                }
                // Another layer opens at its top, not wherever the last one was read to.
                .id(layer.pr)
                .transition(.opacity)
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    VStack(spacing: 8) {
                        // What an action here couldn't do (approve, ask, dispatch, merge): it
                        // was only shown with no stack loaded, so a failure here said nothing.
                        if let error = model.error {
                            Banner(text: error, tone: .error, action: ("Dismiss", { model.clearError() }))
                                .padding(.horizontal)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                        bar(layer, confidence, proxy)
                    }
                    .animation(.snappy, value: model.error)
                }
                // Asking keeps the exchange in sight: the field while the reviewer reads, then
                // its answer above the field when it lands.
                .onChange(of: model.thread.count) { old, new in
                    guard new > old, followingAsk else { return }
                    withAnimation(.smooth(duration: 0.35)) { proxy.scrollTo("ask", anchor: .bottom) }
                }
                .onChange(of: model.loading.contains("ask")) { _, asking in
                    guard asking else { return }
                    followingAsk = true
                    withAnimation(.smooth(duration: 0.35)) { proxy.scrollTo("ask", anchor: .bottom) }
                }
            }
            .animation(.smooth(duration: 0.2), value: layer.pr)
            .onChange(of: layer.pr) {
                selectedLines = nil
                folded = []
                followingAsk = false
            }
            // The page's heading has the title; the bar keeps the layer's number.
            .navigationTitle(layer.name)
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $addingFinding, onDismiss: { selectedLines = nil }) {
                NewFindingSheet(model: model, path: selectedLines?.path, lines: selectedLines?.lines ?? [])
            }
            .sheet(item: Binding(get: { dispatching.map { DispatchKind(kind: $0) } }, set: { (item: DispatchKind?) in dispatching = item.map { $0.kind } })) { item in
                DispatchSheet(scene: scene, model: model, layer: layer, kind: item.kind)
            }
            .sheet(item: $resolving) { finding in
                ResolveThreadSheet(model: model, finding: finding)
            }
            // A merge moves on to the next layer; the path follows once the sheet has gone.
            .sheet(item: $mergeTarget, onDismiss: followSelection) { target in
                MergeLayerSheet(scene: scene, model: model, layer: target, confidence: LayerConfidence(layer: target))
            }
        }
    }

    private func header(_ layer: Layer) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(layer.role.isEmpty ? "#\(layer.pr)" : "#\(layer.pr) · \(layer.role)")
                    .font(.ahMono(.caption).weight(.semibold))
                    .foregroundStyle(theme.muted)
                StatusTag(text: layer.status.word, color: LayerColor.tag(layer.status, theme))
                if layer.draft { StatusTag(text: "Draft", color: theme.muted) }
            }
            Text(layer.title)
                .font(.ah(.title2).weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text("\(layer.headRef) → \(layer.baseRef)")
                .font(.ahMono(.caption))
                .foregroundStyle(theme.muted)
                .lineLimit(1)
                .truncationMode(.middle)
            Text("by \(layer.author) · head \(layer.headSha.prefix(7))")
                .font(.ah(.caption))
                .foregroundStyle(theme.faint)
        }
        .accessibilityElement(children: .combine)
    }

    private func section<Content: View>(_ title: String, _ symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: symbol).font(.ah(.headline)).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func understand(_ layer: Layer) -> some View {
        section("Intent", "lightbulb") {
            if let summary = layer.current?.summary, !summary.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Model briefing — a summary, not evidence").font(.ah(.caption)).foregroundStyle(theme.faint)
                        Spacer()
                        if model.summarizing {
                            ProgressView().controlSize(.mini)
                        } else {
                            Button("Write Again", systemImage: "arrow.clockwise") { Task { await model.brief(force: true) } }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.borderless)
                                .font(.ah(.caption))
                                .help("Write the briefing again")
                        }
                    }
                    MarkdownView(summary, compact: true)
                }
                .padding(12)
                .background(theme.tile, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .transition(.opacity)
            } else if model.summarizing {
                HStack(spacing: 10) {
                    ProgressView()
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Writing a briefing…").font(.ah(.subheadline))
                        Text("The model reads this layer’s diff and its stack. It shows here when it’s done.").font(.ah(.caption)).foregroundStyle(theme.muted)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.tile, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .transition(.opacity)
            } else if let blocked = model.briefingBlocked {
                VStack(alignment: .leading, spacing: 8) {
                    Label(blocked, systemImage: "text.bubble").font(.ah(.callout)).foregroundStyle(theme.muted)
                    HStack {
                        if blocked.contains("Settings") {
                            Button("Open Settings") { scene.sheet = .settings(SettingsSection.subscriptions.rawValue) }.buttonStyle(.bordered)
                        }
                        Button("Try Again") { Task { await model.brief() } }.buttonStyle(.borderless)
                    }
                }
            } else {
                Button("Brief Me on This Layer", systemImage: "text.bubble") { Task { await model.brief() } }.buttonStyle(.bordered)
            }
            if let description = model.description, !description.body.isEmpty {
                DisclosureGroup("The PR’s description") {
                    MarkdownView(description.body, compact: true)
                        .environment(\.hostFiles, HostFiles(load: { [review = model.review, id = model.stack?.id ?? ""] src in try? await review.image(id, src: src) }, open: { _ in }))
                }
            }
        }
        .animation(.smooth, value: model.summarizing)
    }

    /// The diff's head: which diff, how much of it is read, and the way to any file in it.
    private func inspectHead(_ layer: Layer, _ proxy: ScrollViewProxy) -> some View {
        section("Evidence", "doc.text.magnifyingglass") {
            Picker("Diff", selection: Binding(get: { model.diffScope }, set: { scope in Task { await model.loadDiff(scope) } })) {
                ForEach(DiffScope.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            if let failed = model.diffError {
                // Said where the diff goes, with the way to ask again, whether or not an
                // earlier scope's diff is still up under it.
                Banner(text: failed, tone: .error, action: ("Try Again", { Task { await model.loadDiff(model.diffScope) } }))
            }
            if let diff = model.diff {
                let files = model.diffFiles
                HStack(spacing: 8) {
                    let seen = files.filter { model.viewed.contains($0.path) }.count
                    Text(seen > 0 ? "\(seen) of \(files.count) viewed" : files.count == 1 ? "1 file" : "\(files.count) files")
                        .foregroundStyle(seen == files.count && seen > 0 ? theme.done : theme.text2)
                        .contentTransition(.numericText())
                    let added = files.reduce(0) { $0 + $1.additions }, removed = files.reduce(0) { $0 + $1.deletions }
                    if added > 0 { Text("+\(added)").foregroundStyle(theme.done) }
                    if removed > 0 { Text("−\(removed)").foregroundStyle(theme.danger) }
                    Spacer(minLength: 8)
                    if files.count > 1 { filesMenu(files, proxy) }
                }
                .font(.ah(.caption).weight(.semibold).monospacedDigit())
                // How far through the files you are, as a bar that fills.
                if files.count > 1 {
                    let seen = files.filter { model.viewed.contains($0.path) }.count
                    ProgressView(value: Double(seen), total: Double(files.count))
                        .tint(seen == files.count ? theme.done : theme.accentStrong)
                        .animation(.snappy(duration: 0.3), value: seen)
                        .accessibilityHidden(true)
                }
                Text("\(diff.from.prefix(7))…\(diff.to.prefix(7))\(diff.kind == "range" ? " · range-diff" : "")")
                    .font(.ahMono(.caption2))
                    .foregroundStyle(theme.faint)
                    .lineLimit(1)
                if diff.truncated { Label("This diff is long; only its start is shown here.", systemImage: "scissors").font(.ah(.caption)).foregroundStyle(theme.limited) }
                if diff.text.isEmpty {
                    Text(model.diffScope == .since ? "Nothing changed since your review." : "No changes.").foregroundStyle(theme.muted)
                }
            } else if model.diffError == nil, model.loading.contains("diff") {
                DiffPlaceholder()
            }
        }
        // A diff on its way in over the one shown (another scope): the old one steps back.
        .opacity(model.diff != nil && model.loading.contains("diff") ? 0.5 : 1)
        .animation(.smooth(duration: 0.2), value: model.loading.contains("diff"))
    }

    /// Every file in the diff, to go straight to: its name, what it changes, whether it's viewed.
    private func filesMenu(_ files: [FileDiff], _ proxy: ScrollViewProxy) -> some View {
        Menu {
            ForEach(files) { file in
                Button {
                    Haptics.selection()
                    withAnimation(.smooth(duration: 0.35)) { proxy.scrollTo(Self.fileID(file.path), anchor: .top) }
                } label: {
                    Label {
                        Text((file.path as NSString).lastPathComponent)
                        Text("+\(file.additions) −\(file.deletions) · \((file.path as NSString).deletingLastPathComponent)")
                    } icon: {
                        Image(systemName: model.viewed.contains(file.path) ? "checkmark.circle.fill" : "circle")
                    }
                }
            }
        } label: {
            Label("Files", systemImage: "list.bullet.indent")
                .font(.ah(.caption).weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: 28)
                .background(theme.tile, in: Capsule())
                .contentShape(Capsule())
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Jump to a file")
    }

    /// A file's section is found by the list's own id for it (its path), which the scroll
    /// view knows for sections it hasn't built yet; an id on the pinned header isn't.
    static func fileID(_ path: String) -> String { path }

    /// The files, each a section whose header pins while its lines scroll under it.
    @ViewBuilder
    private func diffFiles(_ layer: Layer, _ proxy: ScrollViewProxy) -> some View {
        if model.diff != nil {
            ForEach(model.diffFiles, id: \.path) { file in
                Section {
                    if !isShut(file.path) {
                        DiffFileBody(file: file, selected: selectedLines?.path == file.path ? selectedLines?.index : nil, maxLines: whole.contains(file.path) ? nil : 300) { index, line in
                            pick(file.path, index, line)
                        }
                        .equatable()
                        // Stepping back while another scope's diff is on its way (the lines
                        // only: dimmed, the pinned header let them show through it).
                        .opacity(model.loading.contains("diff") ? 0.5 : 1)
                        .padding(.bottom, 14)
                        .transition(.opacity)
                    } else {
                        Color.clear.frame(height: 6)
                    }
                } header: {
                    fileHeader(file, layer, proxy)
                        .padding(.vertical, 8)
                        // The page's ground behind it, edge to edge: lines pass under it.
                        .background { theme.background.padding(.horizontal, -16) }
                }
            }
        }
    }

    /// A viewed file stays folded until it's opened again; any other is open until folded.
    private func isShut(_ path: String) -> Bool {
        folded.contains(path) != model.viewed.contains(path)
    }

    /// Folding a file from deep inside it leaves its header where it was, the next file
    /// coming up under it: left to the scroll view, the page stayed as far down as it had
    /// been and landed somewhere in the files after.
    private func toggleFold(_ path: String, _ proxy: ScrollViewProxy? = nil) {
        let shutting = !isShut(path)
        withAnimation(.snappy(duration: 0.25)) {
            if folded.contains(path) { folded.remove(path) } else { folded.insert(path) }
        }
        if shutting { settle(on: path, proxy) }
    }

    /// Once the fold has been laid out (the next turn), the page goes to the file's start.
    private func settle(on path: String, _ proxy: ScrollViewProxy?) {
        guard let proxy else { return }
        Task {
            withAnimation(.snappy(duration: 0.25)) { proxy.scrollTo(Self.fileID(path), anchor: .top) }
        }
    }

    /// Viewed folds the file away and counts it; un-viewed opens it again.
    private func toggleViewed(_ path: String, _ proxy: ScrollViewProxy? = nil) {
        let on = !model.viewed.contains(path)
        if on { Haptics.tap() } else { Haptics.selection() }
        withAnimation(.snappy(duration: 0.28)) {
            model.setViewed(path, on)
            folded.remove(path)
            if selectedLines?.path == path { selectedLines = nil }
        }
        if on { settle(on: path, proxy) }
    }

    /// A file's name over its folder, what it adds and removes, a tap to fold it, and its
    /// Viewed box.
    private func fileHeader(_ file: FileDiff, _ layer: Layer, _ proxy: ScrollViewProxy) -> some View {
        let shut = isShut(file.path)
        let viewed = model.viewed.contains(file.path)
        let name = (file.path as NSString).lastPathComponent
        let folder = (file.path as NSString).deletingLastPathComponent
        return HStack(spacing: 8) {
            Button {
                toggleFold(file.path, proxy)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.ah(.caption2).weight(.bold))
                        .foregroundStyle(theme.faint)
                        .rotationEffect(.degrees(shut ? 0 : 90))
                    HStack(spacing: 0) {
                        if !folder.isEmpty { Text(folder + "/").foregroundStyle(theme.muted) }
                        Text(name).fontWeight(.semibold).foregroundStyle(viewed ? theme.muted : theme.text)
                    }
                    .font(.ahMono(.caption))
                    .lineLimit(1)
                    .truncationMode(.head)
                    Spacer(minLength: 6)
                    HStack(spacing: 4) {
                        if file.additions > 0 { Text("+\(file.additions)").foregroundStyle(theme.done) }
                        if file.deletions > 0 { Text("−\(file.deletions)").foregroundStyle(theme.danger) }
                    }
                    .font(.ah(.caption2).weight(.semibold).monospacedDigit())
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.path), \(file.additions) added, \(file.deletions) removed")
            .accessibilityHint(shut ? "Shows its changes" : "Folds its changes away")
            Button { toggleViewed(file.path, proxy) } label: {
                Image(systemName: viewed ? "checkmark.circle.fill" : "circle")
                    .font(.ah(.title3))
                    .foregroundStyle(viewed ? theme.done : theme.faint)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 36, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .touchTarget()
            .accessibilityLabel("Viewed")
            .accessibilityAddTraits(viewed ? .isSelected : [])
            .help(viewed ? "Mark as not viewed" : "Mark as viewed")
            Menu {
                Button("Ask the Reviewer About This File", systemImage: "bubble.left") { model.attach(.file(pr: layer.pr, path: file.path)) }
                Button(viewed ? "Mark as Not Viewed" : "Mark as Viewed", systemImage: viewed ? "circle" : "checkmark.circle") { toggleViewed(file.path, proxy) }
                Button(shut ? "Unfold" : "Fold", systemImage: shut ? "chevron.down" : "chevron.up") { toggleFold(file.path, proxy) }
            } label: {
                Image(systemName: "ellipsis").foregroundStyle(theme.muted).frame(width: 32, height: 30).contentShape(Rectangle())
            }
            .accessibilityLabel("More for \(name)")
        }
    }

    // MARK: Architecture

    /// How the layer changes the system, read from its whole diff (This layer) at the head shown.
    @ViewBuilder
    private func architecture(_ layer: Layer, _ proxy: ScrollViewProxy) -> some View {
        section("Architecture", "point.3.filled.connected.trianglepath.dotted") {
            if let overview = model.architecture {
                if overview.isEmpty {
                    Text("This layer’s diff is empty.").font(.ah(.callout)).foregroundStyle(theme.muted)
                } else {
                    ArchitectureSection(overview: overview, stale: model.architectureIsStale, currentHead: layer.current?.headSha ?? layer.headSha,
                                        reload: { Task { await model.loadDiff(.this) } },
                                        show: { show($0, proxy) })
                }
            } else if model.diffScope != .this {
                Button("Read it from this layer’s whole change", systemImage: "point.3.filled.connected.trianglepath.dotted") { Task { await model.loadDiff(.this) } }
                    .font(.ah(.callout)).buttonStyle(.borderless)
            } else if model.loading.contains("diff") {
                ProgressView().frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// A claim's line, in the diff: its file opens (whole, when the line is past the first
    /// 300), the page scrolls to it, and it's picked, as a finding's line is.
    private func show(_ evidence: ArchitectureOverview.Evidence, _ proxy: ScrollViewProxy) {
        guard let file = model.diffFiles.first(where: { $0.path == evidence.path }), file.lines.indices.contains(evidence.index) else { return }
        Haptics.selection()
        withAnimation(.snappy(duration: 0.25)) {
            if isShut(file.path) { toggleFold(file.path) }
            if evidence.index >= 300 { whole.insert(file.path) }
            selectedLines = (file.path, evidence.index, [file.lines[evidence.index]])
            proxy.scrollTo(Self.fileID(file.path), anchor: .top)
        }
        Task {
            try? await Task.sleep(for: .milliseconds(280))
            withAnimation(.smooth(duration: 0.4)) { proxy.scrollTo("\(file.path):\(evidence.index)", anchor: .center) }
        }
    }

    /// Where a finding's line sits in the diff shown, if it's there.
    private func place(of finding: Finding) -> (file: FileDiff, index: Int)? {
        guard let path = finding.path, let file = model.diffFiles.first(where: { $0.path == path }) else { return nil }
        guard let start = finding.lineStart else { return (file, 0) }
        return file.lines.firstIndex { $0.number == start && $0.kind != .del }.map { (file, $0) }
    }

    private func canShow(_ finding: Finding) -> Bool { place(of: finding) != nil }

    /// A finding's place, in the diff: its file opens, the page scrolls to the line, and the
    /// line is picked, its actions in the bar.
    private func show(_ finding: Finding, _ proxy: ScrollViewProxy) {
        guard let (file, index) = place(of: finding) else { return }
        Haptics.selection()
        withAnimation(.snappy(duration: 0.25)) {
            if isShut(file.path) { toggleFold(file.path) }
            if file.lines.indices.contains(index), file.lines[index].number != nil {
                selectedLines = (file.path, index, [file.lines[index]])
            }
            // The file first: its lines are only there to scroll to once it's been built.
            proxy.scrollTo(Self.fileID(file.path), anchor: .top)
        }
        Task {
            try? await Task.sleep(for: .milliseconds(280))
            withAnimation(.smooth(duration: 0.4)) { proxy.scrollTo("\(file.path):\(index)", anchor: .center) }
        }
    }

    /// A tapped line is picked (tap it again to let go); the bar below turns into its actions.
    private func pick(_ path: String, _ index: Int, _ line: DiffLine) {
        guard line.number != nil else { return }
        Haptics.selection()
        withAnimation(.snappy(duration: 0.2)) {
            if selectedLines?.path == path && selectedLines?.index == index {
                selectedLines = nil
            } else {
                selectedLines = (path, index, [line])
            }
        }
    }

    private func challenge(_ layer: Layer, _ stack: ReviewStack, _ proxy: ScrollViewProxy) -> some View {
        section("Risks", "bubble.left.and.exclamationmark.bubble.right") {
            ForEach(model.thread.filter { $0.pr == nil || $0.pr == layer.pr }) { message in
                if message.role == "user" {
                    UserBubble(text: message.text)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Reviewer (a model)").font(.ah(.caption2)).foregroundStyle(theme.faint)
                        MarkdownView(message.text, compact: true)
                    }
                }
            }
            if model.loading.contains("ask") {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("The reviewer is reading…").font(.ah(.caption)).foregroundStyle(theme.muted)
                }
                .transition(.opacity)
            }
            if !model.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(model.attachments, id: \.key) { context in
                            Button {
                                withAnimation(.snappy) { model.attachments.removeAll { $0.key == context.key } }
                            } label: {
                                Label(label(context), systemImage: "xmark").font(.ah(.caption))
                            }
                            .buttonStyle(.bordered)
                            .accessibilityLabel("Remove \(label(context))")
                        }
                    }
                }
                .transition(.opacity)
            }
            ReviewerQuestionField(model: model, focus: $asking)
                .id("ask")
            let findings = model.findings(for: layer.pr)
            HStack {
                Text("Findings").font(.ah(.subheadline).weight(.semibold))
                if !findings.isEmpty { Text("\(findings.count)").font(.ah(.caption).monospacedDigit()).foregroundStyle(theme.muted) }
                Spacer()
                Menu {
                    Button("Add a Finding", systemImage: "flag") { selectedLines = nil; addingFinding = true }
                    Button("Import GitHub Threads", systemImage: "square.and.arrow.down") { Task { let n = await model.importThreads(); scene.toast(n == 0 ? "No new threads" : "Imported \(n)") } }
                } label: {
                    Label("Add", systemImage: "plus").font(.ah(.caption).weight(.semibold))
                } primaryAction: {
                    selectedLines = nil
                    addingFinding = true
                }
            }
            .padding(.top, 6)
            if findings.isEmpty { Text("No findings on this layer. Tap a line in the diff to raise one there.").font(.ah(.callout)).foregroundStyle(theme.muted) }
            ForEach(findings) { finding in
                FindingRow(finding: finding, model: model, resolve: { resolving = finding }, show: canShow(finding) ? { show(finding, proxy) } : nil)
            }
        }
        .animation(.smooth, value: model.loading.contains("ask"))
        .animation(.smooth, value: model.attachments.count)
    }

    private func label(_ context: AskContext) -> String {
        switch context {
        case .finding(let id): return "Finding \(id)"
        case .file(_, let path): return (path as NSString).lastPathComponent
        case .lines(_, let path, let start, let end, _): return "\((path as NSString).lastPathComponent):\(start)\(end > start ? "–\(end)" : "")"
        }
    }

    private func verify(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        section("Tests", "checkmark.shield") {
            // One checklist: your review and the checks first, then the host's gates, less the
            // two that would only say those again.
            let gates = layer.gates.filter { $0.key != "reviewed" && $0.key != "checks" }
            VStack(alignment: .leading, spacing: 0) {
                CheckRow(state: reviewState(confidence), text: confidence.reviewText)
                Divider().padding(.leading, 40)
                CheckRow(state: checksState(confidence.checks), text: confidence.checksText)
                ForEach(gates, id: \.key) { gate in
                    Divider().padding(.leading, 40)
                    CheckRow(state: gate.ok ? .ok : .no, text: gate.label, detail: gate.ok ? nil : gate.detail)
                }
            }
            .background(theme.tile, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            switch layer.needs {
            case "conflict":
                Label("Conflicts with its base: needs a restack", systemImage: "exclamationmark.triangle").foregroundStyle(theme.limited).font(.ah(.callout))
            case "merging", "queued":
                Label(layer.needs == "queued" ? "In GitHub’s merge queue" : "GitHub is merging it", systemImage: "clock").foregroundStyle(theme.run).font(.ah(.callout))
            default:
                EmptyView()
            }
            if let verdict = confidence.verdict {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Re-review of the fixes — the model’s verdict, for you to accept or not").font(.ah(.caption)).foregroundStyle(theme.faint)
                    Text(verdict.summary).font(.ah(.callout))
                    ForEach(verdict.items, id: \.id) { item in
                        Label("Finding \(item.id): \(item.verdict) — \(item.evidence)", systemImage: item.verdict == "addressed" ? "checkmark" : item.verdict == "partly" ? "circle.lefthalf.filled" : "xmark").font(.ah(.caption))
                    }
                    if !verdict.unrequested.isEmpty {
                        Text("Changes nobody asked for:").font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.limited)
                        ForEach(verdict.unrequested, id: \.self) { change in
                            Text("• \(change.title)\(change.path.map { " (\($0))" } ?? "")").font(.ah(.caption))
                        }
                    }
                    Button("Accept These Fixes") { Task { await model.acceptFixes() } }.buttonStyle(.bordered)
                }
                .padding(12)
                .background(theme.tile, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            if confidence.agentWorking, let dispatch = layer.dispatch {
                Label("\(dispatch.targetTitle ?? "The agent") is fixing \(dispatch.findings.count) finding\(dispatch.findings.count == 1 ? "" : "s")", systemImage: "wrench.and.screwdriver")
                    .foregroundStyle(theme.run)
            }
        }
    }

    private func reviewState(_ confidence: LayerConfidence) -> CheckRow.State {
        switch confidence.review {
        case .current, .rebasedSamePatch: return .ok
        case .changedSinceReview: return .attention
        case .notReviewed: return .todo
        }
    }

    private func checksState(_ outcome: Checks.Outcome) -> CheckRow.State {
        switch outcome {
        case .passing: return .ok
        case .failing: return .no
        case .pending: return .waiting
        case .none: return .unknown
        }
    }

    // MARK: The decision bar

    @ViewBuilder
    private func bar(_ layer: Layer, _ confidence: LayerConfidence, _ proxy: ScrollViewProxy) -> some View {
        GlassEffectContainer(spacing: 10) {
            // Writing to the reviewer, the keyboard is up and the bar would ride on it over
            // the thread: it steps aside until the field lets go.
            if asking {
                EmptyView()
            } else if let selected = selectedLines, let line = selected.lines.first, let number = line.number {
                lineBar(layer, selected.path, number, line, proxy)
                    .transition(.blurReplace)
            } else {
                decisionBar(layer, confidence)
                    .transition(.blurReplace)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, asking ? 0 : 6)
        .padding(.bottom, asking ? 0 : 8)
        .animation(.snappy(duration: 0.25), value: selectedLines?.index)
        .animation(.snappy(duration: 0.3), value: confidence)
        .animation(.snappy(duration: 0.25), value: asking)
    }

    private func lineBar(_ layer: Layer, _ path: String, _ number: Int, _ line: DiffLine, _ proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Line \(number)").font(.ah(.subheadline).weight(.semibold))
                Text((path as NSString).lastPathComponent).font(.ahMono(.caption2)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.middle)
            }
            .padding(.leading, 6)
            Spacer(minLength: 4)
            Button {
                model.attach(.lines(pr: layer.pr, path: path, start: number, end: number, text: line.text))
                selectedLines = nil
                withAnimation(.smooth) { proxy.scrollTo("challenge", anchor: .top) }
                // The field is only there to take the keyboard once the scroll has built it.
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    asking = true
                }
            } label: {
                Label("Ask", systemImage: "bubble.left").font(.ah(.subheadline).weight(.semibold))
            }
            .buttonStyle(.glass)
            Button { addingFinding = true } label: {
                Label("Finding", systemImage: "flag").font(.ah(.subheadline).weight(.semibold))
            }
            .buttonStyle(.glass)
            Button {
                selectedLines = nil
            } label: {
                Image(systemName: "xmark").font(.ah(.subheadline).weight(.semibold)).frame(width: 20, height: 20)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel("Let go of the line")
        }
        .padding(6)
        .glassEffect(.regular, in: Capsule())
    }

    private func decisionBar(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        // One row while it fits; at the largest type sizes the decision takes a row of its own
        // over the next layer and the menu, rather than being cut to "I reviewe…".
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                primary(layer, confidence)
                    .frame(maxWidth: .infinity)
                secondary(layer, confidence)
            }
            VStack(spacing: 8) {
                primary(layer, confidence)
                    .frame(maxWidth: .infinity)
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    secondary(layer, confidence)
                }
            }
        }
    }

    @ViewBuilder
    private func secondary(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        if let next = model.neighbor(1) {
            Button { go(to: next) } label: {
                HStack(spacing: 4) {
                    Text(next.role.isEmpty ? "#\(next.pr)" : next.role).lineLimit(1)
                    Image(systemName: "chevron.down")
                }
                .font(.ah(.subheadline).weight(.semibold))
                .padding(.vertical, 6)
            }
            .buttonStyle(.glass)
            .accessibilityLabel("Next layer, \(next.name)")
            .keyboardShortcut(.downArrow, modifiers: [.command, .option])
        }
        more(layer, confidence)
    }

    /// The one thing to do next: review this revision, merge it, or what it's waiting on.
    @ViewBuilder
    private func primary(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        let reviewed = confidence.review == .current || confidence.review == .rebasedSamePatch
        if layer.state == "merged" || layer.state == "closed" {
            Label(layer.state == "merged" ? "Merged" : "Closed", systemImage: layer.state == "merged" ? "checkmark.circle.fill" : "xmark.circle")
                .font(.ah(.subheadline).weight(.semibold))
                .foregroundStyle(layer.state == "merged" ? theme.done : theme.muted)
                .frame(maxWidth: .infinity, minHeight: 44)
                .glassEffect(.regular, in: Capsule())
        } else if !reviewed {
            Button {
                Task {
                    await model.markReviewed(true)
                    if model.layer?.approved == true { Haptics.success() }
                }
            } label: {
                HStack(spacing: 6) {
                    if model.loading.contains("approve") { ProgressView().tint(theme.accentInk) } else { Image(systemName: "checkmark.seal") }
                    Text(confidence.review == .changedSinceReview ? "Reviewed the changes" : "I reviewed \(layer.headSha.prefix(7))").lineLimit(1)
                }
                .font(.ah(.subheadline).weight(.semibold))
                .foregroundStyle(theme.accentInk)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.glassProminent)
            .tint(theme.accentStrong)
            .disabled(model.loading.contains("approve"))
        } else if confidence.readyToMerge {
            Button { mergeTarget = layer } label: {
                // Ink on the green, as ah's light controls carry it: white on it barely read.
                Label("Merge #\(layer.pr)…", systemImage: "arrow.triangle.merge")
                    .font(.ah(.subheadline).weight(.semibold))
                    .foregroundStyle(theme.background)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.glassProminent)
            .tint(theme.done)
        } else {
            VStack(spacing: 1) {
                Label("Reviewed", systemImage: "checkmark.seal.fill")
                    .font(.ah(.subheadline).weight(.semibold))
                    .foregroundStyle(theme.done)
                if let waiting = confidence.missing.first {
                    Text("Waiting on: \(waiting)").font(.ah(.caption2)).foregroundStyle(theme.muted).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .glassEffect(.regular, in: Capsule())
            .accessibilityElement(children: .combine)
        }
    }

    /// Everything else a layer can be asked for, in one place.
    private func more(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        Menu {
            if let previous = model.neighbor(-1) {
                Button("Previous Layer: \(previous.name)", systemImage: "chevron.up") { go(to: previous) }
                    .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            }
            Section {
                Button("Request Fixes…", systemImage: "wrench.and.screwdriver") { dispatching = .some(nil) }
                    .disabled(model.findings(for: layer.pr).filter(\.isOpen).isEmpty)
                Button("Ask the Agent to Merge…", systemImage: "arrow.triangle.merge") { dispatching = .some("merge") }
                    .disabled(!confidence.readyToMerge)
                switch layer.needs {
                case "restack", "conflict":
                    Button("Ask the Agent to Restack…", systemImage: "square.stack.3d.up") { dispatching = .some("restack") }
                case "retarget":
                    Button("Retarget onto \(model.stack?.trunk ?? "trunk")", systemImage: "arrow.turn.down.right") { Task { await model.retarget() } }
                default:
                    EmptyView()
                }
                if layer.draft {
                    Button("Mark Ready for Review", systemImage: "eye") { Task { await model.ready() } }
                }
            }
            if layer.approved && confidence.review != .changedSinceReview {
                Button("Withdraw My Review", systemImage: "arrow.uturn.backward", role: .destructive) { Task { await model.markReviewed(false) } }
            }
            if let url = URL(string: layer.url) {
                Section {
                    Button("Open on GitHub", systemImage: "safari") { openURL(url) }
                    ShareLink(item: url) { Label("Share the PR", systemImage: "square.and.arrow.up") }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.ah(.subheadline).weight(.semibold))
                .frame(width: 22, height: 22)
                .padding(.vertical, 6)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel("More for \(layer.name)")
    }

    /// On a phone, puts the path at the layer shown, without the stack's animation, so a link
    /// or a restored window lands where you are.
    private func followSelection() {
        guard scene.narrow, let id = model.stack?.id, let pr = model.selectedPR, let last = scene.reviewPath.last, last.stack == id, last.pr != pr else { return }
        var quiet = Transaction()
        quiet.disablesAnimations = true
        withTransaction(quiet) { scene.reviewPath[scene.reviewPath.count - 1] = ReviewRoute(stack: id, pr: pr) }
    }

    /// Another layer of the stack: in place beside the list, as its own page on a phone.
    private func go(to layer: Layer) {
        Haptics.selection()
        if scene.narrow, let id = model.stack?.id, !scene.reviewPath.isEmpty {
            scene.reviewPath[scene.reviewPath.count - 1] = ReviewRoute(stack: id, pr: layer.pr)
        } else {
            Task { await model.select(layer.pr) }
        }
    }
}

/// The question for the reviewer, in the composer's shape: a rounded field, and Send as its
/// accent circle. Its own view, holding its own text: as the layer page's state, every
/// keystroke drew the whole page again (the briefing, the diff, the thread's Markdown).
private struct ReviewerQuestionField: View {
    let model: ReviewModel
    var focus: FocusState<Bool>.Binding
    @Environment(\.theme) private var theme
    @State private var question = ""

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask the reviewer about this layer", text: $question, axis: .vertical)
                .lineLimit(1...6)
                .focused(focus)
                .accessibilityIdentifier("reviewer-question")
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(theme.tile, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            let empty = question.trimmingCharacters(in: .whitespaces).isEmpty
            Button {
                let text = question
                question = ""
                // Not lost when it doesn't go: back in the field (unless a new one's begun).
                Task { if !(await model.ask(text)), question.isEmpty { question = text } }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(theme.accentInk)
                    .frame(width: 32, height: 32)
                    .background(theme.accentStrong, in: Circle())
                    .opacity(empty ? 0.45 : 1)
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .padding(.bottom, 4)
            .disabled(empty)
            .keyboardShortcut(.return, modifiers: .command)
            .accessibilityLabel("Ask")
        }
    }
}

/// One file's lines. Its own view, the same until its lines or its picked line change: a
/// tap on one file, or a fold of another, leaves the rest of the diff as it was drawn.
private struct DiffFileBody: View, Equatable {
    let file: FileDiff
    let selected: Int?
    var maxLines: Int? = 300
    let pick: (Int, DiffLine) -> Void

    nonisolated static func == (a: DiffFileBody, b: DiffFileBody) -> Bool {
        a.selected == b.selected && a.maxLines == b.maxLines && a.file == b.file
    }

    var body: some View {
        DiffLinesView(lines: file.lines, maxLines: maxLines, onLineAt: pick, selected: selected.map { [$0] } ?? [], idPrefix: file.path)
    }
}

/// Where a diff is about to be: a few lines' worth of its shape, breathing, rather than a
/// spinner in an empty box.
private struct DiffPlaceholder: View {
    @Environment(\.theme) private var theme
    private static let widths: [CGFloat] = [0.55, 0.82, 0.4, 0.7, 0.62, 0.3]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Self.widths.indices, id: \.self) { index in
                Capsule()
                    .fill(theme.text.opacity(0.08))
                    .frame(height: 8)
                    .frame(width: 240 * Self.widths[index])
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .breathing(low: 0.55)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading the diff")
    }
}

/// A short tinted word: a layer's status, Draft.
struct StatusTag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.ah(.caption2).weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }
}

/// One line of a checklist: its state as a glyph in the state's color, the words in the text's.
struct CheckRow: View {
    enum State { case ok, no, waiting, todo, attention, unknown }
    let state: State
    let text: String
    var detail: String? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(text).foregroundStyle(theme.text)
                if let detail { Text(detail).font(.ah(.caption)).foregroundStyle(theme.muted) }
            }
            Spacer(minLength: 0)
        }
        .font(.ah(.callout))
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch state {
        case .ok: return "checkmark.circle.fill"
        case .no: return "xmark.circle.fill"
        case .waiting: return "clock.fill"
        case .todo: return "circle.dashed"
        case .attention: return "exclamationmark.circle.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    private var color: Color {
        switch state {
        case .ok: return theme.done
        case .no: return theme.danger
        case .waiting: return theme.run
        case .todo: return theme.muted
        case .attention: return theme.brand
        case .unknown: return theme.limited
        }
    }
}

private struct DispatchKind: Identifiable {
    let kind: String?
    var id: String { kind ?? "fixes" }
}

private struct FindingRow: View {
    let finding: Finding
    let model: ReviewModel
    let resolve: () -> Void
    /// Scrolls the page to the finding's line, when the diff shown has it.
    var show: (() -> Void)? = nil
    @Environment(\.theme) private var theme
    /// Waiving a blocking finding: the host wants a reason, and refused it without one.
    @State private var waiving = false
    @State private var reason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(finding.severity.rawValue).font(.ah(.caption2).weight(.bold)).textCase(.uppercase)
                    .foregroundStyle(finding.severity == .blocking ? theme.danger : finding.severity == .should ? theme.limited : theme.muted)
                Text(finding.title).font(.ah(.callout).weight(.medium)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                Text(finding.state.label).font(.ah(.caption)).foregroundStyle(theme.faint)
                menu
            }
            if !finding.body.isEmpty { MarkdownView(finding.body, compact: true) }
            HStack(spacing: 6) {
                Text("from \(finding.source)").font(.ah(.caption2)).foregroundStyle(theme.faint)
                if let path = finding.path {
                    let where_ = "\((path as NSString).lastPathComponent)\(finding.lineStart.map { ":\($0)" } ?? "")"
                    if let show {
                        Button(action: show) {
                            Label(where_, systemImage: "arrow.down.right.circle").font(.ahMono(.caption2))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(theme.accentStrong)
                        .accessibilityLabel("Show \(where_) in the diff")
                    } else {
                        Text(where_).font(.ahMono(.caption2)).foregroundStyle(theme.faint)
                    }
                }
            }
            // The reviewer's proposal waits on you: keep it or let it go, in plain sight.
            if finding.state == .proposed {
                HStack(spacing: 8) {
                    Button("Keep", systemImage: "checkmark") { Task { await model.setFinding(finding, state: .open) } }
                        .buttonStyle(.bordered)
                        .tint(theme.accentStrong)
                    Button("Dismiss", systemImage: "xmark") { Task { await model.setFinding(finding, state: .dismissed) } }
                        .buttonStyle(.bordered)
                        .tint(theme.muted)
                }
                .font(.ah(.caption).weight(.semibold))
                .controlSize(.small)
                .padding(.top, 2)
            }
        }
        .contextMenu { actions }
        .padding(10)
        .background(theme.raised.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .alert("Why Won’t It Be Fixed?", isPresented: $waiving) {
            TextField("Reason", text: $reason)
            Button("Won’t Fix") {
                let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await model.setFinding(finding, state: .wontfix, note: .some(note)) }
            }
            .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A blocking finding is waived with a reason, kept with it.")
        }
    }

    /// What a long press offers, behind a visible ⋯ as well: no one finds a long press.
    private var menu: some View {
        Menu { actions } label: {
            Image(systemName: "ellipsis").foregroundStyle(theme.muted).frame(width: 26, height: 20).contentShape(Rectangle())
        }
        .accessibilityLabel("More for \(finding.title)")
    }

    @ViewBuilder
    private var actions: some View {
        if finding.state == .proposed { Button("Keep It", systemImage: "checkmark") { Task { await model.setFinding(finding, state: .open) } } }
        if let show { Button("Show in the Diff", systemImage: "arrow.down.right.circle", action: show) }
        Button("Ask the Reviewer About It", systemImage: "bubble.left") { model.attach(.finding(id: finding.id)) }
        if finding.ghThread { Button("Reply and Resolve on GitHub…", systemImage: "checkmark.bubble") { resolve() } }
        if let url = finding.ghUrl.flatMap(URL.init(string:)) { Link(destination: url) { Label("Open on GitHub", systemImage: "arrow.up.right.square") } }
        Menu("Severity") { ForEach(Finding.Severity.allCases, id: \.self) { s in Button(s.label) { Task { await model.setFinding(finding, severity: s) } } } }
        Button("Mark Addressed", systemImage: "checkmark.circle") { Task { await model.setFinding(finding, state: .addressed) } }
        Button(finding.severity == .blocking ? "Won’t Fix…" : "Won’t Fix", systemImage: "xmark.circle") {
            if finding.severity == .blocking {
                reason = ""
                waiving = true
            } else {
                Task { await model.setFinding(finding, state: .wontfix) }
            }
        }
        Button("Dismiss", systemImage: "trash", role: .destructive) { Task { await model.setFinding(finding, state: .dismissed) } }
    }
}

private struct NewFindingSheet: View {
    let model: ReviewModel
    let path: String?
    let lines: [DiffLine]
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var body_ = ""
    @State private var severity: Finding.Severity = .should
    @FocusState private var naming: Bool
    @FocusState private var detailing: Bool
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            AhForm {
                if let path {
                    // The line itself under its place: what the finding is about, in sight.
                    Section("Where") {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(path)\(lines.first?.number.map { ":\($0)" } ?? "")").font(.ahMono(.caption)).foregroundStyle(theme.muted)
                            if let code = lines.first?.text.trimmingCharacters(in: .whitespaces), !code.isEmpty {
                                Text(code).font(.ahMono(.footnote)).lineLimit(3)
                            }
                        }
                    }
                }
                Section {
                    TextField("What’s wrong", text: $title)
                        .focused($naming)
                        .submitLabel(.next)
                        .onSubmit { detailing = true }
                    TextField("Details (optional)", text: $body_, axis: .vertical)
                        .lineLimit(2...6)
                        .focused($detailing)
                }
                Section("Severity") {
                    Picker("Severity", selection: $severity) { ForEach(Finding.Severity.allCases, id: \.self) { Text($0.label).tag($0) } }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                }
            }
            // A new finding starts with its name: the keyboard's up for it.
            .onAppear { naming = true }
            .navigationTitle("New Finding")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let numbers = lines.compactMap(\.number)
                        Task {
                            await model.addFinding(title: title, body: body_, severity: severity, path: path, lines: numbers.isEmpty ? nil : numbers.min()!...numbers.max()!)
                            dismiss()
                        }
                    }.keyboardShortcut(.return, modifiers: .command)
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Request fixes: the open findings become one instruction for the implementing agent.
private struct DispatchSheet: View {
    let scene: SceneModel
    let model: ReviewModel
    let layer: Layer
    /// nil: fix findings; "restack" or "merge": the agent carries that out.
    var kind: String? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<Int> = []
    @State private var text = ""
    @State private var target: String?
    @State private var sending = false

    var body: some View {
        NavigationStack {
            AhForm {
                if kind == nil {
                    Section("Findings to fix") {
                        ForEach(model.findings(for: layer.pr).filter(\.isOpen)) { finding in
                            Toggle(finding.title, isOn: Binding(get: { selected.contains(finding.id) }, set: { on in if on { selected.insert(finding.id) } else { selected.remove(finding.id) } }))
                        }
                    }
                }
                Section {
                    TextEditor(text: $text).frame(minHeight: 160).font(.ah(.callout))
                    if kind == nil {
                        Button("Draft from the Findings") {
                            Task { text = await model.draftDispatch(findings: Array(selected)) ?? text }
                        }
                    }
                } header: {
                    Text("Instruction")
                } footer: {
                    if kind != nil { Text("The agent does this itself; the review follows what lands on GitHub. Nothing is marked reviewed for you.") }
                }
                Section("Send to") {
                    Picker("Session", selection: $target) {
                        if let owner = model.stack?.owner { Text("“\(owner.title)” (fixes go here)").tag(Optional(owner.uid)) }
                        if let origin = model.stack?.origin, origin.uid != model.stack?.owner?.uid { Text("“\(origin.title)” (made the stack)").tag(Optional(origin.uid)) }
                        Text("A new agent in a fresh worktree").tag(String?.none)
                    }
                }
            }
            // A task sheet's title sits in its bar, as New Session's and Fork's do: large, a
            // long one was cut off ("Ask the agent to mer…").
            .navigationTitle(kind == "restack" ? "Restack \(layer.name)" : kind == "merge" ? "Ask the agent to merge" : "Request fixes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "Sending…" : "Send") {
                        sending = true
                        Task {
                            let preset = target == nil ? (scene.hub?.presets(host: nil).first { $0.offered && !$0.isShell }?.id) : nil
                            if let result = await model.dispatch(findings: kind == nil ? Array(selected) : [], text: text, to: target, newSessionPreset: preset, kind: kind) {
                                scene.toast(result.outcome == "queued" ? "Queued for the agent" : "Sent to the agent")
                                dismiss()
                            }
                            sending = false
                        }
                    }.keyboardShortcut(.return, modifiers: .command)
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || sending)
                        .buttonStyle(.glassProminent)
                }
            }
            .task {
                selected = Set(model.findings(for: layer.pr).filter(\.isOpen).map(\.id))
                target = model.stack?.owner?.uid ?? model.stack?.origin?.uid
                if let kind { text = await model.draftDispatch(findings: [], kind: kind, method: kind == "merge" ? model.stack?.mergeMethod : nil) ?? "" }
            }
        }
    }
}

/// Merging one layer: exactly what lands, what's known about it, and a fresh check at the
/// moment you confirm (a head that moved stops it).
private struct MergeLayerSheet: View {
    let scene: SceneModel
    let model: ReviewModel
    let layer: Layer
    let confidence: LayerConfidence
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @State private var merging = false
    @State private var outcome: ReviewModel.MergeOutcome?

    var body: some View {
        NavigationStack {
            AhForm {
                Section("What lands") {
                    LabeledContent("PR", value: "#\(layer.pr) \(layer.title)")
                    LabeledContent("Into", value: layer.baseRef)
                    LabeledContent("Exactly this head", value: String(layer.headSha.prefix(12)))
                    LabeledContent("Method", value: model.stack?.mergeMethod ?? "merge")
                }
                Section("What’s known") {
                    Label(confidence.reviewText, systemImage: "checkmark.seal")
                    Label(confidence.checksText, systemImage: confidence.checks == .passing ? "checkmark.circle" : "exclamationmark.triangle")
                    if confidence.checks == .none { Text("No CI ran on this head. Merging relies on your review alone.").font(.ah(.caption)) }
                    Label("\(confidence.openFindings) open finding\(confidence.openFindings == 1 ? "" : "s"), \(confidence.blockingFindings) blocking", systemImage: "flag")
                }
                if let outcome {
                    Section {
                        switch outcome {
                        case .merged(let next, let restack, let waiting):
                            Label(waiting != nil ? "GitHub is finishing the merge" : "Merged", systemImage: "checkmark.circle").foregroundStyle(theme.done)
                            if !restack.isEmpty { Text("Needs a restack: \(restack.map { "#\($0)" }.joined(separator: ", "))") }
                            if let next { Button("Review #\(next) next") { dismiss() } }
                        case .changed(let message), .refused(let message):
                            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(theme.limited)
                        }
                    }
                }
            }
            .navigationTitle("Merge #\(layer.pr)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: outcome == nil ? .cancel : .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(merging ? "Merging…" : "Merge") {
                        merging = true
                        Task {
                            outcome = await model.merge(expectedHead: layer.headSha)
                            if case .merged = outcome { Haptics.success() } else { Haptics.failure() }
                            merging = false
                        }
                    }
                    .disabled(merging || outcome != nil)
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(merging)
    }
}

/// Merging the stack bottom-up: what lands, what holds it (and why), never marking a layer reviewed for you.
private struct StackMergeSheet: View {
    let model: ReviewModel
    let stack: ReviewStack
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @State private var method: String
    @State private var result: StackMergeResult?
    @State private var merging = false

    init(model: ReviewModel, stack: ReviewStack) {
        self.model = model
        self.stack = stack
        _method = State(initialValue: stack.mergeMethod)
    }

    var body: some View {
        let plan = StackMergePlan(stack: stack, method: method)
        NavigationStack {
            AhForm {
                Picker("Method", selection: $method) { ForEach(stack.methods, id: \.self) { Text($0).tag($0) } }
                Section("Bottom to top") {
                    ForEach(plan.rows) { row in
                        HStack {
                            Image(systemName: row.state == .ready ? "checkmark.circle.fill" : row.state == .waits ? "pause.circle" : "exclamationmark.circle")
                                .foregroundStyle(row.state == .ready ? theme.done : row.state == .waits ? theme.faint : theme.limited)
                            VStack(alignment: .leading) {
                                Text("#\(row.layer.pr) \(row.layer.title)").lineLimit(1)
                                if let why = row.why { Text(why).font(.ah(.caption)).foregroundStyle(theme.muted) }
                            }
                        }
                    }
                }
                if let result {
                    Section("Result") {
                        if !result.merged.isEmpty { Text("Merged \(result.merged.map { "#\($0)" }.joined(separator: ", "))") }
                        if let stopped = result.stopped { Text("Stopped at #\(stopped.pr): \(stopped.why)") }
                        if let waiting = result.waiting { Text("Waiting on \(waiting)") }
                        if !result.restack.isEmpty { Text("Needs a restack: \(result.restack.map { "#\($0)" }.joined(separator: ", "))") }
                    }
                }
            }
            .navigationTitle(plan.lands.isEmpty ? "Nothing can merge yet" : "Merge \(plan.lands.count) layer\(plan.lands.count == 1 ? "" : "s")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: result == nil ? .cancel : .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(merging ? "Merging…" : "Merge") {
                        merging = true
                        Task {
                            result = await model.mergeStack(method: method, upTo: plan.upTo?.pr)
                            merging = false
                        }
                    }
                    .disabled(plan.lands.isEmpty || merging || result != nil)
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .interactiveDismissDisabled(merging)
    }
}
