import SwiftUI
import UIKit

/// Where the on-screen keyboard is, as UIKit moves it. SwiftUI's own keyboard safe area
/// settles only once the keyboard has: a view placed by it sat still while the composer (in
/// the transcript's inset, which UIKit animates with the keyboard) went down, then jumped
/// after it. `rise` is how far the keyboard pushes the bar up from where it rests, animated
/// as the keyboard is, for a view that ignores the keyboard safe area and pads by it instead.
@Observable @MainActor
final class KeyboardFrame {
    private(set) var rise: CGFloat = 0
    @ObservationIgnored nonisolated(unsafe) private var observer: (any NSObjectProtocol)?

    init() {
        observer = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
            // Only the frame and the timing cross over: the notification itself isn't Sendable.
            guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
            let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            MainActor.assumeIsolated { self?.take(end: end, duration: duration) }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    private func take(end: CGRect, duration: Double) {
        guard let window = UIApplication.shared.connectedScenes.lazy.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        // The keyboard's frame is the screen's; the bar lives in a window, which on an iPad
        // may be a part of the screen, and rests above the home indicator.
        let inWindow = window.convert(end, from: window.screen.coordinateSpace)
        let overlap = max(0, window.bounds.maxY - inWindow.minY)
        let rise = max(0, overlap - window.safeAreaInsets.bottom)
        // The keyboard's own curve isn't one SwiftUI names; this spring is the usual match.
        withAnimation(duration > 0 ? .interpolatingSpring(mass: 3, stiffness: 1000, damping: 500, initialVelocity: 0) : nil) {
            self.rise = rise
        }
    }
}
