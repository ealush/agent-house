import AVFoundation
import ImageIO
import QuickLookThumbnailing
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What a message carries, as tiles you tap to open in Quick Look: pictures and videos as
/// thumbnails (one alone larger, at its own shape), other files as cards under them, each with
/// the file's own preview when it has one.
struct AttachmentStrip: View {
    let attachments: [Attachment]
    var alignment: HorizontalAlignment = .leading
    @Environment(\.pictureLook) private var look

    var body: some View {
        let visual = attachments.enumerated().filter { $0.element.look != .file }
        let files = attachments.enumerated().filter { $0.element.look == .file }
        // The pictures and videos open together, to swipe through; a file opens on its own.
        let gallery = visual.map(\.element.source)
        VStack(alignment: alignment, spacing: 6) {
            if visual.count == 1, let only = visual.first {
                AttachmentTile(attachment: only.element, shape: .lone)
            } else if visual.count > 1, look == .stack {
                AttachmentPile(attachments: visual.map(\.element))
            } else if !visual.isEmpty {
                FlowLayout(alignment: alignment, spacing: 6) {
                    ForEach(Array(visual.enumerated()), id: \.element.offset) { place, tile in
                        AttachmentTile(attachment: tile.element, shape: .square, among: Among(sources: gallery, index: place))
                    }
                }
            }
            if !files.isEmpty {
                FlowLayout(alignment: alignment, spacing: 6) {
                    ForEach(files, id: \.offset) { AttachmentTile(attachment: $0.element, shape: .card) }
                }
            }
        }
    }
}

private struct PictureLookKey: EnvironmentKey {
    static let defaultValue: DevicePreferences.PictureLook = .stack
}

extension EnvironmentValues {
    /// Several pictures in a message in a pile or side by side (Settings → Appearance).
    var pictureLook: DevicePreferences.PictureLook {
        get { self[PictureLookKey.self] }
        set { self[PictureLookKey.self] = newValue }
    }
}

/// Several pictures and videos in a pile: the first on top, two more askew under it, and how
/// many there are. Tapped, they all open in Quick Look from the first, to swipe through.
struct AttachmentPile: View {
    let attachments: [Attachment]

    /// Each one under the top: turned and nudged, the nearest one way and the next the other.
    private static let askew: [(degrees: Double, x: CGFloat, y: CGFloat)] = [(6, 6, 1), (-7, -6, 2)]

    var body: some View {
        let under = Array(attachments.dropFirst().prefix(2).enumerated())
        ZStack {
            ForEach(under.reversed(), id: \.offset) { place, attachment in
                AttachmentTile(attachment: attachment, shape: .square)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                    .rotationEffect(.degrees(Self.askew[place].degrees))
                    .offset(x: Self.askew[place].x, y: Self.askew[place].y)
            }
            AttachmentTile(attachment: attachments[0], shape: .square, among: Among(sources: attachments.map(\.source), index: 0), pile: attachments)
                .shadow(color: .black.opacity(0.16), radius: 4, y: 2)
        }
        // Room for the corners turned out past the top one.
        .padding(10)
    }
}

