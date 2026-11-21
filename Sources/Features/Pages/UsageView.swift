import Charts
import SwiftUI

/// Usage (`../ah/web/UsageView.tsx`): what the agents on this host used, read from their own
/// transcripts. Totals for 7, 30 or 90 days, tokens per day, by model and provider, limits the
/// providers reported, and the busiest conversations. Costs are estimates at list price.
struct UsageView: View {
    @State var model: UsageModel
    let scene: SceneModel
    let hub: HubStore
    @State private var asTable = false
    @State private var picked: Date?
    @State private var sharing: URL?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        NavigationStack {
            List {
                Group {
                    if let error = model.error {
                        Banner(text: error, tone: .error, action: model.loaded ? ("OK", { model.clearError() }) : ("Retry", { Task { await model.load() } }))
                            .formBanner()
                    }
                    Section {
                        Picker("Period", selection: $model.period) {
                            ForEach(UsageModel.Period.allCases) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                        tiles
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 0, trailing: 0))
                    }
                    if !model.loaded && model.error == nil {
                        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear).afterABeat(.milliseconds(300))
                    } else if model.loaded {
                        perDay
                        limits
                        byModel
                        byProvider
                        busiest
                        notes
                    }
                }
                .ahRow()
            }
            .ahFormGround()
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItemGroup(placement: .primaryAction) {
                    Menu {
                        ForEach(UsageExportFormat.allCases, id: \.self) { format in
                            Button("Export \(format.rawValue.uppercased())", systemImage: format == .csv ? "tablecells" : "curlybraces") {
                                Task { sharing = await model.export(format, host: hub.hostname ?? "host") }
                            }
                        }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Export")
                    .disabled(model.exporting)
                    Button { Task { await model.refresh() } } label: {
                        if model.refreshing { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                    }
                    .accessibilityLabel("Read the Transcripts Again")
                    .disabled(model.refreshing)
                }
            }
            .task(id: model.period) { await model.load() }
            .refreshable { await model.refresh() }
            .sheet(item: Binding(get: { sharing.map(SharedFile.init) }, set: { sharing = $0?.url })) { shared in
                ActivitySheet(items: [shared.url])
            }
        }
    }

    // MARK: Totals

    private var tiles: some View {
        let t = model.totals
        let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: sizeClass == .compact ? 2 : 4)
        let priceHint = (t.subscription ? "Your plan bills differently. " : "") + "At list price" + (t.unpriced > 0 ? "; \(UsageModel.short(t.unpriced)) tokens have no price" : "")
        return LazyVGrid(columns: columns, spacing: 10) {
            UsageTile(label: "Tokens in", value: UsageModel.short(t.sent), hint: "Prompt and cache writes")
            UsageTile(label: "Tokens out", value: UsageModel.short(t.output), hint: "Replies, reasoning included")
            UsageTile(label: "Cache reads", value: UsageModel.short(t.cacheRead), hint: "Context read again from cache")
            UsageTile(label: "Estimated cost", value: UsageModel.usd(t.cost), hint: priceHint, estimate: true)
        }
    }

    // MARK: Per day

    @ViewBuilder
    private var perDay: some View {
        let series = model.series
        let most = series.map(\.total).max() ?? 0
        Section {
            if asTable {
                ForEach(series.reversed().filter { $0.row != nil }) { point in
                    HStack {
                        Text(point.day).font(.ahMono(.callout))
                        Spacer()
                        Text("in \(UsageModel.short(point.row?.tokens.sent ?? 0)) · out \(UsageModel.short(point.row?.tokens.output ?? 0)) · cache \(UsageModel.short(point.row?.tokens.cacheRead ?? 0))")
                            .font(.ah(.caption)).foregroundStyle(theme.muted)
                        Text(UsageModel.usd(point.row?.cost.estimateUsd)).font(.ah(.callout).monospacedDigit()).frame(minWidth: 64, alignment: .trailing)
                    }
                }
                if series.allSatisfy({ $0.row == nil }) { Text("Nothing recorded in this period.").foregroundStyle(theme.muted) }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Chart(series) { point in
                        BarMark(x: .value("Day", point.date, unit: .day), y: .value("Tokens", point.total))
                            .foregroundStyle(picked.map { Calendar.current.isDate($0, inSameDayAs: point.date) } == false ? theme.accent.opacity(0.35) : theme.accent)
                            .cornerRadius(3)
                    }
                    .chartXSelection(value: $picked)
                    .chartYAxis {
                        AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                            AxisGridLine().foregroundStyle(theme.line)
                            AxisValueLabel { if let n = value.as(Double.self) { Text(UsageModel.short(n)) } }
                        }
                    }
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                            AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                        }
                    }
                    .frame(height: 180)
                    .accessibilityLabel("Tokens per day, the last \(model.period.rawValue) days; the most in a day was \(UsageModel.short(most))")
                    Text(readout(series)).font(.ah(.caption)).foregroundStyle(theme.muted).contentTransition(.numericText())
                }
                .padding(.vertical, 6)
            }
        } header: {
            HStack {
                AhSectionHeader(title: "Tokens per day")
                Spacer()
                Button(asTable ? "Chart" : "Table") { withAnimation(.snappy) { asTable.toggle() } }
                    .font(.ah(.caption).weight(.semibold)).buttonStyle(.borderless).textCase(nil)
            }
        }
    }

    private func readout(_ series: [UsageModel.DayPoint]) -> String {
        guard let picked, let point = series.first(where: { Calendar.current.isDate($0.date, inSameDayAs: picked) }) else {
            return "Most in a day: \(UsageModel.short(series.map(\.total).max() ?? 0)). Touch a day for its numbers."
        }
        guard let row = point.row else { return "\(point.day): nothing recorded" }
        return "\(point.day): \(UsageModel.short(row.tokens.total)) tokens · in \(UsageModel.short(row.tokens.sent)) · out \(UsageModel.short(row.tokens.output)) · cache reads \(UsageModel.short(row.tokens.cacheRead))"
    }

    // MARK: Limits

    @ViewBuilder
    private var limits: some View {
        if let limits = model.limits, !(limits.windows.isEmpty && limits.cooldowns.isEmpty) {
            Section {
                ForEach(limits.windows) { w in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(UsageModel.windowWords(w, agent: agent(w.harness))).font(.ah(.callout))
                            Spacer()
                            Text(w.usedPercent.map { "\(Int($0.rounded()))% used" } ?? "Use unknown").font(.ah(.callout).monospacedDigit()).foregroundStyle(tint(w.usedPercent))
                        }
                        if let used = w.usedPercent { ProgressView(value: min(max(used, 0), 100), total: 100).tint(tint(used)) }
                        Text((w.resetsAt.map { "Resets \(JobsModel.when($0)) · " } ?? "") + "reported by the provider").font(.ah(.caption)).foregroundStyle(theme.faint)
                    }
                    .padding(.vertical, 2)
                }
                ForEach(limits.cooldowns) { c in
                    Button { open(c.uid) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(agent(c.harness)): \(c.text)").font(.ah(.callout)).foregroundStyle(theme.text)
                            Text("\(c.resetsAt.map { "Until \(JobsModel.when($0))" } ?? "Until unknown") · \(c.source == "screen" ? "on its screen" : "in its transcript")").font(.ah(.caption)).foregroundStyle(theme.faint)
                        }
                    }
                    .disabled(hub.row(c.uid) == nil)
                }
            } header: {
                AhSectionHeader(title: "Limits")
            }
        }
    }

    private func tint(_ used: Double?) -> Color {
        guard let used else { return theme.muted }
        return used >= 90 ? theme.danger : used >= 70 ? theme.limited : theme.done
    }

    // MARK: Breakdowns

    @ViewBuilder
    private var byModel: some View {
        if let rows = model.byModel?.rows, !rows.isEmpty {
            Section {
                ForEach(rows) { row in breakdownRow(title: row.key, detail: "\(row.sessions) conversation\(row.sessions == 1 ? "" : "s") · \(row.messages) messages", row: row) }
            } header: {
                AhSectionHeader(title: "By model", count: rows.count)
            }
        }
    }

    @ViewBuilder
    private var byProvider: some View {
        if let rows = model.byProvider?.rows, rows.count > 1 || rows.first?.cost.billing != nil {
            Section {
                ForEach(rows) { row in breakdownRow(title: providerName(row.key), detail: billingWords(row.cost.billing), row: row) }
            } header: {
                AhSectionHeader(title: "By provider", count: rows.count)
            }
        }
    }

    private func providerName(_ id: String) -> String {
        switch id {
        case "anthropic": return "Anthropic"
        case "openai": return "OpenAI"
        case "google": return "Google"
        case "xai": return "xAI"
        case "unknown": return "Unknown provider"
        default: return id.capitalized
        }
    }

    private func billingWords(_ billing: String?) -> String {
        switch billing {
        case "subscription": return "On a plan: not billed per token"
        case "api": return "Billed per token"
        default: return "Billing unknown"
        }
    }

    private func breakdownRow(title: String, detail: String, row: UsageRowDTO) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.ah(.callout).weight(.semibold)).lineLimit(1)
                Text(detail).font(.ah(.caption)).foregroundStyle(theme.muted)
                Text("in \(UsageModel.short(row.tokens.sent)) · out \(UsageModel.short(row.tokens.output)) · cache reads \(UsageModel.short(row.tokens.cacheRead))")
                    .font(.ah(.caption)).foregroundStyle(theme.faint)
            }
            Spacer(minLength: 8)
            Text(row.cost.estimateUsd == nil ? "No price" : UsageModel.usd(row.cost.estimateUsd))
                .font(.ah(.callout).monospacedDigit())
                .foregroundStyle(row.cost.estimateUsd == nil ? theme.faint : theme.text)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var busiest: some View {
        if let rows = model.bySession?.rows, !rows.isEmpty {
            Section {
                ForEach(rows.prefix(8)) { row in
                    let live = row.uid.flatMap { hub.row($0) }
                    Button { if let uid = row.uid { open(uid) } } label: {
                        HStack(spacing: 12) {
                            if let agent = row.harness { AgentMark(agent: agent) }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(title(row, live: live)).font(.ah(.callout)).foregroundStyle(theme.text).lineLimit(1)
                                Text("\(UsageModel.short(row.tokens.total)) tokens · \(row.messages) messages").font(.ah(.caption)).foregroundStyle(theme.muted)
                            }
                            Spacer(minLength: 8)
                            Text(UsageModel.usd(row.cost.estimateUsd)).font(.ah(.callout).monospacedDigit()).foregroundStyle(theme.text2)
                        }
                    }
                    .disabled(live == nil)
                }
            } header: {
                AhSectionHeader(title: "Busiest conversations")
            }
        }
    }

    private func title(_ row: UsageRowDTO, live: SessionRow?) -> String {
        if let live { return live.title }
        if let uid = row.uid, let past = hub.history.first(where: { $0.dto.ref == uid || $0.id == uid }) { return past.dto.title }
        return row.key
    }

    @ViewBuilder
    private var notes: some View {
        let unmetered = Set((hub.shownState?.windows ?? []).compactMap(\.agent).filter { $0 != "claude" && $0 != "codex" }).map(agent).sorted()
        if let notes = model.byModel?.notes {
            Section {
                EmptyView()
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(notes.tokens)
                    Text(notes.cost)
                    if !unmetered.isEmpty { Text("Running here without usage records: \(unmetered.joined(separator: ", ")).") }
                }
            }
        }
    }

    private func agent(_ id: String) -> String { hub.shownState?.presets.first { $0.id == id }?.name ?? id.capitalized }

    private func open(_ uid: String) {
        guard hub.row(uid) != nil else { return }
        scene.sheet = nil
        scene.open(uid)
    }
}

