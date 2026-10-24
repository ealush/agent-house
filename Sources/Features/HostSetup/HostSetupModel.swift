import Foundation
import Observation

@MainActor
@Observable
final class HostSetupModel {
    var address = ""
    private(set) var isRestoring = true
    private(set) var isSaving = false
    private(set) var notice: String?
    private(set) var error: String?

    private let sceneID: String
    private let store: SceneRepository?
    private var savedOrigin: String?
    private var canPersist = false

    init(sceneID: String, store: SceneRepository?) {
        self.sceneID = sceneID
        self.store = store
    }

    func restore() async {
        defer { isRestoring = false }
        guard let store else {
            error = "Couldn’t open this device’s storage. Nothing will be saved."
            return
        }
        do {
            let snapshot = try store.load(sceneID: sceneID)
            try Task.checkCancellation()
            savedOrigin = snapshot?.hostOrigin
            canPersist = true
            address = savedOrigin ?? ""
            if savedOrigin != nil { notice = "Host address saved on this device." }
        } catch is CancellationError {
            return
        } catch {
            self.error = "Couldn’t restore this window. Your saved data has been kept."
        }
    }

    func saveAddress() async {
        guard !isRestoring && !isSaving else { return }
        error = nil
        notice = nil
        isSaving = true
        defer { isSaving = false }
        guard let store else {
            error = "Couldn’t open this device’s storage. Nothing will be saved."
            return
        }
        do {
            let endpoint = try HostEndpoint(address)
            try store.save(SceneSnapshot(sceneID: sceneID, hostOrigin: endpoint.url.absoluteString))
            savedOrigin = endpoint.url.absoluteString
            canPersist = true
            address = endpoint.url.absoluteString
            notice = "Host address saved on this device."
        } catch let validation as HostEndpoint.ValidationError {
            error = validation.localizedDescription
        } catch {
            self.error = "Couldn’t save the host address. Try again."
        }
    }

    func persist() async {
        // A failed load must not let a background callback overwrite the journal.
        guard canPersist && !isRestoring && !isSaving else { return }
        do {
            try store?.save(SceneSnapshot(sceneID: sceneID, hostOrigin: savedOrigin))
        } catch {
            self.error = "Couldn’t save this window’s state."
        }
    }
}