/// Tiles in rows that wrap, each row to one side.
struct FlowLayout: Layout {
    var alignment: HorizontalAlignment = .leading
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(within: proposal.width ?? .infinity, subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(within: bounds.width, subviews) {
            var x = alignment == .trailing ? bounds.maxX - row.width : bounds.minX
            for (index, size) in row.items {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [(Int, CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    /// Each tile at its own width (no wider than the room), as many to a row as fit.
    private func rows(within room: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let ideal = subviews[index].sizeThatFits(.unspecified)
            let width = min(ideal.width, room)
            let size = width < ideal.width ? CGSize(width: width, height: subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil)).height) : ideal
            if !row.items.isEmpty, row.width + spacing + size.width > room {
                rows.append(row)
                row = Row()
            }
            row.width += (row.items.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.items.append((index, size))
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// Where a tile is among the pictures and videos it opens with: all of their sources, and its place.
struct Among: Equatable, Sendable {
    let sources: [String]
    let index: Int
}

/// One attachment's tile. Tapped, it opens in Quick Look (with the others it's `among`, to
/// swipe through): fetched first if it isn't on this device yet, a ring filling over it as it comes.
struct AttachmentTile: View {
    enum Shape: Equatable {
        /// Among others: a square.
        case square
        /// The only picture: taller, at its own width.
        case lone
        /// A file: its preview beside its name and what it is.
        case card
    }

    let attachment: Attachment
    let shape: Shape
    var among: Among? = nil
    /// On top of a pile: everything in it, counted on the tile and said with it.
    var pile: [Attachment]? = nil
    @Environment(\.hostFiles) private var hostFiles
    @Environment(\.theme) private var theme
    @Environment(\.displayScale) private var displayScale
    @State private var drawn: Thumbnail?
    @State private var opening = false
    /// Shown once opening takes a moment: one already here opens without a spinner's flash.
    @State private var ringShown = false
    /// Where Quick Look grows out of and goes back into.
    @State private var origin = QuickLookOrigin.Mark()

    static let side: CGFloat = 104
    static let loneHeight: CGFloat = 180
    static let cardPreview = CGSize(width: 36, height: 44)

    /// Drawn again (a row laid out anew), it starts with the thumbnail it had: started over
    /// empty, a lone picture's width came and went.
    init(attachment: Attachment, shape: Shape, among: Among? = nil, pile: [Attachment]? = nil) {
        self.attachment = attachment
        self.shape = shape
        self.among = among
        self.pile = pile
        _drawn = State(initialValue: Thumbnails.cached(attachment.source, shape))
    }

    var body: some View {
        Button {
            guard !opening, let open = hostFiles?.open else { return }
            Haptics.tap()
            opening = true
            QuickLookOrigin.set(origin)
            Task {
                let ring = Task {
                    try await Task.sleep(for: .milliseconds(150))
                    ringShown = true
                }
                if let among, among.sources.count > 1, let browse = hostFiles?.browse {
                    await browse(among.sources, among.index)
                } else {
                    await open(attachment.source)
                }
                ring.cancel()
                ringShown = false
                opening = false
            }
        } label: {
            Group {
                if shape == .card { card } else { picture }
            }
            .quickLookOrigin(origin, id: attachment.source)
            .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 12, style: .continuous))
            .hoverEffect(.lift)
        }
        .buttonStyle(TilePress())
        .disabled(hostFiles?.open == nil)
        // Again once its file is here (a video too big for a thumbnail, opened).
        .task(id: Redraw(source: attachment.source, here: hostFiles?.kept?.has(attachment.source) ?? false)) { await draw() }
        .accessibilityLabel(spoken)
        .accessibilityHint(hostFiles?.open == nil ? "" : "Opens it")
    }

    // MARK: Pictures and videos

    private var picture: some View {
        let height = shape == .lone ? Self.loneHeight : Self.side
        return ZStack {
            theme.tile
            if let drawn {
                Image(uiImage: drawn.image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: width(height), height: height)
                    .transition(.opacity.animation(.easeOut(duration: 0.2)))
                // Opening: dimmed under the ring, the play mark out of its way.
                if ringShown {
                    FetchRing(files: hostFiles?.kept, source: attachment.source)
                } else if attachment.look == .video {
                    PlayMark(small: shape == .square)
                }
            } else {
                // Not here (too big to fetch for a thumbnail, or not drawn yet): what it is, and
                // while it comes to open, the ring in its glyph's place.
                VStack(spacing: 6) {
                    Group {
                        if ringShown {
                            FetchRing(files: hostFiles?.kept, source: attachment.source, size: shape == .lone ? 28 : 22, dims: false)
                        } else {
                            Image(systemName: attachment.look == .video ? "play.circle" : "photo")
                                .font(.ah(shape == .lone ? .title : .title3))
                                .foregroundStyle(theme.faint)
                        }
                    }
                    .frame(height: shape == .lone ? 34 : 26)
                    Text(attachment.name)
                        .font(.ah(.caption2))
                        .foregroundStyle(theme.muted)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .multilineTextAlignment(.center)
                    if let size = size { Text(size).font(.ah(.caption2)).foregroundStyle(theme.faint).monospacedDigit() }
                }
                .padding(8)
            }
        }
        .frame(width: width(height), height: height)
        .overlay(alignment: .bottomTrailing) {
            if let pile {
                // How many: a video's length waits until it's open.
                PileCount(count: pile.count)
            } else if let seconds = drawn?.duration {
                Text(Thumbnails.length(seconds))
                    .font(.ah(.caption2).weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.5), radius: 2)
                    .padding(6)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.line, lineWidth: 1))
    }

    /// A lone picture at its own shape (within bounds: a tall screenshot doesn't make a sliver);
    /// a square among others.
    private func width(_ height: CGFloat) -> CGFloat {
        guard shape == .lone else { return Self.side }
        guard let drawn, drawn.aspect > 0 else { return height }
        return min(max(height * drawn.aspect, 120), 280)
    }

    // MARK: Files

    private var card: some View {
        HStack(spacing: 10) {
            ZStack {
                if let drawn {
                    Image(uiImage: drawn.image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                        .shadow(color: .black.opacity(0.18), radius: 1, y: 0.5)
                        .transition(.opacity.animation(.easeOut(duration: 0.2)))
                } else {
                    RoundedRectangle(cornerRadius: 6, style: .continuous).fill(theme.raised)
                    Image(systemName: attachment.kind.symbol).font(.ah(.body)).foregroundStyle(theme.muted)
                }
            }
            .frame(width: Self.cardPreview.width, height: Self.cardPreview.height)
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name)
                    .font(.ah(.footnote).weight(.medium))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text([Thumbnails.kindName(attachment), size].compactMap { $0 }.joined(separator: " · "))
                    .font(.ah(.caption2))
                    .foregroundStyle(theme.muted)
                    .lineLimit(1)
            }
            .frame(minWidth: 60, alignment: .leading)
            if ringShown {
                FetchRing(files: hostFiles?.kept, source: attachment.source, size: 18, dims: false)
                    .frame(width: 22, height: 22)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: 280, alignment: .leading)
        .background(theme.tile, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.line, lineWidth: 1))
    }

    // MARK: Drawing

    private var size: String? {
        hostFiles?.kept?.sizes[attachment.source].map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
    }

    private var spoken: String {
        if let pile {
            let what = pile.allSatisfy { $0.look == .picture } ? "pictures" : pile.allSatisfy { $0.look == .video } ? "videos" : "pictures and videos"
            return "\(pile.count) \(what): " + pile.map(\.name).joined(separator: ", ")
        }
        let what = attachment.look == .picture ? "Image" : attachment.look == .video ? "Video" : Thumbnails.kindName(attachment)
        let length = drawn?.duration.map { Duration.seconds($0).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .wide)) }
        return [what, attachment.name, length, size].compactMap { $0 }.joined(separator: ", ")
    }

