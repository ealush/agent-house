import SwiftUI

/// Sessions cut off together (`web/InterruptedCard.tsx`): what did it and when, ah bringing
/// them back or yours to restore, each one it gave up on and why, Restore and Dismiss.
struct InterruptedCard: View {
    let incident: InterruptedIncident
    let model: InterruptionsModel
    let open: (HistoryRow) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let busy = model.busy.contains(incident.id) || incident.sessions.contains { model.busy.contains($0.dto.ref) }
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "arrow.clockwise").foregroundStyle(theme.accent).accessibilityHidden(true)
                Text(incident.title).font(.ah(.headline)).foregroundStyle(theme.text)
            }
            Text("\(incident.line { $0.formatted(date: .omitted, time: .shortened) }) \(incident.next)")
                .font(.ah(.callout)).foregroundStyle(theme.text2)
            ForEach(Array(incident.failures.enumerated()), id: \.offset) { _, failure in
                Text(incident.sessions.count == 1 ? "It didn’t come back: \(failure.error)" : "\(failure.title) didn’t come back: \(failure.error)")
                    .font(.ah(.caption)).foregroundStyle(theme.danger)
            }
            if incident.sessions.count > 1 {
                ForEach(incident.sessions) { row in
                    HStack(spacing: 8) {
                        Button { open(row) } label: {
                            HStack(spacing: 6) {
                                AgentMark(agent: row.dto.harness, size: 16)
                                Text(row.dto.title).font(.ah(.callout)).foregroundStyle(theme.text).lineLimit(1)
                            }
                        }
                        .buttonStyle(.borderless)
                        Spacer(minLength: 4)
                        Text(row.dto.interrupted?.midTurn == true ? (row.dto.interrupted?.lastStatus == "waiting" ? "was asking" : "was working") : "had finished")
                            .font(.ah(.caption)).foregroundStyle(theme.muted)
                        Button(model.busy.contains(row.dto.ref) ? "Restoring…" : "Restore") { Task { await model.restore(row, of: incident.id) } }
                            .font(.ah(.caption).weight(.semibold)).buttonStyle(.borderless)
                            .accessibilityLabel("Restore \(row.dto.title)")
                    }
                }
            }
            if let error = model.errors[incident.id] {
                Text(error).font(.ah(.caption)).foregroundStyle(theme.danger)
            }
            HStack(spacing: 10) {
                Button(model.busy.contains(incident.id) ? "Restoring…" : incident.incident.count == 1 ? "Restore" : "Restore All") { Task { await model.restoreAll(incident.id) } }
                    .buttonStyle(.borderedProminent).tint(theme.accentStrong)
                    .lineLimit(1).fixedSize()
                Button("Dismiss") { Task { await model.dismiss(incident.id) } }
                    .buttonStyle(.bordered).tint(.primary)
                    .lineLimit(1).fixedSize()
            }
            .disabled(busy)
        }
        .padding(.vertical, 6)
        // As the Inbox's other cards: what needs you is the pink-edged thing on the page.
        .listRowBackground(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.accentTint).overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.accentLine, lineWidth: 1)))
        .accessibilityElement(children: .contain)
    }
}
