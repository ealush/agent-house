import Charts
import SwiftUI

/// Generative UI: every `ah-widget` type drawn natively, with unknown ones shown as their data.
struct WidgetView: View {
    let model: WidgetModel
    /// In a turn the conversation has moved past: choices and actions are kept to read,
    /// not to press (a late tap would answer a question nobody's asking).
    var answered = false
    /// Sends a reply to the agent (choices, card actions).
    let reply: (String) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    @Environment(\.hostFiles) private var hostFiles
    @State private var picked: Int?
    @State private var asTable = false

    var body: some View {
        content
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(border, lineWidth: 1))
    }

    private var border: Color {
        if case .card(_, _, let tone, _) = model {
            switch tone {
            case .success: return theme.done.opacity(0.5)
            case .warning: return theme.limited.opacity(0.5)
            case .danger: return theme.danger.opacity(0.5)
            case .info: return .clear
            }
        }
        return .clear
    }

    @ViewBuilder
    private var content: some View {
        switch model {
        case .card(let title, let body, _, let actions):
            VStack(alignment: .leading, spacing: 10) {
                if !title.isEmpty { Text(title).font(.ah(.headline)) }
                if !body.isEmpty { MarkdownView(body, compact: true) }
                if !actions.isEmpty {
                    HStack {
                        ForEach(Array(actions.enumerated()), id: \.offset) { i, action in
                            ReplyButton(label: action.label, prominent: i == 0, disabled: answered || picked != nil) {
                                picked = i
                                reply(action.reply)
                            }
                        }
                    }
                }
            }
        case .choices(let prompt, let options):
            VStack(alignment: .leading, spacing: 8) {
                if !prompt.isEmpty { Text(prompt).font(.ah(.headline)) }
                ForEach(Array(options.enumerated()), id: \.offset) { i, option in
                    Button {
                        guard picked == nil else { return }
                        picked = i
                        Haptics.selection()
                        reply(option.reply)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            if i < 9 { Text("\(i + 1)").font(.ahMono(.caption).weight(.bold)).foregroundStyle(theme.muted) }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label).foregroundStyle(theme.text)
                                if let d = option.description { Text(d).font(.ah(.caption)).foregroundStyle(theme.muted) }
                            }
                            Spacer()
                            if picked == i { Image(systemName: "checkmark").foregroundStyle(theme.done) }
                        }
                        .padding(10)
                        .background(picked == i ? theme.accent.opacity(0.15) : theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .disabled(answered || (picked != nil && picked != i))
                }
            }
            .opacity(answered && picked == nil ? 0.55 : 1)
        case .table(let title, let columns, let rows):
            tableView(title: title, columns: columns, rows: rows)
        case .checklist(let title, let items):
            ChecklistView(title: title, items: items)
        case .stats(let title, let items):
            VStack(alignment: .leading, spacing: 8) {
                if !title.isEmpty { Text(title).font(.ah(.headline)) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], spacing: 10) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, stat in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(stat.label).font(.ah(.caption)).foregroundStyle(theme.muted)
                            Text(stat.value).font(.ah(.title3).weight(.semibold)).monospacedDigit()
                            if let delta = stat.delta { Text(delta).font(.ah(.caption)).foregroundStyle(tone(stat.tone)) }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        case .barChart(let title, let unit, let data):
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    if !title.isEmpty { Text(title).font(.ah(.headline)) }
                    Spacer()
                    Button(asTable ? "Chart" : "Table") { asTable.toggle() }.font(.ah(.caption)).buttonStyle(.bordered)
                }
                if asTable {
                    tableView(title: "", columns: ["", unit.isEmpty ? "Value" : unit], rows: data.map { [$0.label, $0.value.plainString] })
                } else {
                    Chart(Array(data.enumerated()), id: \.offset) { _, bar in
                        BarMark(x: .value(unit.isEmpty ? "Value" : unit, bar.value), y: .value("Label", bar.label))
                            .foregroundStyle(theme.chart) // ah draws data in blue; pink is only for what needs you
                            .annotation(position: .trailing) {
                                Text(bar.value.plainString + (unit.isEmpty ? "" : " \(unit)")).font(.ah(.caption2)).foregroundStyle(theme.muted)
                            }
                    }
                    .frame(height: CGFloat(max(1, data.count)) * 28 + 20)
                    .accessibilityLabel("\(title.isEmpty ? "Bar chart" : title): " + data.map { "\($0.label) \($0.value.plainString) \(unit)" }.joined(separator: ", "))
                }
            }
        case .progress(let label, let value, let max):
            VStack(alignment: .leading, spacing: 6) {
                if !label.isEmpty { Text(label).font(.ah(.headline)) }
                ProgressView(value: value, total: max).tint(theme.accent)
                Text("\(value.plainString) / \(max.plainString)").font(.ah(.caption)).foregroundStyle(theme.muted).monospacedDigit()
            }
        case .links(let title, let items):
            VStack(alignment: .leading, spacing: 8) {
                if !title.isEmpty { Text(title).font(.ah(.headline)) }
                ForEach(Array(items.enumerated()), id: \.offset) { _, link in
                    Button {
                        switch link.target {
                        case .web(let url): openURL(url)
                        case .hostFile(let path): Task { await hostFiles?.open?(path) }
                        case .unsupported: break
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(link.label, systemImage: linkSymbol(link.target)).foregroundStyle(theme.accent)
                            if let d = link.description { Text(d).font(.ah(.caption)).foregroundStyle(theme.muted) }
                        }
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .disabled({ if case .unsupported = link.target { return true } else { return false } }())
                }
            }
        case .image(let title, let source, let alt, let caption):
            VStack(alignment: .leading, spacing: 6) {
                if !title.isEmpty { Text(title).font(.ah(.headline)) }
                switch source {
                case .inline(let data):
                    if let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(alt) }
                case .hostFile(let path):
                    HostImage(source: path, alt: alt)
                case .remote(let url):
                    HostImage(source: url.absoluteString, alt: alt)
                case .unavailable(let raw):
                    Label("Image not available: \(raw)", systemImage: "photo").font(.ah(.caption)).foregroundStyle(theme.muted)
                }
                if !caption.isEmpty { Text(caption).font(.ah(.caption)).foregroundStyle(theme.muted) }
            }
        case .code(let title, let code):
            VStack(alignment: .leading, spacing: 6) {
                if !title.isEmpty { Text(title).font(.ah(.headline)) }
                CodeBlockView(code: code)
            }
        case .diff(let title, let lines):
            VStack(alignment: .leading, spacing: 6) {
                if !title.isEmpty { Text(title).font(.ah(.headline)) }
                DiffLinesView(lines: lines, maxLines: 200)
            }
        case .unknown(let type, let title, let json):
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.ah(.headline))
                Text("“\(type)” isn’t a widget this app knows; here are its fields.").font(.ah(.caption)).foregroundStyle(theme.muted)
                CodeBlockView(code: json, language: "json")
            }
        }
    }

    private func tableView(title: String, columns: [String], rows: [[String]]) -> some View {
        let width = max(columns.count, rows.map(\.count).max() ?? 0)
        let numeric = (0..<width).map { Self.isNumeric(column: $0, rows: rows) }
        return VStack(alignment: .leading, spacing: 8) {
            if !title.isEmpty { Text(title).font(.ah(.headline)) }
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 0) {
                    if !columns.isEmpty {
                        GridRow {
                            ForEach(0..<width, id: \.self) { c in
                                Text(c < columns.count ? columns[c] : "")
                                    .font(.ah(.caption).weight(.semibold))
                                    .foregroundStyle(theme.muted)
                                    .gridColumnAlignment(numeric[c] ? .trailing : .leading)
                            }
                        }
                        .padding(.bottom, 6)
                    }
                    ForEach(rows.indices, id: \.self) { r in
                        Divider().gridCellUnsizedAxes(.horizontal).overlay(theme.faint.opacity(0.2))
                        GridRow {
                            ForEach(0..<width, id: \.self) { c in
                                let cell = c < rows[r].count ? rows[r][c] : ""
                                Text(cell)
                                    .font(numeric[c] ? .ah(.callout).monospacedDigit() : .ah(.callout))
                                    .fontWeight(c == 0 ? .medium : .regular)
                                    .foregroundStyle(theme.text)
                            }
                        }
                        .padding(.vertical, 7)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    /// A column of numbers (units and signs allowed: "412 ms", "+24", "12%", "$3.20") lines
    /// up on the right.
    static func isNumeric(column: Int, rows: [[String]]) -> Bool {
        let cells = rows.compactMap { column < $0.count ? $0[column].trimmingCharacters(in: .whitespaces) : nil }.filter { !$0.isEmpty }
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let core = cell.trimmingCharacters(in: CharacterSet(charactersIn: "+-−$€£%×x ").union(.letters))
            return !core.isEmpty && Double(core.replacingOccurrences(of: ",", with: "")) != nil
        }
    }

    private func tone(_ tone: WidgetModel.Tone) -> Color {
        switch tone {
        case .success: return theme.done
        case .warning: return theme.limited
        case .danger: return theme.danger
        case .info: return theme.muted
        }
    }

    private func linkSymbol(_ target: WidgetModel.LinkTarget) -> String {
        switch target {
        case .web: return "safari"
        case .hostFile: return "doc"
        case .unsupported: return "nosign"
        }
    }
}

/// An answer to the agent: the first one prominent.
private struct ReplyButton: View {
    let label: String
    let prominent: Bool
    let disabled: Bool
    let action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        if prominent {
            Button(label, action: action).buttonStyle(.borderedProminent).tint(theme.accentStrong).disabled(disabled)
        } else {
            Button(label, action: action).buttonStyle(.bordered).disabled(disabled)
        }
    }
}
