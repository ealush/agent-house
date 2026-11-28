import SwiftUI

/// The hub's host announces less than this app gates on (`AppProtocol.requires`): said under
/// the connection's banner until it's updated, so a part that's off reads as the host's age,
/// not as missing. **Fix** updates the host from GitHub where it can update itself
/// (`serverUpdate`); a host from before that gets the steps to run on it instead.
struct HostBehindBanner: View {
    let hub: HubStore
    @State private var confirming = false
    @State private var explaining = false

    var body: some View {
        let missing = hub.hostBehind
        let updater = hub.hostUpdate
        // Only while the host is live: an offline host's last state may be older than it is.
        if !missing.isEmpty, hub.phase == .live {
            banner(missing: missing, updater: updater)
                .alert("Update your host?", isPresented: $confirming) {
                    Button("Cancel", role: .cancel) {}
                    Button("Update and Restart") { Task { await updater.update() } }
                } message: {
                    Text("Your host moves to GitHub’s newest main that has everything this app uses, installs and builds it, then Agent House restarts. That can take a few minutes; sessions keep running. If the build fails, it goes back to what it runs now.")
                }
                .alert("Update your host", isPresented: $explaining) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text("This host can’t update itself from the app yet. On the host, in Agent House’s checkout, run:\n\ngit pull --ff-only\npnpm build\nsystemctl --user restart ah\n\nAfter that, it updates from here when it falls behind again.")
                }
        }
    }

    @ViewBuilder
    private func banner(missing: [String], updater: HostUpdater) -> some View {
        let canFix = hub.state(host: nil)?.supports("serverUpdate") ?? false
        switch updater.phase {
        case .updating:
            Banner(text: "Updating your host from GitHub… it restarts when the build finishes.", symbol: "arrow.triangle.2.circlepath")
        case .restarting:
            Banner(text: "Updated. Your host is restarting; this reconnects in a moment.", symbol: "arrow.triangle.2.circlepath")
        case .idle, .checking:
            if updater.buildLog != nil {
                Banner(text: "Your host’s update didn’t build, so it kept running what it had. Settings → System has the build’s output.", tone: .error, action: ("Try Again", { confirming = true }))
            } else if let error = updater.error {
                Banner(text: error, tone: .error, action: ("Try Again", { confirming = true }))
            } else {
                Banner(
                    text: "Your host is behind this app. It doesn’t have \(missing.joined(separator: ", ")) yet, so those parts stay off until it’s updated.",
                    tone: .warning,
                    action: canFix ? ("Fix", { confirming = true }) : ("How", { explaining = true }),
                    symbol: "arrow.up.circle"
                )
            }
        }
    }
}
