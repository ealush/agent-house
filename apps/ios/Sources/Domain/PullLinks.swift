import Foundation

/// A pull request on GitHub, as a link names it.
struct PullRef: Equatable, Hashable, Sendable {
    /// "owner/name", as written.
    let repo: String
    let number: Int

    /// What its chip says: the repository's name and the number, as GitHub writes one ("agent-house#223").
    var label: String { "\(repo.split(separator: "/").last.map(String.init) ?? repo)#\(number)" }
}

/// A link to a pull request in some text: where, the address as written, and what it names.
struct PullLink: Equatable, Sendable {
    /// In UTF-16, what a text view's ranges count.
    let range: NSRange
    let url: String
    let pull: PullRef
}

/// A link to a pull request on GitHub, in an answer or the box, is a chip that opens its review
/// here (`POST /api/review/pulls/open`, `features.reviewLinks`): the stack it's in, or one started
/// from its chain. Only for a repository the host works in (`GET /api/review/repos`); any other
/// stays a link to GitHub. Matches `apps/server/web/pullLinks.ts`.
enum PullLinks {
    /// A chip's link in rendered markdown: this, then the GitHub address it stands for.
    static let scheme = "ah-pull:"

    private static let body = "https?://(?:www\\.)?github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d{1,7})(?:[/?#][^\\s<>()\\[\\]]*)?"
    private static let anywhere = try! NSRegularExpression(pattern: body, options: [.caseInsensitive])
    private static let whole = try! NSRegularExpression(pattern: "^\(body)$", options: [.caseInsensitive])

    /// The pull request an address names: github.com/<owner>/<name>/pull/<n>, any page of it.
    static func pull(of url: String) -> PullRef? {
        let ns = url as NSString
        guard let m = whole.firstMatch(in: url, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ref(m, in: ns)
    }

    /// Every link to a pull request in a text, without the punctuation that ends a sentence.
    static func find(_ text: String) -> [PullLink] {
        let ns = text as NSString
        return anywhere.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            guard let pull = ref(m, in: ns) else { return nil }
            var url = ns.substring(with: m.range)
            while let last = url.last, ".,;:!?'\"".contains(last) { url.removeLast() }
            return PullLink(range: NSRange(location: m.range.location, length: (url as NSString).length), url: url, pull: pull)
        }
    }

    /// Whether a pull request is in one of `repos` (lowercased "owner/name").
    static func reviewable(_ pull: PullRef?, in repos: Set<String>) -> Bool {
        guard let pull else { return false }
        return repos.contains(pull.repo.lowercased())
    }

    /// A chip's link for the GitHub address it stands for.
    static func link(_ url: String) -> String { scheme + url }

    /// The GitHub address a chip's link stands for, and the pull request it names.
    static func target(fromLink link: String) -> (url: URL, pull: PullRef)? {
        guard link.hasPrefix(scheme) else { return nil }
        let rest = String(link.dropFirst(scheme.count))
        let raw = rest.removingPercentEncoding ?? rest
        guard let pull = pull(of: raw), let url = URL(string: raw) else { return nil }
        return (url, pull)
    }

    private static func ref(_ m: NSTextCheckingResult, in ns: NSString) -> PullRef? {
        guard let number = Int(ns.substring(with: m.range(at: 3))) else { return nil }
        return PullRef(repo: "\(ns.substring(with: m.range(at: 1)))/\(ns.substring(with: m.range(at: 2)))", number: number)
    }
}
