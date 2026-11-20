import ActivityKit
import SwiftUI
import WidgetKit

/// A session you sent to, while it works: on the Lock Screen its agent, title, where it is
/// (starting, working with its clock, needs you, finished, didn't finish, usage limit), what
/// it's doing or asks, and Approve / Deny for a plain permission prompt; in the Dynamic Island
/// the agent's mark ringed in its state's color and the clock, or that it needs you.
struct SessionLiveActivity: Widget {
    static let brand = Color(red: 0.914, green: 0.118, blue: 0.388)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionAttributes.self) { context in
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 12) {
                    AgentBadge(attributes: context.attributes, phase: Self.phase(context), size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(context.attributes.title).font(.headline).lineLimit(1)
                            Spacer(minLength: 4)
                            Status(state: context.state, phase: Self.phase(context)).font(.subheadline.weight(.semibold))
                        }
                        Text(Self.line(context)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        if let footer = Self.footer(context) {
                            Text(footer).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                        }
                    }
                }
                if Self.answerable(context) { Answer(attributes: context.attributes, prompt: context.state.prompt) }
            }
            .padding(16)
            .activityBackgroundTint(nil)
            .activitySystemActionForegroundColor(Self.brand)
            .widgetURL(context.attributes.link)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgentBadge(attributes: context.attributes, phase: Self.phase(context), size: 40).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Status(state: context.state, phase: Self.phase(context)).font(.subheadline.weight(.semibold)).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.attributes.title).font(.headline).lineLimit(1)
                        Text(Self.who(context.attributes)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 10) {
                        if let detail = Self.detail(context) {
                            Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if Self.answerable(context) { Answer(attributes: context.attributes, prompt: context.state.prompt) }
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                AgentBadge(attributes: context.attributes, phase: Self.phase(context), size: 22)
            } compactTrailing: {
                Status(state: context.state, phase: Self.phase(context), compact: true).font(.caption.weight(.semibold))
            } minimal: {
                AgentBadge(attributes: context.attributes, phase: Self.phase(context), size: 22)
            }
            .keylineTint(Self.color(Self.phase(context)))
            .widgetURL(context.attributes.link)
        }
    }

    /// Its phase as drawn: one out of date is not known, rather than still counting.
    static func phase(_ context: ActivityViewContext<SessionAttributes>) -> SessionActivityState.Phase {
        context.state.shownPhase(stale: context.isStale)
    }

    static func color(_ phase: SessionActivityState.Phase) -> Color {
        switch phase {
        case .starting, .working: return brand
        case .waiting: return .orange
        case .finished: return .green
        case .limited: return .yellow
        case .failed: return .red
        case .unknown: return .secondary
        }
    }

    /// Its project and agent ("orbit-api · Claude Code"), or the agent alone on a private preview.
    static func who(_ attributes: SessionAttributes) -> String {
        attributes.project.isEmpty ? attributes.agent : "\(attributes.project) · \(attributes.agent)"
    }

    /// What it's doing, asks, or hit; a stale one (the app put away, no push) says so.
    static func detail(_ context: ActivityViewContext<SessionAttributes>) -> String? {
        if context.isStale && !context.state.isOver { return "Open Agent House to see where it is" }
        switch context.state.phase {
        case .starting: return context.state.detail ?? "Your message is on its way"
        case .failed: return "It ended before it finished"
        case .unknown: return "Open Agent House to see where it is"
        default: return context.state.detail
        }
    }

    /// Approve and Deny, for a plain permission prompt it's showing as it is now.
    static func answerable(_ context: ActivityViewContext<SessionAttributes>) -> Bool {
        context.state.phase == .waiting && context.state.answerable && !context.isStale
    }

    static func line(_ context: ActivityViewContext<SessionAttributes>) -> String {
        detail(context) ?? who(context.attributes)
    }

    /// Who it is, when the line above says what it's doing, and its queue: counted, never guessed.
    static func footer(_ context: ActivityViewContext<SessionAttributes>) -> String? {
        var parts: [String] = []
        if detail(context) != nil { parts.append(who(context.attributes)) }
        if let queued = context.state.queued, queued > 0, !context.state.isOver { parts.append(queued == 1 ? "1 more queued" : "\(queued) more queued") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Deny and Approve, as the notification has them: iOS asks for the device to be unlocked,
    /// and the host refuses them if the session asks something else by then.
    private struct Answer: View {
        let attributes: SessionAttributes
        let prompt: String?

        var body: some View {
            HStack(spacing: 10) {
                Button(intent: AnswerSessionIntent(host: attributes.host, uid: attributes.uid, approve: false, prompt: prompt)) {
                    Label("Deny", systemImage: "xmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                Button(intent: AnswerSessionIntent(host: attributes.host, uid: attributes.uid, approve: true, prompt: prompt)) {
                    Label("Approve", systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(SessionLiveActivity.brand)
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    /// How long it's been at it, or where it ended up.
    private struct Status: View {
        let state: SessionActivityState
        let phase: SessionActivityState.Phase
        var compact = false

        var body: some View {
            switch phase {
            case .working:
                // Counts up from when it started working.
                Text(timerInterval: Date(timeIntervalSince1970: state.since)...Date.distantFuture, countsDown: false)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: compact ? 44 : 64, alignment: .trailing)
                    .foregroundStyle(SessionLiveActivity.brand)
            case .starting:
                if compact { Image(systemName: "paperplane.fill").foregroundStyle(SessionLiveActivity.brand) } else { Text("Starting").foregroundStyle(SessionLiveActivity.brand) }
            case .waiting:
                Text(compact ? "You" : "Needs you").foregroundStyle(.orange)
            case .finished:
                if compact { Image(systemName: "checkmark").foregroundStyle(.green) } else { Text("Finished").foregroundStyle(.green) }
            case .limited:
                Text(compact ? "Limit" : "Usage limit").foregroundStyle(.yellow)
            case .failed:
                if compact { Image(systemName: "exclamationmark").foregroundStyle(.red) } else { Text("Stopped").foregroundStyle(.red) }
            case .unknown:
                if compact { Image(systemName: "questionmark").foregroundStyle(.secondary) } else { Text("Open to see").foregroundStyle(.secondary) }
            }
        }
    }
}

/// The agent's own mark (`AgentLogo`, the app's logos), ringed in its state's color, with the
/// state's symbol in a small disc at its corner. One that isn't known shows its initial.
private struct AgentBadge: View {
    let attributes: SessionAttributes
    let phase: SessionActivityState.Phase
    let size: CGFloat

    var body: some View {
        let color = SessionLiveActivity.color(phase)
        let shape = RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        ZStack(alignment: .bottomTrailing) {
            mark(shape)
                .frame(width: size, height: size)
                .overlay(shape.strokeBorder(color, lineWidth: max(1.5, size * 0.06)))
            if size >= 30 {
                Image(systemName: symbol)
                    .font(.system(size: size * 0.22, weight: .heavy))
                    .foregroundStyle(.white)
                    .frame(width: size * 0.42, height: size * 0.42)
                    .background(color, in: Circle())
                    .overlay(Circle().strokeBorder(.background, lineWidth: 1.5))
                    .offset(x: size * 0.12, y: size * 0.12)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(attributes.agent), \(label)")
    }

    @ViewBuilder private func mark(_ shape: RoundedRectangle) -> some View {
        if let id = attributes.agentId, let key = AgentLogo.key(id) {
            if AgentLogo.tiles.contains(key) {
                Image("Agents/\(key)").resizable().scaledToFill().clipShape(shape)
            } else {
                Image("Agents/\(key)").resizable().scaledToFit()
                    .foregroundStyle(.primary)
                    .padding(size * 0.2)
                    .background(.fill.tertiary, in: shape)
            }
        } else {
            Text(AgentLogo.initial(attributes.agentId ?? attributes.agent))
                .font(.system(size: size * 0.5, weight: .bold, design: .rounded))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.fill.tertiary, in: shape)
        }
    }

    private var symbol: String {
        switch phase {
        case .starting: return "paperplane.fill"
        case .working: return "sparkles"
        case .waiting: return "hand.raised.fill"
        case .finished: return "checkmark"
        case .limited: return "hourglass"
        case .failed: return "exclamationmark"
        case .unknown: return "questionmark"
        }
    }

    private var label: String {
        switch phase {
        case .starting: return "starting"
        case .working: return "working"
        case .waiting: return "needs you"
        case .finished: return "finished"
        case .limited: return "hit its usage limit"
        case .failed: return "stopped before it finished"
        case .unknown: return "open Agent House to see where it is"
        }
    }
}
