import SwiftUI
import UIKit
import WebKit

/// A ```mermaid fence drawn as its diagram (`Diagram`), in a message or a Markdown page, with what
/// it says a tap away; one Mermaid can't read is its code, saying so.
struct DiagramView: View {
    let source: String
    @Environment(\.theme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.hostFiles) private var hostFiles
    @State private var drawn: MermaidRenderer.Drawn?
    @State private var showingSource = false

    private var style: Diagram.Style {
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        return Diagram.Style(dark: scheme == .dark, background: UIColor(theme.sunken).resolvedColor(with: traits).hex)
    }

    var body: some View {
        let style = style
        Group {
            switch MermaidRenderer.shared.remembered(source, style: style) ?? drawn {
            case .picture(let picture)? where !showingSource:
                VStack(alignment: .leading, spacing: 0) {
                    bar
                    Button { open(picture) } label: {
                        Image(uiImage: picture)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: picture.size.width)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Diagram.kind(source))
                    .accessibilityHint("Opens it full size")
                    .contextMenu {
                        Button("Show Source", systemImage: "chevron.left.forwardslash.chevron.right") { showingSource = true }
                        Button("Copy Source", systemImage: "doc.on.doc") { UIPasteboard.general.string = source }
                    }
                }
                .background(theme.sunken)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            case .picture?:
                VStack(alignment: .trailing, spacing: 4) {
                    CodeBlockView(code: source, language: "mermaid")
                    Button("Show Diagram", systemImage: "point.3.connected.trianglepath.dotted") { showingSource = false }
                        .font(.ah(.caption))
                        .buttonStyle(.borderless)
                        .tint(theme.muted)
                }
            case .failed(let why)?:
                VStack(alignment: .leading, spacing: 4) {
                    CodeBlockView(code: source, language: "mermaid")
                    Text("Couldn’t draw this diagram: \(why)")
                        .font(.ah(.caption))
                        .foregroundStyle(theme.faint)
                        .lineLimit(3)
                }
            case nil:
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 120)
                    .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("Drawing the diagram")
            }
        }
        .task(id: style) { drawn = await MermaidRenderer.shared.draw(source, style: style) }
    }

    /// The fence's name, and Show Source beside it, as a code block names its language.
    private var bar: some View {
        HStack {
            Text("mermaid").font(.ahMono(.caption2)).foregroundStyle(theme.faint)
            Spacer()
            Button {
                showingSource = true
            } label: {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.ah(.footnote).weight(.medium))
                    .foregroundStyle(theme.muted)
                    .frame(minWidth: 40, minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Show Source")
        }
        .padding(.leading, 12)
        .padding(.top, 2)
    }

    /// Full size in Quick Look, as a picture that came inline opens where it's shown (a row of
    /// the transcript can't present anything itself).
    private func open(_ picture: UIImage) {
        guard let open = hostFiles?.open, let data = picture.pngData() else { return }
        QuickLookOrigin.set(nil)
        Task { await open("data:image/png;base64,\(data.base64EncodedString())") }
    }
}

/// Draws Mermaid diagrams offline: the bundled mermaid.min.js on one hidden, non-persistent web
/// page (`Diagram.page`) that loads nothing else, a picture taken of each diagram. One at a time,
/// each remembered by what it says and how it's drawn while the app runs.
@MainActor
final class MermaidRenderer: NSObject, WKNavigationDelegate {
    static let shared = MermaidRenderer()

    enum Drawn: Equatable {
        case picture(UIImage)
        /// Mermaid's words for why it couldn't read it, or that there's nothing to draw it with.
        case failed(String)
    }

    private struct Key: Hashable {
        let source: String
        let style: Diagram.Style
    }

    /// Wider than this or taller, a diagram is drawn smaller: a picture is held in memory.
    private static let largest = CGSize(width: 2400, height: 4800)

    private var webView: WKWebView?
    private var loaded: CheckedContinuation<Void, Never>?
    private var page: Task<Bool, Never>?
    private var tail: Task<Void, Never>?
    private var drawnByKey: [Key: Drawn] = [:]
    private var order: [Key] = []

