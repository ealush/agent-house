import UIKit

/// The Home Screen icon's menu: New Session and Search are fixed (Info.plist); Inbox follows
/// how many sessions need you, and goes away while no host is signed in.
@MainActor
enum QuickActions {
    private static var shown: (Int, Bool)?

    static func update(needsYou: Int, signedIn: Bool) {
        guard shown.map({ $0 != (needsYou, signedIn) }) ?? true else { return }
        shown = (needsYou, signedIn)
        UIApplication.shared.shortcutItems = signedIn ? [
            UIApplicationShortcutItem(type: QuickAction.inbox.rawValue, localizedTitle: QuickAction.inboxTitle(needsYou: needsYou), localizedSubtitle: nil,
                                      icon: UIApplicationShortcutIcon(systemImageName: needsYou > 0 ? "exclamationmark.bubble" : "tray")),
        ] : []
    }
}
