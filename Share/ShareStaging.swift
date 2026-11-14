import Foundation
import Security
import UniformTypeIdentifiers

/// The sign-ins the app keeps in its Keychain group (shared with this extension), read only.
enum ShareKeychain {
    /// Every `credential:<origin>` entry, as `ShareModel` reads them.
    static func entries(service: String = "dev.ealush.ah.native") -> [(account: String, data: Data)] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let account = item[kSecAttrAccount as String] as? String, account.hasPrefix("credential:"), let data = item[kSecValueData as String] as? Data else { return nil }
            return (account, data)
        }
    }
}

/// What the sharing app hands over, copied into this extension's own folder before it lets
/// go: files stream to disk (never decoded into memory), text past a message's limit becomes
/// a file, and the folder goes when the extension's done (and anything older at the next share).
/// The providers stay on the main actor; their files are copied on the loader's own queue.
@MainActor
enum ShareStaging {
    /// Over this many bytes in all, nothing more is staged: a share isn't a backup.
    nonisolated static let budget: Int64 = 1_000_000_000

    nonisolated static let root = FileManager.default.temporaryDirectory.appendingPathComponent("ah-share", isDirectory: true)

    /// A new folder for one share; folders left from a share that was killed go.
    nonisolated static func folder() -> URL {
        let fm = FileManager.default
        if let old = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey]) {
            for dir in old where ((try? dir.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) < Date().addingTimeInterval(-3600) {
                try? fm.removeItem(at: dir)
            }
        }
        let dir = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    nonisolated static func discard(_ folder: URL) { try? FileManager.default.removeItem(at: folder) }

    struct Result: Sendable {
        var items: [SharedItem] = []
        /// What couldn't be taken, said in the sheet.
        var skipped: [String] = []
    }

    /// Everything in the extension's input, in order.
    static func stage(_ providers: [NSItemProvider], into folder: URL) async -> Result {
        var result = Result()
        var used: Int64 = 0
        for provider in providers {
            do {
                if let item = try await stage(provider, into: folder, used: used) {
                    if case .file(let file) = item { used += file.bytes }
                    result.items.append(item)
                }
            } catch {
                result.skipped.append(provider.suggestedName ?? "One item")
            }
        }
        return result
    }

    private static func stage(_ provider: NSItemProvider, into folder: URL, used: Int64) async throws -> SharedItem? {
        // A web page's address (Safari): the link, not the page's file.
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            if let url = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, url.scheme == "http" || url.scheme == "https" {
                return .link(url)
            }
        }
        for (type, kind) in [(UTType.image, StagedFile.Kind.image), (.movie, .movie), (.pdf, .file), (.data, .file)] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            // Plain text arrives as `public.data` too: it's words, not a file.
            if type == .data, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) { break }
            return .file(try await copy(provider, type: type, kind: kind, into: folder, used: used))
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            let loaded = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
            let text = (loaded as? String) ?? (loaded as? Data).flatMap { String(data: $0, encoding: .utf8) } ?? ""
            guard !text.isEmpty else { return nil }
            guard ShareMessage.needsFile(text) else { return .text(text) }
            let file = folder.appendingPathComponent("shared-text.txt")
            try Data(text.utf8).write(to: file)
            return .file(StagedFile(name: "shared-text.txt", url: file, bytes: Int64(text.utf8.count), kind: .file))
        }
        return nil
    }

    /// The file's own representation, copied while the sharing app still holds it.
    private static func copy(_ provider: NSItemProvider, type: UTType, kind: StagedFile.Kind, into folder: URL, used: Int64) async throws -> StagedFile {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url else { return continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown)) }
                do {
                    let size = Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
                    guard used + size <= budget else { throw CocoaError(.fileWriteOutOfSpace) }
                    let name = Self.name(url.lastPathComponent, suggested: provider.suggestedName, type: type)
                    let target = folder.appendingPathComponent(String(UUID().uuidString.prefix(8)) + "-" + name)
                    // A clone where the volume can, a copy otherwise: never read into memory.
                    try FileManager.default.copyItem(at: url, to: target)
                    continuation.resume(returning: StagedFile(name: name, url: target, bytes: size, kind: kind))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// A name for the host's upload: the file's own, else the suggested one with its type's extension.
    nonisolated static func name(_ fileName: String, suggested: String?, type: UTType) -> String {
        let ext = (fileName as NSString).pathExtension
        if !fileName.isEmpty, !ext.isEmpty, !fileName.hasPrefix(".") { return fileName }
        let base = suggested?.isEmpty == false ? suggested! : "shared"
        let want = ext.isEmpty ? (type.preferredFilenameExtension ?? "bin") : ext
        return (base as NSString).pathExtension.isEmpty ? "\(base).\(want)" : base
    }
}
