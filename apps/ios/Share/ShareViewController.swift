import QuickLookThumbnailing
import SwiftUI
import UIKit

/// The share sheet's entry: stages what was shared, reads this device's sign-ins, and hosts
/// `ShareView`. It stays up until what was sent has reached the host (or the person gives up),
/// so nothing is left half-sent behind a closed sheet.
final class ShareViewController: UIViewController {
    private var folder: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        let folder = ShareStaging.folder()
        self.folder = folder
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let host = UIHostingController(rootView: ShareRoot(providers: providers, folder: folder, finish: { [weak self] sent in self?.finish(sent: sent) }))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }

    private func finish(sent: Bool) {
        if let folder { ShareStaging.discard(folder) }
        if sent {
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
    }
}

/// Stages first (the sharing app's items are only good for a moment), then the sheet.
private struct ShareRoot: View {
    let providers: [NSItemProvider]
    let folder: URL
    let finish: (Bool) -> Void
    @State private var model: ShareModel?
    @State private var skipped: [String] = []

    var body: some View {
        Group {
            if let model {
                ShareView(model: model, skipped: skipped, finish: finish)
            } else {
                NavigationStack {
                    ProgressView("Getting it ready…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { finish(false) } } }
                }
            }
        }
        .task {
            let staged = await ShareStaging.stage(providers, into: folder)
            skipped = staged.skipped
            let accounts = SharedAccount.parse(ShareKeychain.entries())
            let model = ShareModel(accounts: accounts, items: staged.items, transport: URLSessionTransport(), device: DeviceDescriptor(name: DeviceDescriptor.sanitizedName(UIDevice.current.model), client: "share-" + DeviceDescriptor.newClientID()))
            self.model = model
            await model.load()
        }
    }
}
