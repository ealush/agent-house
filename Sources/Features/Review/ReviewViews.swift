import SwiftUI

/// Review's landing: stacks in progress, and starting a review.
struct ReviewHomeView: View {
    @Bindable var scene: SceneModel
    @State var model: ReviewModel
    @Environment(\.theme) private var theme
    @State private var starting = false

    var body: some View {
        List {
            if let error = model.error { Banner(text: error, tone: .error) }
            if model.stacks.isEmpty && !model.loading.contains("stacks") {
                EmptyState(symbol: "square.stack.3d.up", title: "No stacks in review", message: "Start from a PR chain, a GitHub stack, or PRs you pick.", action: ("Start a review", { starting = true }))
            }
            ForEach(model.stacks) { stack in
                Button {
                    scene.openReview(ReviewRoute(stack: stack.id))
                } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(stack.title).font(.headline).foregroundStyle(theme.text)
                                Text("\(stack.repo) → \(stack.trunk)").font(.caption).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            if stack.needsYou > 0 {
                                Text("\(stack.needsYou) need\(stack.needsYou == 1 ? "s" : "") you")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(theme.brand.opacity(0.14), in: Capsule())
                                    .foregroundStyle(theme.brand)
                            }
                        }
                        SpineBar(spine: stack.spine)
                        Text(stack.statusLine).font(.caption).foregroundStyle(theme.muted)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
            }
        }
        .navigationTitle("Review")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { starting = true } label: { Label("Start a review", systemImage: "plus") }
                    .buttonStyle(.glassProminent)
            }
        }
        .task { await model.loadList() }
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
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(spine, id: \.pr) { layer in
                VStack(alignment: .leading, spacing: 4) {
                    Capsule()
                        .fill(LayerColor.color(layer.status, theme))
                        .frame(height: 6)
                    if spine.count <= 8 {
                        Text("#\(layer.pr)").font(.caption2.monospacedDigit()).foregroundStyle(theme.faint)
                    }
                }
                .frame(maxWidth: 140)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("#\(layer.pr) \(layer.status.word)")
            }
        }
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
            if let error { Banner(text: error, tone: .error) }
            if repo == nil {
                Section("Repository") {
                    ForEach(model.repos, id: \.root) { r in
                        Button("\(r.repo) (\(r.trunk))") {
                            repo = r
                            Task {
                                do { candidates = try await model.review.candidates(root: r.root) } catch { self.error = APIError.wrap(error).message }
                            }
                        }
                    }
                }
            } else if let candidates {
                if !candidates.native.isEmpty {
                    Section("GitHub stacks") {
                        ForEach(candidates.native, id: \.number) { stack in
                            Button("Stack #\(stack.number): \(stack.prs.map { "#\($0)" }.joined(separator: " → ")) onto \(stack.base)") { start(.native(stack.number)) }
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
                                Text("#\(pr.number) \(pr.title)").lineLimit(1)
                                if let order = picked.firstIndex(of: pr.number) { Spacer(); Text("\(order + 1)").foregroundStyle(theme.muted) }
                            }
                        }
                        .disabled(pr.inStack != nil)
                    }
                    Button("Review these \(picked.count) PRs") { start(.manual(picked)) }.disabled(picked.isEmpty)
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Start a review")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction) } }
        .task { if model.repos.isEmpty { await model.loadList() } }
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
        var body: some View {
            Button {
                pick(tree.pr.number)
            } label: {
                HStack {
                    Text(String(repeating: "  ", count: depth) + "#\(tree.pr.number) \(tree.pr.title)").lineLimit(1)
                    Spacer()
                    Text("+\(tree.pr.additions) −\(tree.pr.deletions)").font(.caption.monospacedDigit())
                }
            }
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
                            EmptyState(symbol: "square.stack.3d.up", title: "Pick a layer", message: "Its evidence and decision show here.")
                        }
                    }
                } else {
                    spine(stack)
                }
            } else if let error = model.error {
                Banner(text: error, tone: .error).padding()
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.stack?.title ?? "Stack")
        .navigationBarTitleDisplayMode(scene.narrow ? .inline : .automatic)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Sync with GitHub").tint(.primary)
                Button { mergingStack = true } label: { Label("Merge the stack", systemImage: "arrow.triangle.merge") }
                    .disabled(model.stack == nil)
                    .tint(.primary)
                Button { managing = true } label: { Label("Manage", systemImage: "slider.horizontal.3") }
                    .disabled(model.stack == nil)
                    .tint(.primary)
            }
        }
        .task(id: route) { await model.open(route) }
        .sheet(isPresented: $mergingStack) {
            if let stack = model.stack { StackMergeSheet(model: model, stack: stack) }
        }
        .sheet(isPresented: $managing) {
            if let stack = model.stack { StackManageSheet(model: model, stack: stack) }
        }
        .onKeyPress(phases: .down) { press in
            // j/k walk the layers when not typing, as on the web.
            guard let stack = model.stack, let current = model.selectedPR, let index = stack.layers.firstIndex(where: { $0.pr == current }) else { return .ignored }
            switch press.characters {
            case "j": if index + 1 < stack.layers.count { Task { await model.select(stack.layers[index + 1].pr) } }
            case "k": if index > 0 { Task { await model.select(stack.layers[index - 1].pr) } }
            default: return .ignored
            }
            return .handled
        }
    }

    private func spine(_ stack: ReviewStack) -> some View {
        // On a phone a layer pushes, so no row stays lit after coming back.
        List(selection: Binding(get: { scene.narrow ? nil : model.selectedPR }, set: { pr in if let pr { Task { await model.select(pr) } } })) {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    if scene.narrow {
                        // The bar's title is one short line on a phone; the stack's name is read here.
                        Text(stack.title).font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    }
                    Text("\(stack.repo) → \(stack.trunk)").font(.caption).foregroundStyle(theme.muted)
                    if let next = stack.next, let layer = stack.layers.first(where: { $0.pr == next }) {
                        Label("Up next: \(layer.name) — \(layer.title)", systemImage: "arrow.right.circle").font(.subheadline.weight(.semibold))
                    }
                    if let origin = stack.origin {
                        Button { scene.open(origin.key) } label: { Label("Made in “\(origin.title)”", systemImage: "terminal") }.font(.caption)
                    }
                    if let owner = stack.owner, owner.uid != stack.origin?.uid {
                        Button { scene.open(owner.key) } label: { Label("Fixes go to “\(owner.title)”", systemImage: "wrench.and.screwdriver") }.font(.caption)
                    }
                    if let syncError = stack.syncError { Text(syncError).font(.caption).foregroundStyle(theme.danger) }
                }
            }
            Section("Pinned decisions") {
                ForEach(stack.decisions) { decision in
                    Text(decision.text).font(.callout)
                        .swipeActions { Button("Unpin", role: .destructive) { Task { await model.removeDecision(decision.id) } } }
                }
                TextField("Pin a decision the whole stack follows", text: $decision)
                    .font(.callout)
                    .onSubmit {
                        let text = decision.trimmingCharacters(in: .whitespacesAndNewlines)
                        decision = ""
                        if !text.isEmpty { Task { await model.addDecision(text) } }
                    }
            }
            Section("Layers, bottom to top") {
                ForEach(stack.layers) { layer in
                    LayerRow(layer: layer)
                        .tag(layer.pr)
                        .background {
                            if scene.narrow {
                                NavigationLink("", value: ReviewRoute(stack: stack.id, pr: layer.pr)).opacity(0)
                            }
                        }
                }
            }
            if stack.planPath != nil {
                Section("Plan") {
                    if let plan = model.plan?.text { MarkdownView(plan, compact: true) } else { Button("Show the plan") { Task { await model.loadPlan() } } }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationDestination(for: ReviewRoute.self) { route in
            LayerView(scene: scene, model: model).task { if let pr = route.pr { await model.select(pr) } }
        }
    }
}

