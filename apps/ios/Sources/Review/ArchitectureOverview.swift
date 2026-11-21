import Foundation

/// How a layer changes the system, read from its own diff at the head it's pinned to: the
/// components it touches, its entry points and interfaces, the dependencies it adds or drops,
/// what one changed file now uses from another, where it reaches outside the program, and
/// which tests move with it. No model writes any of it: every claim names the lines it comes
/// from, and says whether the diff shows it outright or it's a reading of names and paths.
struct ArchitectureOverview: Equatable, Sendable {
    /// A line of the diff a claim stands on: where it is in the file's diff (to scroll to it),
    /// its number in the file, and whether it was added, removed or is unchanged context.
    struct Evidence: Hashable, Sendable {
        enum Side: String, Sendable { case added, removed, context }
        let path: String
        let index: Int
        let number: Int?
        let side: Side
        let text: String

        var label: String { "\((path as NSString).lastPathComponent):\(number.map(String.init) ?? "?")" }
    }

    enum Certainty: String, Sendable {
        /// The diff shows it: both ends of a use, a line that registers a route.
        case inDiff
        /// A reading of names and paths, worth checking (a test that may cover it, a name still used).
        case likely
    }

    struct Claim: Hashable, Sendable, Identifiable {
        enum Kind: String, Sendable { case entryPoint, interfaceAdded, interfaceRemoved, uses, staleUse, boundary, testsChanged, untested }
        let kind: Kind
        let text: String
        let certainty: Certainty
        let evidence: [Evidence]
        var id: String { "\(kind.rawValue):\(text)" }
    }

    struct Component: Hashable, Sendable, Identifiable {
        enum Role: String, Sendable { case source, tests, docs, config, migrations, assets }
        /// Its folder, as the repository names it ("src/routes").
        let id: String
        let role: Role
        let files: [String]
        let additions: Int
        let deletions: Int
    }

    struct Node: Hashable, Sendable, Identifiable {
        /// A changed file's path, or `module:<name>` for what one imports from outside the layer.
        let id: String
        let label: String
        let component: String
        /// A file this layer changes (else something it depends on).
        let changed: Bool
    }

    struct Edge: Hashable, Sendable {
        enum Change: String, Sendable { case added, removed, kept }
        let from: String
        let to: String
        let change: Change
        let evidence: [Evidence]
    }

    /// The head it was read at (the diff's `to`): it describes that revision and no other.
    let head: String?
    let components: [Component]
    let nodes: [Node]
    let edges: [Edge]
    let claims: [Claim]
    /// Files the diff doesn't carry line by line (binary, truncated): counted, not read.
    let unread: Int

    var isEmpty: Bool { components.isEmpty }

    func claims(_ kinds: Claim.Kind...) -> [Claim] { claims.filter { kinds.contains($0.kind) } }

    /// The graph before the layer (what it removes, and what it leaves) or after it.
    func graph(after: Bool) -> (nodes: [Node], edges: [Edge]) {
        let shown = edges.filter { after ? $0.change != .removed : $0.change != .added }
        let used = Set(shown.flatMap { [$0.from, $0.to] })
        return (nodes.filter { used.contains($0.id) || ($0.changed && (after || !Self.isNew($0.id, in: self))) }, shown)
    }

    private static func isNew(_ id: String, in overview: ArchitectureOverview) -> Bool { overview.newFiles.contains(id) }
    /// Files the layer adds (every line added).
    var newFiles: Set<String> = []

    // MARK: Reading a diff

    static let maxNodes = 40
    static let maxEvidence = 6

