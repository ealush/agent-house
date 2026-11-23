import AVFoundation
import AVKit
import SwiftUI
import UIKit

extension View {
    /// The system player over everything, playing `stream` (a host's `GET /api/fs/media`, with
    /// this device's bearer) as it arrives: AVPlayer asks for byte ranges, so a seek fetches only
    /// what it needs. Set to open it; it's cleared once the player is up, and the player stays
    /// until its own close or a pull down.
    func mediaPlayer(_ stream: Binding<URLRequest?>) -> some View {
        background(MediaPlayerPresenter(stream: stream))
    }
}

/// Where the player is presented from: an empty controller in the view's background, which
/// presents over whatever is on top of its window (as Quick Look is, `QuickLook.swift`).
private struct MediaPlayerPresenter: UIViewControllerRepresentable {
    @Binding var stream: URLRequest?

    func makeUIViewController(context: Context) -> UIViewController {
        let anchor = UIViewController()
        anchor.view.isUserInteractionEnabled = false
        return anchor
    }

    func updateUIViewController(_ anchor: UIViewController, context: Context) {
        guard let stream, let url = stream.url, var top = anchor.view.window?.rootViewController else { return }
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        // The bearer goes with every range AVPlayer asks for; it sends no cookie and the host
        // takes none from the app.
        let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": stream.allHTTPHeaderFields ?? [:]])
        let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        let shown = AVPlayerViewController()
        shown.player = player
        shown.modalPresentationStyle = .fullScreen
        // Heard with the ringer switch off, as a video you chose to play is.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        top.present(shown, animated: true) { player.play() }
        let binding = $stream
        DispatchQueue.main.async { binding.wrappedValue = nil }
    }
}
