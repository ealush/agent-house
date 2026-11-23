import Foundation

/// A picture, video or sound on the host, by its extension: what the host streams for a player
/// (`GET /api/fs/media`, feature `media`; apps/server/server/files.ts). Video and sound are only
/// the kinds AVPlayer plays; anything else opens as any file does.
enum MediaKind: Equatable, Sendable {
    case picture, video, sound

    init?(path: String) {
        switch (path as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif": self = .picture
        case "mp4", "m4v", "mov": self = .video
        case "mp3", "m4a", "aac", "wav", "flac": self = .sound
        default: return nil
        }
    }

    /// Streamed into the player as it plays, rather than fetched whole for Quick Look first (a
    /// screen recording runs to hundreds of megabytes).
    var plays: Bool { self != .picture }
}