private struct LayerRow: View {
    let layer: Layer
    @Environment(\.theme) private var theme

    var body: some View {
        let confidence = LayerConfidence(layer: layer)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(layer.name).font(.subheadline.weight(.semibold))
                Text(layer.title).font(.subheadline).lineLimit(1)
                Spacer()
                Text(layer.status.word).font(.caption.weight(.semibold)).foregroundStyle(tone(layer.status))
            }
            HStack(spacing: 8) {
                Label(confidence.checksText, systemImage: checksSymbol(confidence.checks)).foregroundStyle(checksColor(confidence.checks))
                if layer.blocking > 0 { Label("\(layer.blocking) blocking", systemImage: "exclamationmark.octagon").foregroundStyle(theme.danger) }
                else if layer.open > 0 { Label("\(layer.open) open", systemImage: "flag").foregroundStyle(theme.muted) }
                if confidence.review == .changedSinceReview { Label("changed", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(theme.brand) }
            }
            .font(.caption2)
        }
        .accessibilityElement(children: .combine)
    }

    private func tone(_ status: LayerStatus) -> Color {
        switch status.tone {
        case .needs: return theme.brand
        case .busy: return theme.run
        case .ready, .merged: return theme.done
        default: return theme.muted
        }
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
/// decide, and merge exactly what you reviewed.
struct LayerView: View {
    @Bindable var scene: SceneModel
    @Bindable var model: ReviewModel
    @Environment(\.theme) private var theme
    @State private var question = ""
    @State private var selectedLines: (path: String, lines: [DiffLine])?
    @State private var addingFinding = false
    @State private var dispatching: String?? = nil
    @State private var merging = false
    @State private var resolving: Finding?

    var body: some View {
        if let layer = model.layer, let confidence = model.confidence, let stack = model.stack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header(layer, confidence)
                    understand(layer)
                    inspect(layer)
                    challenge(layer, stack)
                    verify(layer, confidence)
                    decide(layer, confidence)
                }
                .padding()
            }
            .navigationTitle("\(layer.name) \(layer.title)")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $addingFinding) {
                NewFindingSheet(model: model, path: selectedLines?.path, lines: selectedLines?.lines ?? [])
            }
            .sheet(item: Binding(get: { dispatching.map { DispatchKind(kind: $0) } }, set: { (item: DispatchKind?) in dispatching = item.map { $0.kind } })) { item in
                DispatchSheet(scene: scene, model: model, layer: layer, kind: item.kind)
            }
            .sheet(item: $resolving) { finding in
                ResolveThreadSheet(model: model, finding: finding)
            }
            .sheet(isPresented: $merging) {
                MergeLayerSheet(scene: scene, model: model, layer: layer, confidence: confidence)
            }
        }
    }

    private func header(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("#\(layer.pr)").font(.title3.monospacedDigit()).foregroundStyle(theme.muted)
                Text(layer.title).font(.title3.weight(.semibold))
                if layer.draft { Text("Draft").font(.caption).padding(4).background(theme.raised, in: Capsule()) }
            }
            Text("\(layer.headRef) → \(layer.baseRef) · head \(layer.headSha.prefix(7)) · by \(layer.author)").font(.caption.monospaced()).foregroundStyle(theme.muted)
            if !confidence.missing.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Before this can merge").font(.caption.weight(.semibold)).foregroundStyle(theme.muted)
                    ForEach(confidence.missing, id: \.self) { item in Label(item, systemImage: "circle").font(.callout) }
                }
                .padding(10)
                .background(theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if let url = URL(string: layer.url) { Link("Open on GitHub", destination: url).font(.caption) }
        }
    }

    private func section<Content: View>(_ title: String, _ symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol).font(.headline).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func understand(_ layer: Layer) -> some View {
        section("Understand", "lightbulb") {
            if let summary = layer.current?.summary, !summary.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Model briefing — a summary, not evidence").font(.caption).foregroundStyle(theme.faint)
                        Spacer()
                        if model.summarizing {
                            ProgressView().controlSize(.mini)
                        } else {
                            Button("Write Again", systemImage: "arrow.clockwise") { Task { await model.brief(force: true) } }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.borderless)
                                .font(.caption)
                                .help("Write the briefing again")
                        }
                    }
                    MarkdownView(summary, compact: true)
                }
                .padding(10)
                .background(theme.raised.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if model.summarizing {
                HStack(spacing: 10) {
                    ProgressView()
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Writing a briefing…").font(.subheadline)
                        Text("The model reads this layer’s diff and its stack. It shows here when it’s done.").font(.caption).foregroundStyle(theme.muted)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.raised.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if let blocked = model.briefingBlocked {
                VStack(alignment: .leading, spacing: 8) {
                    Label(blocked, systemImage: "text.bubble").font(.callout).foregroundStyle(theme.muted)
                    HStack {
                        if blocked.contains("Settings") {
                            Button("Open Settings") { scene.sheet = .settings(SettingsSection.subscriptions.rawValue) }.buttonStyle(.bordered)
                        }
                        Button("Try Again") { Task { await model.brief() } }.buttonStyle(.borderless)
                    }
                }
            } else {
                Button("Brief me on this layer", systemImage: "text.bubble") { Task { await model.brief() } }.buttonStyle(.bordered)
            }
            if let description = model.description, !description.body.isEmpty {
                DisclosureGroup("The PR’s description") {
                    MarkdownView(description.body, compact: true)
                        .environment(\.hostFiles, HostFiles(load: { [review = model.review, id = model.stack?.id ?? ""] src in try? await review.image(id, src: src) }, open: { _ in }))
                }
            }
        }
    }

    private func inspect(_ layer: Layer) -> some View {
        section("Inspect the code", "doc.text.magnifyingglass") {
            Picker("Diff", selection: Binding(get: { model.diffScope }, set: { scope in Task { await model.loadDiff(scope) } })) {
                ForEach(DiffScope.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            if let diff = model.diff {
                Text("\(diff.from.prefix(7))…\(diff.to.prefix(7))\(diff.kind == "range" ? " · range-diff (rebased)" : "")").font(.caption.monospaced()).foregroundStyle(theme.faint)
                if diff.truncated { Label("This diff is long; only its start is shown here.", systemImage: "scissors").font(.caption).foregroundStyle(theme.limited) }
                if diff.text.isEmpty {
                    Text(model.diffScope == .since ? "Nothing changed since your review." : "No changes.").foregroundStyle(theme.muted)
                } else {
                    ForEach(FileDiff.files(in: diff.text)) { file in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(file.path).font(.caption.monospaced().weight(.semibold))
                                Spacer()
                                Menu {
                                    Button("Ask the reviewer about this file") { model.attach(.file(pr: layer.pr, path: file.path)) }
                                } label: { Image(systemName: "ellipsis") }
                            }
                            DiffLinesView(lines: file.lines, maxLines: 300, onLine: { line in
                                guard let number = line.number else { return }
                                selectedLines = (file.path, [line])
                                model.attach(.lines(pr: layer.pr, path: file.path, start: number, end: number, text: line.text))
                            })
                        }
                    }
                }
            } else if model.loading.contains("diff") {
                ProgressView()
            }
            if let selected = selectedLines {
                HStack {
                    Text("\(selected.path):\(selected.lines.first?.number ?? 0)").font(.caption.monospaced())
                    Spacer()
                    Button("Add a finding here") { addingFinding = true }.buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
    }

    private func challenge(_ layer: Layer, _ stack: ReviewStack) -> some View {
        section("Challenge", "bubble.left.and.exclamationmark.bubble.right") {
            ForEach(model.thread.filter { $0.pr == nil || $0.pr == layer.pr }) { message in
                if message.role == "user" {
                    UserBubble(text: message.text)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Reviewer (a model)").font(.caption2).foregroundStyle(theme.faint)
                        MarkdownView(message.text, compact: true)
                    }
                }
            }
            if model.loading.contains("ask") { ProgressView() }
            if !model.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(model.attachments, id: \.key) { context in
                            Button {
                                model.attachments.removeAll { $0.key == context.key }
                            } label: {
                                Label(label(context), systemImage: "xmark").font(.caption)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
            HStack {
                TextField("Ask the reviewer about this layer", text: $question, axis: .vertical).textFieldStyle(.roundedBorder)
                Button {
                    let text = question
                    question = ""
                    Task { await model.ask(text) }
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .disabled(question.trimmingCharacters(in: .whitespaces).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
            Divider()
            let findings = model.findings(for: layer.pr)
            HStack {
                Text("Findings").font(.subheadline.weight(.semibold))
                Spacer()
                Button("Import GitHub threads") { Task { let n = await model.importThreads(); scene.toast(n == 0 ? "No new threads" : "Imported \(n)") } }.font(.caption)
                Button("Add") { selectedLines = nil; addingFinding = true }.font(.caption)
            }
            if findings.isEmpty { Text("No findings on this layer.").font(.callout).foregroundStyle(theme.muted) }
            ForEach(findings) { finding in FindingRow(finding: finding, model: model) { resolving = finding } }
        }
    }

    private func label(_ context: AskContext) -> String {
        switch context {
        case .finding(let id): return "Finding \(id)"
        case .file(_, let path): return (path as NSString).lastPathComponent
        case .lines(_, let path, let start, let end, _): return "\((path as NSString).lastPathComponent):\(start)\(end > start ? "–\(end)" : "")"
        }
    }

    private func verify(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        section("Verify", "checkmark.shield") {
            Label(confidence.reviewText, systemImage: confidence.review == .current || confidence.review == .rebasedSamePatch ? "checkmark.seal" : "seal")
                .foregroundStyle(confidence.review == .changedSinceReview ? theme.brand : theme.text)
            Label(confidence.checksText, systemImage: confidence.checks == .passing ? "checkmark.circle" : confidence.checks == .none ? "questionmark.circle" : confidence.checks == .pending ? "clock" : "xmark.circle")
                .foregroundStyle(confidence.checks == .passing ? theme.done : confidence.checks == .failing ? theme.danger : theme.limited)
            ForEach(layer.gates, id: \.key) { gate in
                HStack(alignment: .firstTextBaseline) {
                    Image(systemName: gate.ok ? "checkmark" : "xmark").foregroundStyle(gate.ok ? theme.done : theme.danger)
                    Text(gate.label)
                    if let detail = gate.detail { Text(detail).foregroundStyle(theme.muted) }
                }
                .font(.callout)
            }
            if let verdict = confidence.verdict {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Re-review of the fixes — the model’s verdict, for you to accept or not").font(.caption).foregroundStyle(theme.faint)
                    Text(verdict.summary).font(.callout)
                    ForEach(verdict.items, id: \.id) { item in
                        Label("Finding \(item.id): \(item.verdict) — \(item.evidence)", systemImage: item.verdict == "addressed" ? "checkmark" : item.verdict == "partly" ? "circle.lefthalf.filled" : "xmark").font(.caption)
                    }
                    if !verdict.unrequested.isEmpty {
                        Text("Changes nobody asked for:").font(.caption.weight(.semibold)).foregroundStyle(theme.limited)
                        ForEach(verdict.unrequested, id: \.self) { change in
                            Text("• \(change.title)\(change.path.map { " (\($0))" } ?? "")").font(.caption)
                        }
                    }
                    Button("Accept these fixes") { Task { await model.acceptFixes() } }.buttonStyle(.bordered)
                }
                .padding(10)
                .background(theme.raised.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if confidence.agentWorking, let dispatch = layer.dispatch {
                Label("\(dispatch.targetTitle ?? "The agent") is fixing \(dispatch.findings.count) finding\(dispatch.findings.count == 1 ? "" : "s")", systemImage: "wrench.and.screwdriver")
                    .foregroundStyle(theme.run)
            }
        }
    }

    private func decide(_ layer: Layer, _ confidence: LayerConfidence) -> some View {
        section("Decide", "hand.raised") {
            HStack {
                if layer.approved && confidence.review != .changedSinceReview {
                    Button("Withdraw my review") { Task { await model.markReviewed(false) } }.buttonStyle(.bordered)
                } else {
                    Button {
                        Task { await model.markReviewed(true) }
                        Haptics.success()
                    } label: {
                        Label("I reviewed \(layer.headSha.prefix(7))", systemImage: "checkmark.seal")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.accentStrong)
                }
                Button("Request fixes…") { dispatching = .some(nil) }.buttonStyle(.bordered).disabled(model.findings(for: layer.pr).filter(\.isOpen).isEmpty)
            }
            HStack {
                switch layer.needs {
                case "restack":
                    Button("Ask the agent to restack…") { dispatching = .some("restack") }.buttonStyle(.bordered)
                case "retarget":
                    Button("Retarget onto \(model.stack?.trunk ?? "trunk")") { Task { await model.retarget() } }.buttonStyle(.bordered)
                case "conflict":
                    Label("Conflicts with its base: needs a restack", systemImage: "exclamationmark.triangle").foregroundStyle(theme.limited)
                    Button("Ask the agent to restack…") { dispatching = .some("restack") }.buttonStyle(.bordered)
                case "merging", "queued":
                    Label(layer.needs == "queued" ? "In GitHub’s merge queue" : "GitHub is merging it", systemImage: "clock").foregroundStyle(theme.run)
                default:
                    EmptyView()
                }
                if layer.draft {
                    Button("Mark ready for review") { Task { await model.ready() } }.buttonStyle(.bordered)
                }
                Button("Ask the agent to merge…") { dispatching = .some("merge") }.buttonStyle(.bordered).disabled(!confidence.readyToMerge)
            }
            .font(.callout)
            Button {
                merging = true
            } label: {
                Label("Merge #\(layer.pr)…", systemImage: "arrow.triangle.merge")
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.done)
            .disabled(!confidence.readyToMerge)
            if !confidence.readyToMerge {
                Text("Merging opens once you’ve reviewed this exact revision and nothing blocks it.").font(.caption).foregroundStyle(theme.muted)
            }
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
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(finding.severity.rawValue).font(.caption2.weight(.bold)).textCase(.uppercase)
                    .foregroundStyle(finding.severity == .blocking ? theme.danger : finding.severity == .should ? theme.limited : theme.muted)
                Text(finding.title).font(.callout.weight(.medium))
                Spacer()
                Text(finding.state.rawValue).font(.caption).foregroundStyle(theme.faint)
            }
            if !finding.body.isEmpty { MarkdownView(finding.body, compact: true) }
            HStack(spacing: 6) {
                Text("from \(finding.source)").font(.caption2).foregroundStyle(theme.faint)
                if let path = finding.path { Text("\(path)\(finding.lineStart.map { ":\($0)" } ?? "")").font(.caption2.monospaced()).foregroundStyle(theme.faint) }
            }
        }
        .contextMenu {
            if finding.state == .proposed { Button("Keep it", systemImage: "checkmark") { Task { await model.setFinding(finding, state: .open) } } }
            Button("Ask the reviewer about it", systemImage: "bubble.left") { model.attach(.finding(id: finding.id)) }
            if finding.ghThread { Button("Reply and resolve on GitHub…", systemImage: "checkmark.bubble") { resolve() } }
            if let url = finding.ghUrl.flatMap(URL.init(string:)) { Link(destination: url) { Label("Open on GitHub", systemImage: "arrow.up.right.square") } }
            Menu("Severity") { ForEach(Finding.Severity.allCases, id: \.self) { s in Button(s.rawValue) { Task { await model.setFinding(finding, severity: s) } } } }
            Button("Mark addressed", systemImage: "checkmark.circle") { Task { await model.setFinding(finding, state: .addressed) } }
            Button("Won’t fix", systemImage: "xmark.circle") { Task { await model.setFinding(finding, state: .wontfix) } }
            Button("Dismiss", systemImage: "trash", role: .destructive) { Task { await model.setFinding(finding, state: .dismissed) } }
        }
        .padding(10)
        .background(theme.raised.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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

    var body: some View {
        NavigationStack {
            Form {
                if let path { Section("Where") { Text("\(path)\(lines.first?.number.map { ":\($0)" } ?? "")").font(.caption.monospaced()) } }
                TextField("What’s wrong", text: $title)
                TextField("Details (optional)", text: $body_, axis: .vertical)
                Picker("Severity", selection: $severity) { ForEach(Finding.Severity.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
            }
            .navigationTitle("New finding")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction) }
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
            Form {
                if kind == nil {
                    Section("Findings to fix") {
                        ForEach(model.findings(for: layer.pr).filter(\.isOpen)) { finding in
                            Toggle(finding.title, isOn: Binding(get: { selected.contains(finding.id) }, set: { on in if on { selected.insert(finding.id) } else { selected.remove(finding.id) } }))
                        }
                    }
                }
                Section {
                    TextEditor(text: $text).frame(minHeight: 160).font(.callout)
                    if kind == nil {
                        Button("Draft from the findings") {
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
            .navigationTitle(kind == "restack" ? "Restack \(layer.name)" : kind == "merge" ? "Ask the agent to merge" : "Request fixes")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction) }
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
    @State private var merging = false
    @State private var outcome: ReviewModel.MergeOutcome?

    var body: some View {
        NavigationStack {
            Form {
                Section("What lands") {
                    LabeledContent("PR", value: "#\(layer.pr) \(layer.title)")
                    LabeledContent("Into", value: layer.baseRef)
                    LabeledContent("Exactly this head", value: String(layer.headSha.prefix(12)))
                    LabeledContent("Method", value: model.stack?.mergeMethod ?? "merge")
                }
                Section("What’s known") {
                    Label(confidence.reviewText, systemImage: "checkmark.seal")
                    Label(confidence.checksText, systemImage: confidence.checks == .passing ? "checkmark.circle" : "exclamationmark.triangle")
                    if confidence.checks == .none { Text("No CI ran on this head. Merging relies on your review alone.").font(.caption) }
                    Label("\(confidence.openFindings) open finding\(confidence.openFindings == 1 ? "" : "s"), \(confidence.blockingFindings) blocking", systemImage: "flag")
                }
                if let outcome {
                    Section {
                        switch outcome {
                        case .merged(let next, let restack, let waiting):
                            Label(waiting != nil ? "GitHub is finishing the merge" : "Merged", systemImage: "checkmark.circle").foregroundStyle(.green)
                            if !restack.isEmpty { Text("Needs a restack: \(restack.map { "#\($0)" }.joined(separator: ", "))") }
                            if let next { Button("Review #\(next) next") { dismiss() } }
                        case .changed(let message), .refused(let message):
                            Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        }
                    }
                }
            }
            .navigationTitle("Merge #\(layer.pr)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: outcome == nil ? .cancel : .close) { dismiss() }.keyboardShortcut(.cancelAction) }
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
            Form {
                Picker("Method", selection: $method) { ForEach(stack.methods, id: \.self) { Text($0).tag($0) } }
                Section("Bottom to top") {
                    ForEach(plan.rows) { row in
                        HStack {
                            Image(systemName: row.state == .ready ? "checkmark.circle.fill" : row.state == .waits ? "pause.circle" : "exclamationmark.circle")
                                .foregroundStyle(row.state == .ready ? theme.done : row.state == .waits ? theme.faint : theme.limited)
                            VStack(alignment: .leading) {
                                Text("#\(row.layer.pr) \(row.layer.title)").lineLimit(1)
                                if let why = row.why { Text(why).font(.caption).foregroundStyle(theme.muted) }
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
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: result == nil ? .cancel : .close) { dismiss() }.keyboardShortcut(.cancelAction) }
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
