import SwiftUI

/// Keeping a stack in shape: its name, merge method, plan, who fixes it, its layers (order,
/// roles, skips, adding and removing PRs), linking it as a GitHub stack, and deleting the review.
struct StackManageSheet: View {
    @Bindable var model: ReviewModel
    let stack: ReviewStack
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @State private var title: String
    @State private var planPath: String
    @State private var owners: [OwnerSuggestion] = []
    @State private var addPRs = ""
    @State private var order: [Int]
    @State private var confirmDelete = false

    init(model: ReviewModel, stack: ReviewStack) {
        self.model = model
        self.stack = stack
        _title = State(initialValue: stack.title)
        _planPath = State(initialValue: stack.planPath ?? "")
        _order = State(initialValue: stack.layers.map(\.pr))
    }

    var body: some View {
        NavigationStack {
            AhForm {
                if let error = model.error { Banner(text: error, tone: .error) }
                Section("Stack") {
                    TextField("Name", text: $title).onSubmit { Task { await model.update(StackPatch(title: title)) } }
                    Picker("Merge method", selection: Binding(get: { stack.mergeMethod }, set: { m in Task { await model.update(StackPatch(mergeMethod: m)) } })) {
                        ForEach(stack.methods, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("Plan file (optional)", text: $planPath)
                        .font(.ahMono(.callout))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await model.update(StackPatch(planPath: .some(planPath.isEmpty ? nil : planPath))) } }
                }
                Section {
                    Picker("Fixes go to", selection: Binding(get: { stack.owner?.uid }, set: { uid in Task { await model.update(StackPatch(ownerUid: .some(uid))) } })) {
                        Text("Nobody yet").tag(String?.none)
                        ForEach(owners) { o in Text("\(o.title)\(o.origin ? " (made it)" : "") — \(o.reason)").tag(Optional(o.uid)) }
                    }
                } footer: {
                    Text("Requested fixes, restacks and merges you hand off go to this session.")
                }
                Section {
                    ForEach(order, id: \.self) { pr in
                        if let layer = stack.layers.first(where: { $0.pr == pr }) {
                            LayerManageRow(model: model, layer: layer)
                        }
                    }
                    .onMove { from, to in
                        order.move(fromOffsets: from, toOffset: to)
                        let next = order
                        Task { await model.update(StackPatch(order: next)) }
                    }
                    .onDelete { offsets in
                        for pr in offsets.map({ order[$0] }) { Task { await model.removeLayer(pr) } }
                        order.remove(atOffsets: offsets)
                    }
                    HStack {
                        TextField("Add PRs: 41, 42", text: $addPRs).keyboardType(.numbersAndPunctuation)
                        Button("Add") {
                            let prs = addPRs.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
                            addPRs = ""
                            Task {
                                await model.addLayers(prs)
                                order = model.stack?.layers.map(\.pr) ?? order
                            }
                        }
                        .disabled(addPRs.isEmpty)
                    }
                } header: {
                    Text("Layers, bottom to top")
                }
                if stack.source != "native" {
                    Section {
                        Button("Make It a GitHub Stack") { Task { await model.link() } }
                            .disabled(stack.link?.ok == false)
                        if let why = stack.link?.why { Text(why).font(.ah(.caption)).foregroundStyle(theme.muted) }
                    } footer: {
                        Text("GitHub then tracks the chain as one stack, and new PRs pushed onto it join this review.")
                    }
                }
                Section {
                    Button("Delete This Review", role: .destructive) { confirmDelete = true }
                } footer: {
                    Text("Only the review goes: PRs, branches and findings on GitHub stay.")
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Manage Stack")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(role: .close) { dismiss() }.tint(.primary) } }
            .task { owners = await model.owners() }
            .confirmationDialog("Delete this review?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await model.remove(); dismiss() } }
            }
        }
    }
}

private struct LayerManageRow: View {
    let model: ReviewModel
    let layer: Layer
    @State private var role: String
    @Environment(\.theme) private var theme

    init(model: ReviewModel, layer: Layer) {
        self.model = model
        self.layer = layer
        _role = State(initialValue: layer.role)
    }

    // The layer first (its number and title, whole width), its role under it as the field it
    // is, and Skip said beside its switch: the role's field wore the number as its prompt, and
    // the switch had no word.
    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("#\(layer.pr)").foregroundStyle(theme.muted).monospacedDigit()
                    Text(layer.title).lineLimit(2).foregroundStyle(layer.status == .skipped ? theme.muted : theme.text)
                }
                TextField("Role (optional)", text: $role)
                    .font(.ah(.caption))
                    .foregroundStyle(theme.text2)
                    .onSubmit { patch(LayerPatch(role: role)) }
            }
            Spacer(minLength: 6)
            Toggle(isOn: Binding(get: { layer.status == .skipped }, set: { on in patch(LayerPatch(skipped: on)) })) {
                Text("Skip").font(.ah(.caption)).foregroundStyle(theme.muted)
            }
            .fixedSize()
            .accessibilityLabel("Skip #\(layer.pr)")
        }
        .padding(.vertical, 2)
    }

    private func patch(_ p: LayerPatch) {
        Task {
            model.selectedPR = layer.pr
            await model.setLayer(p)
        }
    }
}

/// Replying on a GitHub review thread, then resolving it.
struct ResolveThreadSheet: View {
    let model: ReviewModel
    let finding: Finding
    @Environment(\.dismiss) private var dismiss
    @State private var reply = ""

    var body: some View {
        NavigationStack {
            AhForm {
                Section("Thread") { Text(finding.title).font(.ah(.callout)) }
                Section("Your reply") { TextEditor(text: $reply).frame(minHeight: 120) }
            }
            .navigationTitle("Reply and Resolve")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Resolve") { Task { await model.resolveThread(finding, reply: reply); dismiss() } }.keyboardShortcut(.return, modifiers: .command)
                        .buttonStyle(.glassProminent)
                }
            }
        }
    }
}
