import Foundation
import Observation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Copies of host files on this device: an attachment's tile draws its thumbnail from one, and
/// Quick Look opens the same copy at once rather than fetching it again. An upload never
/// changes (each is saved under a name of its own), nor does a picture that came inline, so
/// their copies are kept while the app runs; any other file is fetched afresh each time it's
/// opened (the agent may have changed it since).
@MainActor
@Observable
final class HostFileStore {
    /// How a copy comes from the host: written to the file as it arrives, given up on past the
    /// limit, telling the closure the share so far (`APIClient.download`).
    typealias Fetch = @Sendable (_ path: String, _ file: URL, _ limit: Int?, _ progress: @escaping @Sendable (Double) -> Void) async throws -> APIClient.Download

    /// Bigger than this, a file isn't fetched only to draw its thumbnail (a screen recording);
    /// its tile says what it is, and opening it fetches it then.
    static let thumbnailLimit = 10 << 20

    /// The share fetched so far of each copy under way (0 to 1), by host path: its tile shows it.
    private(set) var progress: [String: Double] = [:]
    /// How big each file is, as far as the host has said: one too big to fetch for a thumbnail
    /// still says its size.
    private(set) var sizes: [String: Int] = [:]

    /// The copies kept, by host path: observed, so a tile that couldn't draw a big file draws
    /// it once it's been opened.
    private var kept: [String: URL] = [:]
    @ObservationIgnored private let fetch: Fetch
    @ObservationIgnored private let folder: URL
    @ObservationIgnored private var running: [String: Task<URL?, Never>] = [:]

    init(fetch: @escaping Fetch, folder: URL = HostFileStore.launchFolder) {
        self.fetch = fetch
        self.folder = folder
    }

    convenience init(api: APIClient, folder: URL = HostFileStore.launchFolder) {
        self.init(fetch: { path, file, limit, progress in try await api.download(path, to: file, atMost: limit, progress: progress) }, folder: folder)
    }

    /// Whether a copy of this host path is kept here.
    func has(_ path: String) -> Bool { kept[path] != nil }

    /// This launch's copies, in the temporary folder; an earlier launch's are let go.
    nonisolated static let launchFolder: URL = {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Attachments", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        return root.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }()

    /// The copy of `source` (a host path or a picture's `data:` URL) on this device, fetched if
    /// it isn't here yet; nil when it can't be had, or is bigger than `limit`.
    func local(_ source: String, atMost limit: Int? = nil) async -> URL? {
        if source.hasPrefix("data:") { return await inline(source) }
        let path = source
        guard Uploads.isUpload(path) else { return await download(path, limit: limit, keep: false) }
        if let url = kept[path], FileManager.default.fileExists(atPath: url.path) { return url }
        if let limit, let size = sizes[path], size > limit { return nil }
        // One fetch of a file at a time: a thumbnail's under way is the copy Quick Look opens,
        // unless it gives up on the size and this one wants it whole.
        while let task = running[path] {
            if let url = await task.value { return url }
            if let limit, let size = sizes[path], size > limit { return nil }
            if running[path] == task { break }
        }
        let task = Task { await download(path, limit: limit, keep: true) }
        running[path] = task
        return await task.value
    }

    private func download(_ path: String, limit: Int?, keep: Bool) async -> URL? {
        let name = Uploads.stripTimestamp((path as NSString).lastPathComponent)
        let dir = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = dir.appendingPathComponent(name.isEmpty ? "file" : name)
        progress[path] = 0
        defer {
            progress[path] = nil
            if keep { running[path] = nil }
        }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let outcome = try await fetch(path, file, limit) { [weak self] share in
                Task { @MainActor in self?.progressed(path, share) }
            }
            switch outcome {
            case .saved(let bytes):
                sizes[path] = bytes
                if keep { kept[path] = file }
                return file
            case .tooBig(let bytes):
                sizes[path] = bytes
                try? FileManager.default.removeItem(at: dir)
                return nil
            }
        } catch {
            try? FileManager.default.removeItem(at: dir)
            return nil
        }
    }

    /// In steps of a percent at least, and only while it's still under way (a late hop from
    /// the network mustn't bring a finished ring back).
    private func progressed(_ path: String, _ share: Double) {
        guard let was = progress[path], share >= 1 || share - was >= 0.01 else { return }
        progress[path] = min(1, share)
    }

    /// A picture that came inline, as a file named for what's in it: the same picture is one
    /// file however often it's asked for.
    private func inline(_ source: String) async -> URL? {
        let folder = folder.appendingPathComponent("inline", isDirectory: true)
        return await Task.detached(priority: .userInitiated) {
            guard case .inline(let data) = WidgetModel.imageSource(source) else { return nil }
            let digest = SHA256.hash(data: data).prefix(16).map { String(format: "%02x", $0) }.joined()
            let file = folder.appendingPathComponent("\(digest).\(Self.inlineExtension(source))")
            if FileManager.default.fileExists(atPath: file.path) { return file }
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                #if os(iOS)
                try data.write(to: file, options: [.atomic, .completeFileProtection])
                #else
                try data.write(to: file, options: [.atomic])
                #endif
                return file
            } catch {
                return nil
            }
        }.value
    }

    /// "data:image/jpeg;base64,…" → "jpg": the extension that tells Quick Look what it is.
    nonisolated static func inlineExtension(_ source: String) -> String {
        guard source.hasPrefix("data:image/"), let end = source.firstIndex(where: { $0 == ";" || $0 == "," }) else { return "png" }
        let subtype = source[source.index(source.startIndex, offsetBy: "data:image/".count)..<end].lowercased()
        switch subtype {
        case "jpeg", "pjpeg": return "jpg"
        case "svg+xml": return "svg"
        case "": return "png"
        default: return subtype.allSatisfy { $0.isLetter || $0.isNumber } ? subtype : "png"
        }
    }
}
