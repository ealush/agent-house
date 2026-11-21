#if DEBUG
import OSLog
import UIKit

/// The conversation's geometry, for finding which layer misplaced something
/// (docs/native/CONVERSATION-LAYOUT.md, "Diagnostics"). Debug builds only, and only when launched
/// with `-AHLayoutProbe` (or `-AHLayoutHUD`, which also draws it over the screen). It only reads:
/// the controller hands it numbers after each layout and scroll, and it writes them where nothing
/// that lays out reads them:
/// - the log (subsystem dev.ealush.ah.native, category "layout"), one line per change;
/// - a hidden accessibility element, "layout-probe", whose value is the line as JSON, which the
///   layout tests read;
/// - with `-AHLayoutHUD`, a small label in the corner.
/// No transcript text, only sizes, states and the session's key.
@MainActor
final class LayoutProbe {
    struct Snapshot: Equatable, Encodable {
        var session: String
        var bounds: CGRect
        var safeTop: CGFloat
        var safeBottom: CGFloat
        /// The keyboard layout guide, in the conversation's coordinates (its top is the dock's floor).
        var keyboard: CGRect
        /// The guide's top and the dock's frame in the window's coordinates, as the tests see them.
        var keyboardTopInWindow: CGFloat
        var dockInWindow: CGRect
        var dock: CGRect
        var dockMeasured: CGFloat
        var float: CGRect
        var floats: Bool
        var available: CGFloat
        var transcript: TranscriptController.Diagnostics?
        var queued: Int
    }

    static let enabled = ProcessInfo.processInfo.arguments.contains("-AHLayoutProbe") || ProcessInfo.processInfo.arguments.contains("-AHLayoutHUD")
    private static let log = Logger(subsystem: "dev.ealush.ah.native", category: "layout")
    private let element = UIView()
    private let hud: UILabel?
    private var last: Snapshot?

    init(in view: UIView) {
        element.isUserInteractionEnabled = false
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "layout-probe"
        element.accessibilityLabel = "Layout probe"
        element.alpha = 0.011
        element.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
        view.addSubview(element)
        if ProcessInfo.processInfo.arguments.contains("-AHLayoutHUD") {
            let label = UILabel()
            label.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            label.numberOfLines = 0
            label.textColor = .white
            label.backgroundColor = UIColor.black.withAlphaComponent(0.6)
            label.isUserInteractionEnabled = false
            view.addSubview(label)
            hud = label
        } else {
            hud = nil
        }
    }

    func record(_ snapshot: Snapshot, in view: UIView) {
        guard snapshot != last else { return }
        last = snapshot
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = (try? encoder.encode(snapshot)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        element.accessibilityValue = json
        Self.log.debug("\(json, privacy: .public)")
        if let hud {
            let t = snapshot.transcript
            hud.text = [
                "kb \(Int(snapshot.keyboard.minY)) dock \(Int(snapshot.dock.minY))–\(Int(snapshot.dock.maxY)) (\(Int(snapshot.dockMeasured)))",
                "room \(Int(snapshot.available)) safe \(Int(snapshot.safeTop))/\(Int(snapshot.safeBottom)) q \(snapshot.queued)",
                t.map { "off \(Int($0.offset)) of \(Int($0.contentHeight)) in \($0.insetTop)/\($0.insetBottom) \($0.anchor)" } ?? "no transcript",
            ].joined(separator: "\n")
            hud.frame = CGRect(x: 8, y: view.safeAreaInsets.top + 4, width: min(view.bounds.width - 16, 300), height: 40)
            view.bringSubviewToFront(hud)
        }
    }
}
#endif