    /// One drawn already, at once (a row scrolled back into view draws it without a wait).
    func remembered(_ source: String, style: Diagram.Style) -> Drawn? { drawnByKey[Key(source: source, style: style)] }

    func draw(_ source: String, style: Diagram.Style) async -> Drawn {
        let key = Key(source: source, style: style)
        if let drawn = drawnByKey[key] { return drawn }
        let previous = tail
        let task = Task { () -> Drawn in
            await previous?.value
            if let drawn = drawnByKey[key] { return drawn }
            let drawn = await render(key)
            remember(drawn, for: key)
            return drawn
        }
        tail = Task { _ = await task.value }
        return await task.value
    }

    private func remember(_ drawn: Drawn, for key: Key) {
        drawnByKey[key] = drawn
        order.append(key)
        if order.count > 60 { drawnByKey[order.removeFirst()] = nil }
    }

    private func render(_ key: Key) async -> Drawn {
        guard await ready(), let webView else { return .failed("there's nothing here to draw it with") }
        do {
            // Laid out wide, so a broad diagram keeps its own size, then the page cut to it.
            webView.frame = CGRect(origin: .zero, size: Self.largest)
            let answer = try await webView.callAsyncJavaScript(
                "return await window.draw(source, dark, background)",
                arguments: ["source": key.source, "dark": key.style.dark, "background": key.style.background],
                contentWorld: .page)
            guard let size = answer as? [String: Any], let width = (size["width"] as? NSNumber)?.doubleValue, let height = (size["height"] as? NSNumber)?.doubleValue, width > 0, height > 0 else {
                return .failed("it drew nothing")
            }
            let natural = CGSize(width: width, height: height)
            let shown = CGSize(width: min(natural.width, Self.largest.width), height: min(natural.height, Self.largest.height))
            webView.frame = CGRect(origin: .zero, size: shown)
            // Two frames, so the page has laid out at its new size before the picture.
            _ = try await webView.callAsyncJavaScript("await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", contentWorld: .page)
            let snapshot = WKSnapshotConfiguration()
            snapshot.rect = CGRect(origin: .zero, size: shown)
            snapshot.afterScreenUpdates = true
            let picture = try await webView.takeSnapshot(configuration: snapshot)
            return .picture(picture)
        } catch {
            return .failed(Self.words(error))
        }
    }

    /// What Mermaid said, from the script's exception, without WebKit's wrapping.
    private static func words(_ error: any Error) -> String {
        let info = (error as NSError).userInfo
        let message = (info["WKJavaScriptExceptionMessage"] as? String) ?? error.localizedDescription
        let line = message.split(whereSeparator: \.isNewline).first.map(String.init) ?? message
        return Diagram.reason(line)
    }

    /// The page, made once: in the window behind everything (WebKit draws only a page that's in
    /// one), covered by the app and never touched.
    private func ready() async -> Bool {
        if let page { return await page.value }
        let task = Task { () -> Bool in
            guard let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js"),
                  let script = try? String(contentsOf: url, encoding: .utf8),
                  let window = Self.window() else { return false }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.suppressesIncrementalRendering = true
            let webView = WKWebView(frame: CGRect(origin: .zero, size: Self.largest), configuration: configuration)
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.isUserInteractionEnabled = false
            // In the window, the page would be pushed under its safe area and the picture cut.
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webView.accessibilityElementsHidden = true
            webView.navigationDelegate = self
            window.insertSubview(webView, at: 0)
            self.webView = webView
            await withCheckedContinuation { loaded = $0; webView.loadHTMLString(Diagram.page(script: script), baseURL: nil) }
            return true
        }
        page = task
        return await task.value
    }

    private static func window() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
    }

    // MARK: WKNavigationDelegate

    /// The page itself only: nothing on it navigates anywhere.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.absoluteString == "about:blank" ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded?.resume()
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        loaded?.resume()
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        loaded?.resume()
        loaded = nil
    }
}

private extension UIColor {
    /// `#rrggbb`, for a web page.
    var hex: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ v: CGFloat) -> Int { Int((max(0, min(1, v)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(r), byte(g), byte(b))
    }
}