    private struct Redraw: Equatable {
        let source: String
        let here: Bool
    }

    private func draw() async {
        let here = hostFiles?.kept?.has(attachment.source) ?? false
        guard drawn == nil, here || !Thumbnails.missedLately(attachment.source, shape), Thumbnails.drawable(attachment) else { return }
        let pixels = Thumbnails.pixels(shape, scale: displayScale)
        var made: Thumbnail?
        if let kept = hostFiles?.kept {
            // A picture whatever its size (it's what the tile is); anything else only when it's
            // small enough to fetch just for this.
            let limit = attachment.look == .picture ? nil : HostFileStore.thumbnailLimit
            if let url = await kept.local(attachment.source, atMost: limit) {
                made = await Thumbnails.draw(attachment, at: url, pixels: pixels)
            }
        } else if attachment.look == .picture {
            // Where nothing's kept (a review's pictures), the picture's bytes as it's loaded.
            let found = await Task.detached(priority: .userInitiated) { [source = attachment.source] in WidgetModel.imageSource(source) }.value
            let data: Data? = switch found {
            case .inline(let data): data
            case .hostFile(let path): await hostFiles?.load(path)
            case .remote, .unavailable: nil
            }
            if let data { made = await Thumbnails.picture(data, pixels: pixels) }
        }
        guard !Task.isCancelled else { return }
        Thumbnails.remember(made, for: attachment.source, shape)
        drawn = made
    }
}

/// A picture or a video's frame on the host as a small square, drawn from the session's copy (a
/// composer's tile for an upload that came back into the box).
struct KeptPicture: View {
    let attachment: Attachment
    let side: CGFloat
    @Environment(\.hostFiles) private var hostFiles
    @Environment(\.theme) private var theme
    @Environment(\.displayScale) private var displayScale
    @State private var drawn: Thumbnail?

    init(attachment: Attachment, side: CGFloat) {
        self.attachment = attachment
        self.side = side
        _drawn = State(initialValue: Thumbnails.cached(attachment.source, .square))
    }

