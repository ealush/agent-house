import Foundation

/// Generative UI (`docs/gui.md`): typed views of `ah-widget` objects. Missing or
/// wrong-typed fields fall back to empty values, never to invented ones. An unknown
/// type keeps its raw fields for a generic view.
enum WidgetModel: Equatable, Sendable {
    case card(title: String, body: String, tone: Tone, actions: [Reply])
    case choices(prompt: String, options: [Reply])
    case table(title: String, columns: [String], rows: [[String]])
    case checklist(title: String, items: [ChecklistItem])
    case stats(title: String, items: [Stat])
    case barChart(title: String, unit: String, data: [Bar])
    case progress(label: String, value: Double, max: Double)
    case links(title: String, items: [Link])
    case image(title: String, source: ImageSource, alt: String, caption: String)
    case code(title: String, code: String)
    case diff(title: String, lines: [DiffLine])
    case unknown(type: String, title: String, json: String)

    enum Tone: String, Sendable { case info, success, warning, danger }

    /// A button that answers the agent: `reply` is sent, `label` is shown.
    struct Reply: Equatable, Sendable, Hashable {
        let label: String
        let reply: String
        let description: String?
    }

    struct Stat: Equatable, Sendable, Hashable {
        let label: String
        let value: String
        let delta: String?
        let tone: Tone
    }

    struct Bar: Equatable, Sendable, Hashable {
        let label: String
        let value: Double
    }

    struct Link: Equatable, Sendable, Hashable {
        let label: String
        let target: LinkTarget
        let description: String?
    }

    /// Only http(s) on the web, or a path on the host read through ah's file API.
    enum LinkTarget: Equatable, Sendable, Hashable {
        case web(URL)
        case hostFile(String)
        case unsupported(String)
    }

    enum ImageSource: Equatable, Sendable {
        /// `data:image/…`: decoded bytes, never a network fetch.
        case inline(Data)
        /// An absolute or `~` path on the host, through the authenticated file API.
        case hostFile(String)
        /// An https picture elsewhere: fetched only once the person asks for it. An agent's
        /// URL can carry what it read to whoever serves it, so nothing loads it unasked.
        case remote(URL)
        case unavailable(String)
    }

    init(_ widget: Widget) {
        let w = widget
        func str(_ key: String) -> String {
            switch w[key] {
            case .string(let s)?: return s
            case .number(let n)?: return n.plainString
            default: return ""
            }
        }
        func arr(_ key: String) -> [JSONValue] { w[key]?.array ?? [] }
        func tone(_ v: JSONValue?) -> Tone { Tone(rawValue: v?.string ?? "") ?? .info }
        func cell(_ v: JSONValue?) -> String {
            switch v {
            case .string(let s)?: return s
            case .number(let n)?: return n.plainString
            default: return ""
            }
        }

        switch w.type {
        case "card":
            let actions = arr("actions").enumerated().map { i, a in
                let label = cell(a["label"]).isEmpty ? "Option \(i + 1)" : cell(a["label"])
                let reply = cell(a["reply"])
                return Reply(label: label, reply: reply.isEmpty ? label : reply, description: nil)
            }
            self = .card(title: str("title"), body: str("body"), tone: tone(w["tone"]), actions: actions)
        case "choices":
            let options = arr("options").enumerated().map { i, o -> Reply in
                if let s = o.string { return Reply(label: s.isEmpty ? "Option \(i + 1)" : s, reply: s.isEmpty ? "Option \(i + 1)" : s, description: nil) }
                let label = cell(o["label"]).isEmpty ? "Option \(i + 1)" : cell(o["label"])
                let reply = cell(o["reply"])
                let description = cell(o["description"])
                return Reply(label: label, reply: reply.isEmpty ? label : reply, description: description.isEmpty ? nil : description)
            }
            self = .choices(prompt: str("prompt").isEmpty ? str("title") : str("prompt"), options: options)
        case "table":
            let columns = arr("columns").map { cell($0) }
            let rows = arr("rows").map { row -> [String] in
                if let cells = row.array { return cells.map { cell($0) } }
                return columns.map { cell(row[$0]) }
            }
            self = .table(title: str("title"), columns: columns, rows: rows)
        case "checklist":
            let items = arr("items").map { it -> ChecklistItem in
                if let s = it.string { return ChecklistItem(text: s, state: .todo) }
                let done = it["done"]
                let status = it["status"]?.string
                let state: ChecklistItem.State = done?.bool == true || status == "done" ? .done
                    : done?.string == "in_progress" || status == "in_progress" ? .active : .todo
                return ChecklistItem(text: cell(it["text"]), state: state)
            }
            self = .checklist(title: str("title"), items: items)
        case "stats":
            self = .stats(title: str("title"), items: arr("items").map { s in
                Stat(label: cell(s["label"]), value: cell(s["value"]), delta: s["delta"].map { cell($0) }, tone: tone(s["tone"]))
            })
        case "bar-chart":
            let data = arr("data").compactMap { d -> Bar? in
                guard let value = d["value"]?.number, value.isFinite else { return nil }
                return Bar(label: cell(d["label"]), value: value)
            }
            self = .barChart(title: str("title"), unit: str("unit"), data: data)
        case "progress":
            let maximum = w["max"]?.number.flatMap { $0 > 0 ? $0 : nil } ?? 100
            let value = min(maximum, max(0, w["value"]?.number ?? 0))
            self = .progress(label: str("label").isEmpty ? str("title") : str("label"), value: value, max: maximum)
        case "links":
            self = .links(title: str("title"), items: arr("items").map { l in
                let url = cell(l["url"])
                let label = cell(l["label"]).isEmpty ? url : cell(l["label"])
                let description = cell(l["description"])
                return Link(label: label, target: WidgetModel.linkTarget(url), description: description.isEmpty ? nil : description)
            })
        case "image":
            self = .image(title: str("title"), source: WidgetModel.imageSource(str("src")), alt: str("alt"), caption: str("caption"))
        case "code":
            self = .code(title: str("title"), code: str("code"))
        case "diff":
            self = .diff(title: str("title").isEmpty ? str("path") : str("title"), lines: DiffParser.patchLines(str("patch")))
        default:
            let title = str("title")
            self = .unknown(type: w.type, title: title.isEmpty ? w.type : title, json: JSONValue.object(w.fields).json(pretty: true))
        }
    }

    static func linkTarget(_ raw: String) -> LinkTarget {
        if raw.hasPrefix("/") || raw.hasPrefix("~") { return .hostFile(raw) }
        if let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host != nil {
            return .web(url)
        }
        return .unsupported(raw)
    }

    static func imageSource(_ src: String) -> ImageSource {
        if src.hasPrefix("data:image/"), let comma = src.firstIndex(of: ","), src[..<comma].hasSuffix(";base64"),
           let data = Data(base64Encoded: String(src[src.index(after: comma)...]), options: .ignoreUnknownCharacters) {
            return .inline(data)
        }
        if src.hasPrefix("/") || src.hasPrefix("~") { return .hostFile(src) }
        if let url = URL(string: src), url.scheme?.lowercased() == "https", url.host?.isEmpty == false { return .remote(url) }
        return .unavailable(src)
    }

    /// Bar lengths as fractions of the largest value.
    static func barFractions(_ data: [Bar]) -> [Double] {
        let top = data.map(\.value).max().flatMap { $0 > 0 ? $0 : nil } ?? 1
        return data.map { max(0, $0.value / top) }
    }
}
