import QuickLook
import SwiftUI
import UIKit

extension View {
    /// Quick Look over everything at `url`, swiping through `items` (or `url` alone), put away by
    /// its Done or by pulling it down, back into the tile it came from. UIKit presents it, with a
    /// view to grow out of and go back into: without one (SwiftUI's `quickLookPreview`), Quick
    /// Look can't be pulled down, only closed with Done.
    func quickLook(_ url: Binding<URL?>, in items: [URL] = []) -> some View {
        background(QuickLookPresenter(url: url, items: items))
    }

    /// What opens Quick Look from here: it grows out of this and goes back into it. `mark` is
    /// handed to `QuickLookOrigin.set` just before opening.
    func quickLookOrigin(_ mark: QuickLookOrigin.Mark) -> some View {
        background(QuickLookOrigin.Marker(mark: mark))
    }
}

/// What was tapped to open Quick Look (a picture's tile), for it to grow out of and go back into.
/// A tile sets it as it opens and the presenter takes it; one opened from elsewhere (a link in
/// the words) grows out of the conversation instead.
@MainActor
enum QuickLookOrigin {
    private static weak var view: UIView?

    static func set(_ mark: Mark?) { view = mark?.view }

    static func take() -> UIView? {
        defer { view = nil }
        return view
    }

    /// Where a tile is in UIKit: an empty view behind it.
    final class Mark {
        fileprivate weak var view: UIView?
    }

    fileprivate struct Marker: UIViewRepresentable {
        let mark: Mark

        func makeUIView(context: Context) -> UIView {
            let view = UIView()
            view.isUserInteractionEnabled = false
            mark.view = view
            return view
        }

        func updateUIView(_ view: UIView, context: Context) { mark.view = view }
    }
}

/// Where Quick Look is presented from: an empty controller in the view's background, which
/// presents over whatever is on top of the window when `url` is set and clears it once it's gone.
private struct QuickLookPresenter: UIViewControllerRepresentable {
    @Binding var url: URL?
    var items: [URL]

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIViewController {
        let anchor = UIViewController()
        anchor.view.isUserInteractionEnabled = false
        return anchor
    }

    func updateUIViewController(_ anchor: UIViewController, context: Context) {
        let coordinator = context.coordinator
        let binding = $url
        coordinator.gone = { binding.wrappedValue = nil }
        guard let url else {
            // Put away from here (the session went): Quick Look goes with it.
            if let shown = coordinator.shown, shown.presentingViewController != nil, !shown.isBeingDismissed {
                shown.dismiss(animated: true)
            }
            coordinator.shown = nil
            return
        }
        guard coordinator.shown == nil, var top = anchor.view.window?.rootViewController else { return }
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        coordinator.items = items.contains(url) ? items : [url]
        coordinator.tile = QuickLookOrigin.take()
        coordinator.page = anchor.view
        let preview = QLPreviewController()
        preview.dataSource = coordinator
        preview.delegate = coordinator
        preview.currentPreviewItemIndex = coordinator.items.firstIndex(of: url) ?? 0
        coordinator.shown = preview
        top.present(preview, animated: true)
    }

    @MainActor
    final class Coordinator: NSObject, QLPreviewControllerDataSource, @preconcurrency QLPreviewControllerDelegate {
        var items: [URL] = []
        weak var shown: QLPreviewController?
        var gone: () -> Void = {}
        /// The tile it opened from, and the conversation, for when that tile has gone (scrolled
        /// away and reused).
        weak var tile: UIView?
        weak var page: UIView?

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { items.count }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            items[index] as NSURL
        }

        /// Asked as it opens and as it's put away: with a view, Quick Look grows out of it, goes
        /// back into it, and can be pulled down.
        func previewController(_ controller: QLPreviewController, transitionViewFor item: any QLPreviewItem) -> UIView? {
            if let tile, tile.window != nil { return tile }
            return page
        }

        func previewControllerDidDismiss(_ controller: QLPreviewController) {
            guard controller === shown else { return }
            shown = nil
            gone()
        }
    }
}
