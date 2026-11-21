#if DEBUG
import UIKit

/// Debug builds only: ways to run the app unattended where UI tests can't drive it (a Mac
/// build signed to run locally can't load a test bundle).
///
/// - `AH_DEBUG_PAIR="<origin>|<setup code>"` pairs with that host at launch when there's
///   no host yet (a demo host from `scripts/demo/host.mjs`).
/// - `AH_SNAPSHOT_DIR=<folder>`: each `notifyutil -p dev.ealush.ah.native.snapshot` writes
///   every window, as the app draws it, to `<folder>/window-N.png` (no screen recording
///   permission involved).
@MainActor
enum DebugHooks {
    static func install(app: AppModel) {
        let environment = ProcessInfo.processInfo.environment
        trace("install: \(app.accounts.count) hosts, pair \(environment["AH_DEBUG_PAIR"] ?? "-")")
        if let pair = environment["AH_DEBUG_PAIR"], app.accounts.isEmpty {
            let parts = pair.split(whereSeparator: { $0 == "|" || $0 == " " }).map(String.init)
            if parts.count == 2 {
                Task {
                    trace("enrolling at \(parts[0])")
                    do {
                        _ = try await app.enroll(address: parts[0], code: parts[1], label: "Mac (debug)")
                        trace("paired")
                    } catch {
                        trace("pairing failed: \(APIError.wrap(error).message)")
                    }
                }
            }
        }
        if let folder = environment["AH_SNAPSHOT_DIR"] {
            snapshotFolder = URL(fileURLWithPath: folder)
            let center = CFNotificationCenterGetDarwinNotifyCenter()
            CFNotificationCenterAddObserver(center, nil, { _, _, _, _, _ in
                Task { @MainActor in DebugHooks.snapshot() }
            }, "dev.ealush.ah.native.snapshot" as CFString, nil, .deliverImmediately)
        }
    }

    private static var snapshotFolder: URL?

    /// Notes for whoever runs it unattended, beside the snapshots (`debug.log`).
    static func trace(_ line: String) {
        guard let folder = ProcessInfo.processInfo.environment["AH_SNAPSHOT_DIR"] else { return }
        let url = URL(fileURLWithPath: folder).appendingPathComponent("debug.log")
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let text = "\(Date()) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            try? handle.close()
        } else {
            try? Data(text.utf8).write(to: url)
        }
    }

    static func snapshot() {
        guard let folder = snapshotFolder else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let windows = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow ?? ($0 as? UIWindowScene)?.windows.first }
        for (index, window) in windows.enumerated() {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try? image.pngData()?.write(to: folder.appendingPathComponent("window-\(index + 1).png"))
        }
    }
}
#endif
