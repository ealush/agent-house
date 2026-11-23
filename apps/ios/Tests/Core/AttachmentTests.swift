import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

/// A host's file API (`GET /api/fs/file`, and its media stream `GET /api/fs/media`), streamed a
/// few bytes at a time, counting each fetch and the route it came by.
private actor FileHost {
    var files: [String: Data]
    /// Whether it says how big a file is (ah does; a proxy may not).
    var declaresLength = true
    private(set) var fetched: [String] = []
    private(set) var routes: [String] = []

    init(_ files: [String: Data]) { self.files = files }

    func take(_ path: String, by route: String = "/api/fs/file") -> Data? {
        fetched.append(path)
        routes.append(route)
        return files[path]
    }

    func hidingLength() { declaresLength = false }
}

private struct FileTransport: HTTPTransport {
    let host: FileHost

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        let path = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value ?? ""
        guard let data = await host.take(path, by: request.url!.path) else {
            let missing = HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            return (missing, AsyncThrowingStream { $0.yield(Data(#"{"error":"not found"}"#.utf8)); $0.finish() })
        }
        let headers = await host.declaresLength ? ["Content-Length": "\(data.count)"] : [:]
        let ok = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        let stream = AsyncThrowingStream<Data, any Error> { continuation in
            var at = 0
            while at < data.count {
                continuation.yield(Data(data[at..<min(at + 4, data.count)]))
                at += 4
            }
            continuation.finish()
        }
        return (ok, stream)
    }
}

private let upload = "/home/u/.cache/ah/uploads/2026-11-17T10-00-00-000Z-shot.png"
private let tenBytes = Data("0123456789".utf8)

private func client(_ host: FileHost) -> APIClient {
    APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: FileTransport(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
}

private func scratch() -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("AttachmentTests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private final class Shares: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [Double] = []
    func add(_ share: Double) { lock.withLock { list.append(share) } }
    var all: [Double] { lock.withLock { list } }
}

@Test func aDownloadWritesTheFileAsItComesAndSaysHowFar() async throws {
    let api = client(FileHost([upload: tenBytes]))
    let file = scratch().appendingPathComponent("shot.png")
    let shares = Shares()
    let outcome = try await api.download(upload, to: file, progress: { shares.add($0) })
    #expect(outcome == .saved(10))
    #expect(try Data(contentsOf: file) == tenBytes)
    #expect(shares.all == [0.4, 0.8, 1])
}

@Test func aDownloadPastItsLimitKeepsNothing() async throws {
    let host = FileHost([upload: tenBytes])
    let api = client(host)
    let dir = scratch()
    // Said to be too big: given up on before a byte is written.
    let declared = dir.appendingPathComponent("a.png")
    #expect(try await api.download(upload, to: declared, atMost: 5) == .tooBig(10))
    #expect(!FileManager.default.fileExists(atPath: declared.path))
    // Not said: given up on once it passes the limit, the part that came thrown away.
    await host.hidingLength()
    let streamed = dir.appendingPathComponent("b.png")
    #expect(try await api.download(upload, to: streamed, atMost: 5) == .tooBig(8))
    #expect(!FileManager.default.fileExists(atPath: streamed.path))
    // Within it: all of it.
    #expect(try await api.download(upload, to: streamed, atMost: 10) == .saved(10))
}

@Test func aFileTheHostDoesntHaveIsAnErrorAndLeavesNothing() async {
    let api = client(FileHost([:]))
    let file = scratch().appendingPathComponent("gone.png")
    await #expect(throws: APIError.self) { try await api.download(upload, to: file) }
    #expect(!FileManager.default.fileExists(atPath: file.path))
}

@MainActor
@Test func anUploadIsFetchedOnceAndKeptUnderTheNameYouGaveIt() async throws {
    let host = FileHost([upload: tenBytes])
    let store = HostFileStore(api: client(host), folder: scratch())
    let first = try #require(await store.local(upload))
    let again = try #require(await store.local(upload))
    #expect(first == again)
    #expect(first.lastPathComponent == "shot.png")
    #expect(await host.fetched == [upload])
    #expect(store.sizes[upload] == 10)
    #expect(store.progress.isEmpty)
}

@MainActor
@Test func anyOtherFileIsFetchedAfreshEachTimeItOpens() async throws {
    // The agent may have changed it since.
    let path = "/home/u/orbit/src/router.ts"
    let host = FileHost([path: tenBytes])
    let store = HostFileStore(api: client(host), folder: scratch())
    let first = try #require(await store.local(path))
    let again = try #require(await store.local(path))
    #expect(first != again)
    #expect(await host.fetched == [path, path])
}

@MainActor
@Test func aThumbnailGivesUpOnABigFileButOpeningItFetchesIt() async throws {
    let host = FileHost([upload: tenBytes])
    let store = HostFileStore(api: client(host), folder: scratch())
    #expect(await store.local(upload, atMost: 4) == nil)
    #expect(store.sizes[upload] == 10)
    // Known to be too big: not asked for again just for a thumbnail.
    #expect(await store.local(upload, atMost: 4) == nil)
    #expect(await host.fetched.count == 1)
    // Opened: all of it.
    let opened = try #require(await store.local(upload))
    #expect(try Data(contentsOf: opened) == tenBytes)
    #expect(await host.fetched.count == 2)
}

@MainActor
@Test func openingWhileItsThumbnailIsFetchedWaitsForThatFetch() async throws {
    let host = FileHost([upload: tenBytes])
    let store = HostFileStore(api: client(host), folder: scratch())
    async let thumbnail = store.local(upload, atMost: HostFileStore.thumbnailLimit)
    async let opened = store.local(upload)
    let (a, b) = await (thumbnail, opened)
    #expect(a != nil && a == b)
    #expect(await host.fetched == [upload])
}

@MainActor
@Test func aPictureThatCameInlineIsOneFileNamedForWhatItIs() async throws {
    let host = FileHost([:])
    let store = HostFileStore(api: client(host), folder: scratch())
    let png = "data:image/png;base64," + Data([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).base64EncodedString()
    let first = try #require(await store.local(png))
    let again = try #require(await store.local(png))
    #expect(first == again && first.pathExtension == "png")
    #expect(try Data(contentsOf: first) == Data([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    let other = try #require(await store.local("data:image/png;base64," + Data([9, 9]).base64EncodedString()))
    #expect(other != first)
    #expect(await host.fetched.isEmpty)
    #expect(await store.local("data:text/html;base64,PGI+") == nil)
    #expect(HostFileStore.inlineExtension("data:image/jpeg;base64,AA") == "jpg")
    #expect(HostFileStore.inlineExtension("data:image/svg+xml;base64,AA") == "svg")
    #expect(HostFileStore.inlineExtension("data:image/webp;base64,AA") == "webp")
}

@Test func aMessagesAttachmentsReadAsPicturesVideosAndFiles() {
    let dir = "/home/u/.cache/ah/uploads/"
    let text = "\(dir)2026-11-17T10-00-00-000Z-photo.heic \(dir)2026-11-17T10-00-01-000Z-video.mov '\(dir)2026-11-17T10-00-02-000Z-q3 report.pdf' \(dir)2026-11-17T10-00-03-000Z-clip.webm what's wrong here?"
    let media: [FeedPart] = [.text("what's wrong here?"), .media(kind: "image", src: "data:image/png;base64,AA", alt: nil)]
    let split = Attachment.of(text, media: media)
    #expect(split.attachments.map(\.name) == ["photo.heic", "video.mov", "q3 report.pdf", "clip.webm", "Image"])
    #expect(split.attachments.map(\.look) == [.picture, .video, .file, .file, .picture])
    #expect(split.attachments.map(\.kind) == [.image, .media, .pdf, .media, .image])
    #expect(split.rest == "what's wrong here?")
    // A photo from an iPhone's library counts as the picture it is.
    #expect(Uploads.summary(text) == "1 image, 3 files · what's wrong here?")
    #expect(Attachment.of("just words").attachments.isEmpty)
}

@MainActor
private final class Flag {
    var on = false
}

@MainActor
@Test func picturesAndVideoComeThroughTheMediaStreamOnceTheHostHasOne() async throws {
    // The stream also reads the media folders (~/Videos), which the file API doesn't browse.
    let video = "/home/u/Videos/agent house.mp4"
    let notes = "/home/u/orbit/notes.txt"
    let host = FileHost([video: tenBytes, upload: tenBytes, notes: tenBytes])
    let streams = Flag()
    let store = HostFileStore(api: client(host), folder: scratch(), streamsMedia: { streams.on })
    _ = try #require(await store.local(video))
    streams.on = true
    _ = try #require(await store.local(video))
    _ = try #require(await store.local(upload))
    _ = try #require(await store.local(notes))
    #expect(await host.routes == ["/api/fs/file", "/api/fs/media", "/api/fs/media", "/api/fs/file"])
}

@Test func theMediaStreamCarriesThePathAndTheBearer() async throws {
    let request = await client(FileHost([:])).media("~/Videos/agent house.mp4")
    let url = try #require(request.url)
    #expect(url.path == "/api/fs/media")
    #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == [URLQueryItem(name: "path", value: "~/Videos/agent house.mp4")])
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer t")
    #expect(request.httpMethod == "GET")
}

@Test func mediaIsKnownByItsExtensionAndOnlyVideoAndSoundPlay() {
    #expect(MediaKind(path: "/home/u/Videos/Clip.MP4") == .video)
    #expect(MediaKind(path: "~/Videos/take.mov") == .video)
    #expect(MediaKind(path: "/home/u/Music/a.m4a") == .sound)
    #expect(MediaKind(path: "/home/u/Pictures/a.heic") == .picture)
    #expect(MediaKind(path: "/home/u/Videos/a.mp4")?.plays == true)
    #expect(MediaKind(path: "/home/u/Pictures/a.png")?.plays == false)
    // What AVPlayer can't play opens as any other file.
    for path in ["/a/b.webm", "/a/b.ogg", "/a/b.svg", "/a/b.txt", "/a/mp4", "/a/b.mp4.txt"] {
        #expect(MediaKind(path: path) == nil, "\(path)")
    }
}