    static func read(_ files: [FileDiff], head: String?) -> ArchitectureOverview {
        var components: [String: (role: Component.Role, files: [String], add: Int, del: Int)] = [:]
        var nodes: [String: Node] = [:]
        var edges: [String: (from: String, to: String, added: [Evidence], removed: [Evidence], kept: [Evidence])] = [:]
        var claims: [Claim] = []
        var newFiles = Set<String>()
        var unread = 0
        let byModule = Dictionary(files.map { (stem($0.path), $0.path) }, uniquingKeysWith: { a, _ in a })
        var defined: [String: (path: String, evidence: Evidence)] = [:]
        var dropped: [String: (path: String, evidence: Evidence)] = [:]
        var boundaries: [String: [Evidence]] = [:]

        for file in files {
            let body = file.lines.filter { $0.kind == .add || $0.kind == .del || $0.kind == .ctx }
            if body.isEmpty { unread += 1 }
            if !body.isEmpty, body.allSatisfy({ $0.kind == .add }) { newFiles.insert(file.path) }
            let folder = Self.folder(file.path)
            let role = Self.role(file.path)
            var c = components[folder] ?? (role, [], 0, 0)
            c.files.append(file.path)
            c.add += file.additions
            c.del += file.deletions
            components[folder] = c
            nodes[file.path] = Node(id: file.path, label: (file.path as NSString).lastPathComponent, component: folder, changed: true)

            for (index, line) in file.lines.enumerated() where line.kind == .add || line.kind == .del || line.kind == .ctx {
                let side: Evidence.Side = line.kind == .add ? .added : line.kind == .del ? .removed : .context
                let evidence = Evidence(path: file.path, index: index, number: line.number, side: side, text: line.text.trimmingCharacters(in: .whitespaces))
                if let spec = importSpec(line.text, path: file.path) {
                    let target = resolve(spec, from: file.path, modules: byModule)
                    if nodes[target.id] == nil { nodes[target.id] = target }
                    let key = "\(file.path)→\(target.id)"
                    var e = edges[key] ?? (file.path, target.id, [], [], [])
                    switch side {
                    case .added: e.added.append(evidence)
                    case .removed: e.removed.append(evidence)
                    case .context: e.kept.append(evidence)
                    }
                    edges[key] = e
                }
                guard side != .context else { continue }
                if let name = definition(line.text, path: file.path) {
                    if side == .added { defined[name] = (file.path, evidence) } else { dropped[name] = (file.path, evidence) }
                }
                if side == .added, let route = entryPoint(line.text) {
                    claims.append(Claim(kind: .entryPoint, text: route, certainty: .inDiff, evidence: [evidence]))
                }
                if side == .added, let reach = boundary(line.text) { boundaries[reach, default: []].append(evidence) }
            }
        }

        // An interface both added and removed in the same layer moved or changed shape.
        for (name, def) in defined.sorted(by: { $0.key < $1.key }) where dropped[name]?.path != def.path {
            claims.append(Claim(kind: .interfaceAdded, text: "\(name) is new in \((def.path as NSString).lastPathComponent)", certainty: .inDiff, evidence: [def.evidence]))
        }
        for (name, gone) in dropped.sorted(by: { $0.key < $1.key }) where defined[name] == nil {
            claims.append(Claim(kind: .interfaceRemoved, text: "\(name) is gone from \((gone.path as NSString).lastPathComponent)", certainty: .inDiff, evidence: [gone.evidence]))
        }
        // Across files: a changed file's new lines using a name another changed file defines now.
        for (name, def) in defined.sorted(by: { $0.key < $1.key }) {
            for file in files where file.path != def.path {
                let uses = file.lines.enumerated().filter { $0.element.kind == .add && mentions($0.element.text, name) }
                guard let first = uses.first else { continue }
                let evidence = uses.prefix(maxEvidence - 1).map { Evidence(path: file.path, index: $0.offset, number: $0.element.number, side: .added, text: $0.element.text.trimmingCharacters(in: .whitespaces)) }
                _ = first
                claims.append(Claim(kind: .uses, text: "\((file.path as NSString).lastPathComponent) uses \(name) from \((def.path as NSString).lastPathComponent)", certainty: .inDiff, evidence: [def.evidence] + evidence))
            }
        }
        // A removed name still mentioned elsewhere in what the diff shows: likely left behind.
        for (name, gone) in dropped.sorted(by: { $0.key < $1.key }) where defined[name] == nil {
            for file in files where file.path != gone.path {
                let still = file.lines.enumerated().filter { ($0.element.kind == .add || $0.element.kind == .ctx) && mentions($0.element.text, name) }
                guard !still.isEmpty else { continue }
                let evidence = still.prefix(maxEvidence - 1).map { Evidence(path: file.path, index: $0.offset, number: $0.element.number, side: $0.element.kind == .add ? .added : .context, text: $0.element.text.trimmingCharacters(in: .whitespaces)) }
                claims.append(Claim(kind: .staleUse, text: "\((file.path as NSString).lastPathComponent) still mentions \(name), which \((gone.path as NSString).lastPathComponent) no longer has", certainty: .likely, evidence: [gone.evidence] + evidence))
            }
        }
        for (reach, evidence) in boundaries.sorted(by: { $0.key < $1.key }) {
            claims.append(Claim(kind: .boundary, text: "\(reach) (\(evidence.count) new line\(evidence.count == 1 ? "" : "s"))", certainty: .likely, evidence: Array(evidence.prefix(maxEvidence))))
        }
        // Tests: the ones that change, and changed source with no test of its own name in the layer.
        let tests = files.filter { role($0.path) == .tests }
        for test in tests {
            let first = test.lines.firstIndex { $0.kind == .add || $0.kind == .del }
            let evidence = first.map { [Evidence(path: test.path, index: $0, number: test.lines[$0].number, side: test.lines[$0].kind == .add ? .added : .removed, text: test.lines[$0].text.trimmingCharacters(in: .whitespaces))] } ?? []
            claims.append(Claim(kind: .testsChanged, text: "\((test.path as NSString).lastPathComponent): \(test.additions) added, \(test.deletions) removed", certainty: .inDiff, evidence: evidence))
        }
        let testNames = Set(tests.map { baseName($0.path) })
        for file in files where role(file.path) == .source && file.additions + file.deletions > 0 {
            guard !testNames.contains(baseName(file.path)) else { continue }
            let first = file.lines.firstIndex { $0.kind == .add || $0.kind == .del }
            let evidence = first.map { [Evidence(path: file.path, index: $0, number: file.lines[$0].number, side: file.lines[$0].kind == .add ? .added : .removed, text: file.lines[$0].text.trimmingCharacters(in: .whitespaces))] } ?? []
            claims.append(Claim(kind: .untested, text: "No test named for \((file.path as NSString).lastPathComponent) changes in this layer", certainty: .likely, evidence: evidence))
        }

        let builtEdges = edges.values.map { e -> Edge in
            let change: Edge.Change = !e.kept.isEmpty || (!e.added.isEmpty && !e.removed.isEmpty) ? .kept : !e.added.isEmpty ? .added : .removed
            return Edge(from: e.from, to: e.to, change: change, evidence: Array((e.added + e.removed + e.kept).prefix(maxEvidence)))
        }
        .sorted { ($0.from, $0.to) < ($1.from, $1.to) }
        // A big layer keeps the graph to the files it changes and what most of them use.
        var keptNodes = nodes.values.sorted { ($0.changed ? 0 : 1, $0.id) < ($1.changed ? 0 : 1, $1.id) }
        if keptNodes.count > maxNodes { keptNodes = Array(keptNodes.prefix(maxNodes)) }
        let keptIDs = Set(keptNodes.map(\.id))
        var overview = ArchitectureOverview(
            head: head,
            components: components.map { Component(id: $0.key, role: $0.value.role, files: $0.value.files, additions: $0.value.add, deletions: $0.value.del) }.sorted { ($0.additions + $0.deletions, $1.id) > ($1.additions + $1.deletions, $0.id) },
            nodes: keptNodes,
            edges: builtEdges.filter { keptIDs.contains($0.from) && keptIDs.contains($0.to) },
            claims: claims,
            unread: unread)
        overview.newFiles = newFiles
        return overview
    }

