import Charts
import SwiftUI

/// Generative UI: every `ah-widget` type drawn natively, with unknown ones shown as their data.
struct WidgetView: View {
    let model: WidgetModel
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
                if !title.isEmpty { Text(title).font(.headline) }
                if !body.isEmpty { MarkdownView(body, compact: true) }
                if !actions.isEmpty {
                    HStack {
                        ForEach(Array(actions.enumerated()), id: \.offset) { i, action in
                            ReplyButton(label: action.label, prominent: i == 0, disabled: picked != nil) {
                                picked = i
                                reply(action.reply)
                            }
                        }
                    }
                }
            }
        case .choices(let prompt, let options):
            VStack(alignment: .leading, spacing: 8) {
                if !prompt.isEmpty { Text(prompt).font(.headline) }
                ForEach(Array(options.enumerated()), id: \.offset) { i, option in
                    Button {
                        guard picked == nil else { return }
                        picked = i
                        Haptics.selection()
                        reply(option.reply)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            if i < 9 { Text("\(i + 1)").font(.caption.monospaced().weight(.bold)).foregroundStyle(theme.muted) }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label).foregroundStyle(theme.text)
                                if let d = option.description { Text(d).font(.caption).foregroundStyle(theme.muted) }
                            }
                            Spacer()
                            if picked == i { Image(systemName: "checkmark").foregroundStyle(theme.done) }
                        }
                        .padding(10)
                        .background(picked == i ? theme.accent.opacity(0.15) : theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(picked != nil && picked != i)
                }
            }
        case .table(let title, let columns, let rows):
            tableView(title: title, columns: columns, rows: rows)
        case .checklist(let title, let items):
            ChecklistView(title: title, items: items)
        case .stats(let title, let items):
            VStack(alignment: .leading, spacing: 8) {
                if !title.isEmpty { Text(title).font(.headline) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], spacing: 10) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, stat in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(stat.label).font(.caption).foregroundStyle(theme.muted)
                            Text(stat.value).font(.title3.weight(.semibold)).monospacedDigit()
                            if let delta = stat.delta { Text(delta).font(.caption).foregroundStyle(tone(stat.tone)) }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        case .barChart(let title, let unit, let data):
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    if !title.isEmpty { Text(title).font(.headline) }
                    Spacer()
                    Button(asTable ? "Chart" : "Table") { asTable.toggle() }.font(.caption).buttonStyle(.bordered)
                }
                if asTable {
                    tableView(title: "", columns: ["", unit.isEmpty ? "Value" : unit], rows: data.map { [$0.label, $0.value.plainString] })
                } else {
                    Chart(Array(data.enumerated()), id: \.offset) { _, bar in
                        BarMark(x: .value(unit.isEmpty ? "Value" : unit, bar.value), y: .value("Label", bar.label))
                            .foregroundStyle(theme.accent)
                            .annotation(position: .trailing) {
                                Text(bar.value.plainString + (unit.isEmpty ? "" : " \(unit)")).font(.caption2).foregroundStyle(theme.muted)
                            }
                    }
                    .frame(height: CGFloat(max(1, data.count)) * 28 + 20)
                    .accessibilityLabel("\(title.isEmpty ? "Bar chart" : title): " + data.map { "\($0.label) \($0.value.plainString) \(unit)" }.joined(separator: ", "))
                }
            }
        case .progress(let label, let value, let max):
            VStack(alignment: .leading, spacing: 6) {
                if !label.isEmpty { Text(label).font(.headline) }
                ProgressView(value: value, total: max).tint(theme.accent)
                Text("\(value.plainString) / \(max.plainString)").font(.caption).foregroundStyle(theme.muted).monospacedDigit()
            }
        case .links(let title, let items):
            VStack(alignment: .leading, spacing: 8) {
                if !title.isEmpty { Text(title).font(.headline) }
                ForEach(Array(items.enumerated()), id: \.offset) { _, link in
                    Button {
                        switch link.target {
                        case .web(let url): openURL(url)
                        case .hostFile(let path): hostFiles?.open(path)
                        case .unsupported: break
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(link.label, systemImage: linkSymbol(link.target)).foregroundStyle(theme.accent)
                            if let d = link.description { Text(d).font(.caption).foregroundStyle(theme.muted) }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled({ if case .unsupported = link.target { return true } else { return false } }())
                }
            }
        case .image(let title, let source, let alt, let caption):
            VStack(alignment: .leading, spacing: 6) {
                if !title.isEmpty { Text(title).font(.headline) }
                switch source {
                case .inline(let data):
                    if let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(alt) }
                case .hostFile(let path):
                    HostImage(source: path, alt: alt)
                case .unavailable(let raw):
                    Label("Image not available: \(raw)", systemImage: "photo").font(.caption).foregroundStyle(theme.muted)
                }
                if !caption.isEmpty { Text(caption).font(.caption).foregroundStyle(theme.muted) }
            }
        case .code(let title, let code):
            VStack(alignment: .leading, spacing: 6) {
                if !title.isEmpty { Text(title).font(.headline) }
                CodeBlockView(code: code)
            }
        case .diff(let title, let lines):
            VStack(alignment: .leading, spacing: 6) {
                if !title.isEmpty { Text(title).font(.headline) }
                DiffLinesView(lines: lines, maxLines: 200)
            }
        case .unknown(let type, let title, let json):
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                Text("“\(type)” isn’t a widget this app knows; here are its fields.").font(.caption).foregroundStyle(theme.muted)
                CodeBlockView(code: json, language: "json")
            }
        }
    }

    private func tableView(title: String, columns: [String], rows: [[String]]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !title.isEmpty { Text(title).font(.headline) }
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    if !columns.isEmpty {
                        GridRow { ForEach(columns.indices, id: \.self) { Text(columns[$0]).font(.caption.weight(.semibold)).foregroundStyle(theme.muted) } }
                        Divider()
                    }
                    ForEach(rows.indices, id: \.self) { r in
                        GridRow { ForEach(rows[r].indices, id: \.self) { Text(rows[r][$0]).font(.callout) } }
                    }
                }
            }
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

    var body: some View {
        if prominent {
            Button(label, action: action).buttonStyle(.borderedProminent).disabled(disabled)
        } else {
            Button(label, action: action).buttonStyle(.bordered).disabled(disabled)
        }
    }
}
