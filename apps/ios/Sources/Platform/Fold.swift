import SwiftUI
import UIKit

// iPhone Duo's fold, read from the system's reserved regions (iOS 27.1). The SDK that has them
// ships with Xcode 27.1 (Swift 6.4.1); an older Xcode builds the app without them, and an
// older system or a device with no fold has none: no fold, as on every other device.

extension GeometryProxy {
    /// The fold across this view while the device is folded, as fractions of the view: its
    /// division region once it's active. Flat, the region is inactive and nothing is moved.
    var fold: LayoutNode.Fold? {
        #if compiler(>=6.4.1)
        if #available(iOS 27.1, *) {
            guard size.width > 0, size.height > 0,
                  let frame = reservedRegions(kind: .division).first(where: \.isActive)?.frame else { return nil }
            return LayoutNode.Fold(frame, in: size)
        }
        #endif
        return nil
    }
}

extension LayoutNode.Fold {
    /// A fold's frame in a view of this size; nil when it doesn't cross the view.
    init?(_ frame: CGRect, in size: CGSize) {
        let vertical = frame.height >= frame.width
        let start = vertical ? frame.minX / size.width : frame.minY / size.height
        let end = vertical ? frame.maxX / size.width : frame.maxY / size.height
        guard start > 0, end < 1, end >= start else { return nil }
        self.init(vertical: vertical, start: Double(start), end: Double(end))
    }
}

extension UIView {
    /// The fold across this view while the device is folded, in its coordinates and with the
    /// margins kept clear of it; nil flat, with no fold, or on an older system.
    var foldFrame: CGRect? {
        #if compiler(>=6.4.1)
        if #available(iOS 27.1, *) {
            return reservedRegions(kind: .division).first(where: \.isActive)?.frame
        }
        #endif
        return nil
    }

    /// Lays this view out again as the hinge moves: the fold comes and goes with it.
    func laysOutWithHinge() {
        #if compiler(>=6.4.1)
        if #available(iOS 27.1, *) {
            addInteraction(UIHingeInteraction { [weak self] _, _ in self?.setNeedsLayout() })
        }
        #endif
    }
}