    var body: some View {
        ZStack {
            theme.tile
            if let drawn {
                Image(uiImage: drawn.image).resizable().scaledToFill().transition(.opacity.animation(.easeOut(duration: 0.2)))
            } else {
                Image(systemName: attachment.look == .video ? "play.rectangle" : "photo").font(.ah(.title3)).foregroundStyle(theme.faint)
            }
        }
        .frame(width: side, height: side)
        .clipped()
        // A video's frame, marked as the composer marks one just picked.
        .overlay(alignment: .bottomLeading) {
            if drawn != nil, attachment.look == .video {
                Image(systemName: "play.fill").font(.ah(.caption2)).foregroundStyle(.white).shadow(radius: 2).padding(6)
            }
        }
        .task(id: attachment.source) {
            guard drawn == nil, !Thumbnails.missedLately(attachment.source, .square), let kept = hostFiles?.kept else { return }
            var made: Thumbnail?
            if let url = await kept.local(attachment.source, atMost: attachment.look == .picture ? nil : HostFileStore.thumbnailLimit) {
                made = await Thumbnails.draw(attachment, at: url, pixels: Thumbnails.pixels(.square, scale: displayScale))
            }
            guard !Task.isCancelled else { return }
            Thumbnails.remember(made, for: attachment.source, .square)
            drawn = made
        }
    }
}

/// A gentle give under the finger, for a tile or a picture (the round controls' 12% was a lurch
/// at this size).
struct TilePress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// How many are in a pile, over its top tile's corner.
private struct PileCount: View {
    let count: Int

    var body: some View {
        Label("\(count)", systemImage: "photo.stack.fill")
            .labelStyle(PileCountStyle())
            .font(.ah(.caption2).weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.leading, 6)
            .padding(.trailing, 8)
            .padding(.vertical, 3)
            .background(.black.opacity(0.6), in: Capsule())
            .padding(6)
            .accessibilityHidden(true)
    }
}

private struct PileCountStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

/// A video's mark: play, on glass over its frame.
private struct PlayMark: View {
    let small: Bool

    var body: some View {
        Image(systemName: "play.fill")
            .font(.system(size: small ? 13 : 17, weight: .semibold))
            .foregroundStyle(.white)
            .offset(x: 1)
            .frame(width: small ? 32 : 44, height: small ? 32 : 44)
            .background(.ultraThinMaterial.opacity(0.9), in: Circle())
            .environment(\.colorScheme, .dark)
            .accessibilityHidden(true)
    }
}

/// How much of a file has come while it's fetched to open: a ring filling (a spinner until the
/// host says how big it is). Its own view, so only it draws again as the share moves.
struct FetchRing: View {
    let files: HostFileStore?
    let source: String
    var size: CGFloat = 26
    /// Over a picture: dimmed under it, the ring in white.
    var dims = true

    var body: some View {
        FillingRing(fraction: files?.progress[source], size: size, dims: dims)
    }
}

/// A share as a ring filling (a spinner while there's nothing to count yet), over a dimmed tile
/// or on its own.
struct FillingRing: View {
    let fraction: Double?
    var size: CGFloat = 26
    var dims = true
    @Environment(\.theme) private var theme

    var body: some View {
        let ink = dims ? Color.white : theme.accent
        ZStack {
            if dims { Color.black.opacity(0.3) }
            if let fraction, fraction >= 0.01 {
                Circle().stroke(ink.opacity(0.3), lineWidth: size > 20 ? 3 : 2).frame(width: size, height: size)
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(ink, style: StrokeStyle(lineWidth: size > 20 ? 3 : 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: size, height: size)
                    .animation(.spring(duration: 0.35, bounce: 0), value: fraction)
            } else {
                ProgressView().tint(ink).controlSize(size > 20 ? .regular : .small)
            }
        }
        .accessibilityHidden(true)
    }
}

/// An attachment's thumbnail as drawn.
final class Thumbnail: Sendable {
    let image: UIImage
    /// Width over height (a lone picture's tile takes its shape).
    let aspect: CGFloat
    /// A video's length, in seconds.
    let duration: Double?

    init(image: UIImage, duration: Double? = nil) {
        self.image = image
        aspect = image.size.height > 0 ? image.size.width / image.size.height : 1
        self.duration = duration
    }
}

/// Attachments' thumbnails, drawn once per size and kept a while: a row scrolled back into view
/// draws at once, and a sent message's bubble shows what its last one did.
@MainActor
enum Thumbnails {
    /// A cache a shape, keyed by the source as it is (a picture that came inline is megabytes of
    /// text: never copied into a longer key).
    private static let drawn = caches(of: Thumbnail.self) { $0.totalCostLimit = 48 << 20 }
    /// Sources with nothing to draw, and when: tried again only after a while (a host out of
    /// reach may be back).
    private static let missed = caches(of: NSDate.self) { _ in }