/// A number at a glance: what it counts, the number, and where it came from.
private struct UsageTile: View {
    let label: String
    let value: String
    let hint: String
    var estimate = false
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(label).font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.text2)
                if estimate { StatusTag(text: "estimate", color: theme.limited) }
            }
            Text(value).font(.ah(.title2).weight(.bold).monospacedDigit()).foregroundStyle(theme.text).contentTransition(.numericText())
            Text(hint).font(.ah(.caption2)).foregroundStyle(theme.muted).lineLimit(2, reservesSpace: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(sizeClassCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @Environment(\.horizontalSizeClass) private var sizeClass
    private var sizeClassCard: Color { sizeClass == .compact ? theme.card : theme.raised }
}

/// One conversation's usage, per model, from its session's menu.
struct SessionUsageSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @State private var model: SessionUsageModel?
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            List {
                Group {
                    if let model {
                        if let error = model.error { Banner(text: error, tone: .error).formBanner() }
                        if let usage = model.usage {
                            if !usage.metered {
                                EmptyState(symbol: "chart.bar", title: "Usage Unknown", message: "This agent doesn't record its usage where the host can read it. Claude Code and Codex do.")
                                    .listRowBackground(Color.clear)
                            } else if usage.models.isEmpty {
                                EmptyState(symbol: "chart.bar", title: "Nothing Recorded Yet", message: "Its usage shows up within a minute of its next reply.")
                                    .listRowBackground(Color.clear)
                            } else {
                                Section {
                                    LabeledContent("Tokens", value: UsageModel.short(model.total))
                                    LabeledContent("Estimated cost", value: UsageModel.usd(model.cost))
                                }
                                Section {
                                    ForEach(usage.models) { m in
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack {
                                                Text(m.model).font(.ah(.callout).weight(.semibold))
                                                Spacer()
                                                Text(m.cost.estimateUsd == nil ? "No price" : UsageModel.usd(m.cost.estimateUsd)).font(.ah(.callout).monospacedDigit())
                                            }
                                            Text("in \(UsageModel.short(m.input + m.cacheWrite)) · out \(UsageModel.short(m.output)) · cache reads \(UsageModel.short(m.cacheRead)) · \(m.messages) messages")
                                                .font(.ah(.caption)).foregroundStyle(theme.muted)
                                        }
                                        .padding(.vertical, 2)
                                    }
                                } header: {
                                    AhSectionHeader(title: "By model", count: usage.models.count)
                                } footer: {
                                    if let notes = usage.notes { Text("\(notes.tokens) \(notes.cost)") }
                                }
                            }
                        } else if model.error == nil {
                            ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear).afterABeat(.milliseconds(300))
                        }
                    }
                }
                .ahRow()
            }
            .ahFormGround()
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) } }
            .task {
                guard let uid = session.row?.uid else { return }
                let m = SessionUsageModel(api: session.api, uid: uid)
                model = m
                await m.load()
            }
        }
    }
}
