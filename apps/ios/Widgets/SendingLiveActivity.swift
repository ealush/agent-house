import ActivityKit
import SwiftUI
import WidgetKit

@main
struct AgentHubWidgets: WidgetBundle {
    var body: some Widget {
        SessionLiveActivity()
        SendingLiveActivity()
    }
}

/// A message going with its attachments: on the Lock Screen, a ring filling beside where it's
/// going and what's left; in the Dynamic Island, the ring and its share.
struct SendingLiveActivity: Widget {
    private static let brand = Color(red: 0.914, green: 0.118, blue: 0.388)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SendingAttributes.self) { context in
            HStack(spacing: 14) {
                Ring(state: context.state, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.title(context.state)).font(.headline)
                    Text(context.attributes.session).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                if context.state.phase == .uploading {
                    Text(Self.percent(context.state)).font(.title3.weight(.semibold)).monospacedDigit().contentTransition(.numericText())
                }
            }
            .padding(16)
            .activityBackgroundTint(nil)
            .activitySystemActionForegroundColor(Self.brand)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Ring(state: context.state, size: 36).padding(.leading, 4) }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.phase == .uploading {
                        Text(Self.percent(context.state)).font(.title3.weight(.semibold)).monospacedDigit().contentTransition(.numericText())
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(Self.title(context.state)).font(.headline)
                        Text(context.attributes.session).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            } compactLeading: {
                Ring(state: context.state, size: 18)
            } compactTrailing: {
                Text(context.state.phase == .uploading ? Self.percent(context.state) : Self.short(context.state))
                    .font(.caption.weight(.semibold)).monospacedDigit()
            } minimal: {
                Ring(state: context.state, size: 18)
            }
            .keylineTint(Self.brand)
        }
    }

    static func percent(_ state: SendingAttributes.ContentState) -> String { "\(Int((state.fraction * 100).rounded()))%" }

    static func title(_ state: SendingAttributes.ContentState) -> String {
        switch state.phase {
        case .uploading: return state.attachments == 1 ? "Uploading the attachment" : "Uploading \(state.attachments) attachments"
        case .sending: return "Sending"
        case .sent: return "Sent"
        case .failed: return "Didn’t send"
        }
    }

    static func short(_ state: SendingAttributes.ContentState) -> String {
        switch state.phase {
        case .uploading, .sending: return "Sending"
        case .sent: return "Sent"
        case .failed: return "Failed"
        }
    }

    /// The share gone up, as a ring; a check once it's sent.
    private struct Ring: View {
        let state: SendingAttributes.ContentState
        let size: CGFloat

        var body: some View {
            ZStack {
                Circle().stroke(SendingLiveActivity.brand.opacity(0.25), lineWidth: size / 9)
                switch state.phase {
                case .sent:
                    Image(systemName: "checkmark").font(.system(size: size * 0.45, weight: .bold)).foregroundStyle(SendingLiveActivity.brand)
                case .failed:
                    Image(systemName: "exclamationmark").font(.system(size: size * 0.45, weight: .bold)).foregroundStyle(.orange)
                default:
                    Circle()
                        .trim(from: 0, to: state.phase == .sending ? 1 : max(0.02, state.fraction))
                        .stroke(SendingLiveActivity.brand, style: StrokeStyle(lineWidth: size / 9, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
            }
            .frame(width: size, height: size)
        }
    }
}