    private static func caches<T: AnyObject>(of: T.Type, _ configure: (NSCache<NSString, T>) -> Void) -> [AttachmentTile.Shape: NSCache<NSString, T>] {
        var caches: [AttachmentTile.Shape: NSCache<NSString, T>] = [:]
        for shape in [AttachmentTile.Shape.square, .lone, .card] {
            let cache = NSCache<NSString, T>()
            cache.countLimit = 120
            configure(cache)
            caches[shape] = cache
        }
        return caches
    }

    static func cached(_ source: String, _ shape: AttachmentTile.Shape) -> Thumbnail? {
        drawn[shape]?.object(forKey: source as NSString)
    }

    static func missedLately(_ source: String, _ shape: AttachmentTile.Shape) -> Bool {
        missed[shape]?.object(forKey: source as NSString).map { Date.now.timeIntervalSince($0 as Date) < 60 } ?? false
    }

    static func remember(_ made: Thumbnail?, for source: String, _ shape: AttachmentTile.Shape) {
        if let made {
            let bytes = made.image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            drawn[shape]?.setObject(made, forKey: source as NSString, cost: bytes)
        } else {
            missed[shape]?.setObject(NSDate(), forKey: source as NSString)
        }
    }

    /// Whether there can be a thumbnail: a picture or a video, or a file the system draws (a
    /// PDF's first page, text). Not an archive or a sound: they'd be fetched for nothing.
    static func drawable(_ attachment: Attachment) -> Bool {
        switch attachment.look {
        case .picture, .video: return true
        case .file: return ![FilesModel.Kind.archive, .media, .folder].contains(attachment.kind)
        }
    }

    /// The longest side's pixels a shape draws at.
    static func pixels(_ shape: AttachmentTile.Shape, scale: CGFloat) -> CGFloat {
        switch shape {
        case .square: return AttachmentTile.side * scale
        case .lone: return 280 * scale
        case .card: return AttachmentTile.cardPreview.height * scale
        }
    }

    static func draw(_ attachment: Attachment, at url: URL, pixels: CGFloat) async -> Thumbnail? {
        switch attachment.look {
        case .picture: return await picture(url, pixels: pixels)
        case .video: return await video(url, pixels: pixels)
        case .file: return await file(url, pixels: pixels)
        }
    }

    /// Decoded off the main thread at no more pixels than it's drawn at.
    nonisolated static func picture(_ url: URL, pixels: CGFloat) async -> Thumbnail? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
            return thumbnail(source, pixels: pixels)
        }.value
    }

    nonisolated static func picture(_ data: Data, pixels: CGFloat) async -> Thumbnail? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return thumbnail(source, pixels: pixels)
        }.value
    }

    private nonisolated static func thumbnail(_ source: CGImageSource, pixels: CGFloat) -> Thumbnail? {
        let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: max(1, pixels)] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return Thumbnail(image: UIImage(cgImage: image))
    }

    /// Its first frame, and how long it runs.
    nonisolated static func video(_ url: URL, pixels: CGFloat) async -> Thumbnail? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: pixels, height: pixels)
        generator.requestedTimeToleranceAfter = .positiveInfinity
        guard let frame = try? await generator.image(at: .zero).image else { return nil }
        let seconds = try? await asset.load(.duration).seconds
        return Thumbnail(image: UIImage(cgImage: frame), duration: seconds.flatMap { $0.isFinite && $0 > 0 ? $0 : nil })
    }

    /// The system's own thumbnail of a file (a PDF's first page, the top of a text), if it has one.
    nonisolated static func file(_ url: URL, pixels: CGFloat) async -> Thumbnail? {
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: pixels, height: pixels), scale: 1, representationTypes: .thumbnail)
        guard let made = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request) else { return nil }
        return Thumbnail(image: made.uiImage)
    }

    /// "PDF document", "Plain text": what the system calls it; its extension else.
    static func kindName(_ attachment: Attachment) -> String {
        if attachment.source.hasPrefix("data:") { return "Image" }
        let ext = (attachment.name as NSString).pathExtension
        if let described = UTType(filenameExtension: ext)?.localizedDescription, !described.isEmpty {
            return described.prefix(1).uppercased() + described.dropFirst()
        }
        return ext.isEmpty ? "File" : "\(ext.uppercased()) file"
    }

    /// "0:12", "1:04:09".
    static func length(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
