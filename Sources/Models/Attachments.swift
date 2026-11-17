import Foundation

/// What a message carries besides its words, as its tiles draw it: what you attached from a
/// composer (paths in ah's upload folder, `Uploads`) and pictures that came inline (one pasted
/// into the agent's own terminal, a screenshot a tool took). Each opens in full when tapped.
struct Attachment: Equatable, Sendable {
    enum Look: Equatable, Sendable {
        /// A photo or a screenshot: its thumbnail.
        case picture
        /// Its first frame, with a play mark.
        case video
        /// A card: the file's own preview when it has one, its name and what it is.
        case file
    }

    /// A host path, or a picture's `data:` URL.
    let source: String
    let name: String
    let look: Look
    let kind: FilesModel.Kind

    /// Films the system draws a frame of and plays (a WebM or an MKV is a file to it).
    private static let videoExtensions: Set<String> = ["mov", "mp4", "m4v"]

    static func upload(_ upload: Uploads.Upload) -> Attachment {
        let ext = upload.name.split(separator: ".").count > 1 ? upload.name.split(separator: ".").last.map { $0.lowercased() } ?? "" : ""
        let look: Look = upload.image ? .picture : videoExtensions.contains(ext) ? .video : .file
        return Attachment(source: upload.path, name: upload.name, look: look, kind: FilesModel.Kind(file: upload.name))
    }

    static func picture(_ source: String, alt: String? = nil) -> Attachment {
        Attachment(source: source, name: alt.flatMap { $0.isEmpty ? nil : $0 } ?? "Image", look: .picture, kind: .image)
    }

    /// A message's attachments in order (its uploads, then the pictures that came with it), and
    /// its words without the uploads' paths.
    static func of(_ text: String, media: [FeedPart] = []) -> (attachments: [Attachment], rest: String) {
        let split = Uploads.split(text)
        let pictures = media.compactMap { part -> Attachment? in
            guard case .media(_, let src, let alt) = part else { return nil }
            return picture(src, alt: alt)
        }
        return (split.uploads.map(upload) + pictures, split.rest)
    }
}