    // MARK: Reading lines

    /// What an import line brings in: a module name, or a relative path.
    static func importSpec(_ text: String, path: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespaces)
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts":
            if let m = firstGroup(t, #"^(?:import|export)\b.*?\bfrom\s+['"]([^'"]+)['"]"#) ?? firstGroup(t, #"^import\s+['"]([^'"]+)['"]"#) ?? firstGroup(t, #"\brequire\(\s*['"]([^'"]+)['"]\s*\)"#) { return m }
        case "swift":
            return firstGroup(t, #"^(?:@testable\s+)?import\s+(?:(?:struct|class|enum|protocol|func|typealias)\s+)?([A-Za-z_][\w.]*)"#)
        case "py":
            return firstGroup(t, #"^from\s+([\w.]+)\s+import\b"#) ?? firstGroup(t, #"^import\s+([\w.]+)"#)
        case "go":
            return firstGroup(t, #"^import\s+"([^"]+)""#) ?? firstGroup(t, #"^(?:\w+\s+)?"([\w./-]+/[\w./-]+)"$"#)
        case "rs":
            return firstGroup(t, #"^(?:pub\s+)?use\s+([\w:]+)"#)
        default:
            return nil
        }
        return nil
    }

    /// A relative import as the changed file it names, else the module itself.
    static func resolve(_ spec: String, from path: String, modules: [String: String]) -> Node {
        if spec.hasPrefix(".") {
            let dir = (path as NSString).deletingLastPathComponent
            let joined = normalize((dir as NSString).appendingPathComponent(spec))
            let stemmed = stem(joined)
            if let changed = modules[stemmed] ?? modules[stemmed + "/index"] {
                return Node(id: changed, label: (changed as NSString).lastPathComponent, component: folder(changed), changed: true)
            }
            return Node(id: "module:\(stemmed)", label: (stemmed as NSString).lastPathComponent, component: folder(stemmed), changed: false)
        }
        return Node(id: "module:\(spec)", label: spec, component: "dependencies", changed: false)
    }

    /// The name a line defines at the top level, as other files would use it.
    static func definition(_ text: String, path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts":
            return firstGroup(text, #"^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|type|interface|enum)\s+([A-Za-z_$][\w$]*)"#)
        case "swift":
            // Top level (no indentation): what the module's other files see.
            return firstGroup(text, #"^(?:@\w+\s+)*(?:public\s+|open\s+|internal\s+|package\s+)?(?:final\s+)?(?:func|struct|class|enum|protocol|actor|typealias)\s+([A-Za-z_]\w*)"#)
        case "py":
            return firstGroup(text, #"^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)"#)
        case "go":
            return firstGroup(text, #"^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)"#) ?? firstGroup(text, #"^type\s+([A-Z]\w*)"#)
        case "rs":
            return firstGroup(text, #"^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)"#)
        default:
            return nil
        }
    }

    /// A line that adds a way in: a route, a command, a program's start.
    static func entryPoint(_ text: String) -> String? {
        // `<router>.post('/path', …)`: a path that starts with "/" (not `map.get('key')`).
        if let m = groups(text, #"\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|all)\(\s*['"`](/[^'"`]*)"#) { return "Route \(m[0].uppercased()) \(m[1])" }
        // ah's own `route('POST', /^\/api\/…$/)`.
        if let m = groups(text, #"\broute\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*/\^?(.+?)\$?/\s*\)"#) { return "Route \(m[0]) \(m[1].replacingOccurrences(of: "\\/", with: "/"))" }
        if let m = groups(text, #"@(Get|Post|Put|Patch|Delete)\(\s*['"]?([^'")]*)"#) { return "Route \(m[0].uppercased()) \(m[1])" }
        if let m = groups(text, #"\.command\(\s*['"]([\w:-]+)"#) { return "Command \(m[0])" }
        if text.range(of: #"^\s*(?:public\s+)?(?:static\s+)?func\s+main\s*\("#, options: .regularExpression) != nil || text.range(of: #"^\s*if\s+__name__\s*==\s*['"]__main__['"]"#, options: .regularExpression) != nil || text.range(of: #"^\s*@main\b"#, options: .regularExpression) != nil {
            return "Program entry"
        }
        return nil
    }

    /// Where a new line reaches outside the program.
    static func boundary(_ text: String) -> String? {
        let rules: [(String, String)] = [
            ("Reaches the network", #"\b(?:fetch|axios|URLSession|XMLHttpRequest|http\.request|https\.request|requests\.(?:get|post)|WebSocket)\b"#),
            ("Reaches a database", #"\b(?:prisma\.\w+\.|db\.(?:query|run|exec|prepare|get|all)|SELECT\s|INSERT\s|UPDATE\s+\w+\s+SET|DELETE\s+FROM|\.execute\(|GRDB|sqlite)"#),
            ("Reaches the file system", #"\b(?:readFile|writeFile|readFileSync|writeFileSync|createWriteStream|FileManager\.default|open\(|rmSync|unlink)\b"#),
            ("Starts other processes", #"\b(?:execFile|execFileSync|spawn|exec\(|Process\(\)|subprocess\.)"#),
        ]
        return rules.first { text.range(of: $0.1, options: .regularExpression) != nil }?.0
    }

    // MARK: Paths

    static func folder(_ path: String) -> String {
        let dir = (path as NSString).deletingLastPathComponent
        let parts = dir.split(separator: "/").map(String.init)
        return parts.isEmpty ? "(root)" : parts.prefix(2).joined(separator: "/")
    }

    static func role(_ path: String) -> Component.Role {
        let p = path.lowercased()
        let name = (p as NSString).lastPathComponent
        if p.contains("/test/") || p.contains("/tests/") || p.hasPrefix("test/") || p.hasPrefix("tests/") || p.contains("__tests__") || name.contains(".test.") || name.contains(".spec.") || name.hasSuffix("tests.swift") || name.hasSuffix("_test.go") || name.hasPrefix("test_") { return .tests }
        if p.contains("migration") || p.hasSuffix(".sql") || name == "schema.prisma" { return .migrations }
        if name.hasSuffix(".md") || p.hasPrefix("docs/") { return .docs }
        if ["json", "yml", "yaml", "toml", "plist", "xcconfig", "lock", "ini", "env"].contains((name as NSString).pathExtension) || name.hasPrefix(".") || name == "package.json" || name == "dockerfile" { return .config }
        if ["png", "jpg", "jpeg", "svg", "gif", "webp", "ico", "pdf", "woff", "woff2", "ttf"].contains((name as NSString).pathExtension) { return .assets }
        return .source
    }

    /// A path without its extension (and a test's `.test`/`.spec`), for matching imports and tests.
    static func stem(_ path: String) -> String {
        var p = (path as NSString).deletingPathExtension
        for suffix in [".test", ".spec", ".d"] where p.hasSuffix(suffix) { p = String(p.dropLast(suffix.count)) }
        return p
    }

    /// A file's name without extension or test markers: users.ts, users.test.ts, UsersTests.swift → users.
    static func baseName(_ path: String) -> String {
        var name = (stem(path) as NSString).lastPathComponent.lowercased()
        for suffix in ["tests", "test", "_test", "spec"] where name.hasSuffix(suffix) && name.count > suffix.count { name = String(name.dropLast(suffix.count)) }
        if name.hasPrefix("test_") { name = String(name.dropFirst(5)) }
        return name.trimmingCharacters(in: CharacterSet(charactersIn: "_-."))
    }

    static func normalize(_ path: String) -> String {
        var out: [Substring] = []
        for part in path.split(separator: "/") {
            if part == "." { continue }
            if part == "..", !out.isEmpty { out.removeLast(); continue }
            out.append(part)
        }
        return out.joined(separator: "/")
    }

    // MARK: Matching

    static func mentions(_ text: String, _ name: String) -> Bool {
        guard name.count >= 3 else { return false }
        return text.range(of: #"(?<![\w$])"# + NSRegularExpression.escapedPattern(for: name) + #"(?![\w$])"#, options: .regularExpression) != nil
    }

    private static func firstGroup(_ text: String, _ pattern: String) -> String? { groups(text, pattern)?.first }

    private static func groups(_ text: String, _ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern), let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<match.numberOfRanges).compactMap { Range(match.range(at: $0), in: text).map { String(text[$0]) } }
    }
}

/// Where each node of a dependency graph sits: columns from what nothing here depends on (the
/// entry side) to what everything depends on, rows in each column in a stable order.
enum DiagramLayout {
    struct Spot: Hashable, Sendable { let column: Int; let row: Int }

    static func layout(nodes: [String], edges: [(from: String, to: String)]) -> [String: Spot] {
        var depth: [String: Int] = [:]
        let outgoing = Dictionary(grouping: edges, by: \.from).mapValues { $0.map(\.to) }
        // Longest path from the importing side, cycles cut at a node already on the path.
        func visit(_ node: String, _ d: Int, _ path: Set<String>) {
            guard !path.contains(node), d > (depth[node] ?? -1) else { return }
            depth[node] = d
            for next in outgoing[node] ?? [] { visit(next, d + 1, path.union([node])) }
        }
        let imported = Set(edges.map(\.to))
        for root in nodes where !imported.contains(root) { visit(root, 0, []) }
        for node in nodes where depth[node] == nil { visit(node, 0, []) }
        var spots: [String: Spot] = [:]
        let columns = Dictionary(grouping: nodes, by: { depth[$0] ?? 0 })
        for (column, members) in columns {
            for (row, node) in members.sorted().enumerated() { spots[node] = Spot(column: column, row: row) }
        }
        return spots
    }
}
