import Foundation

/// How long ago, in the fewest characters a list's row can spare: "now", "3m", "2h", "5d",
/// "6w", "2y". A time ahead of the clock (the host's a little fast) is "now".
enum ElapsedWords {
    static func short(since seconds: Double, now: Double) -> String {
        let delta = now - seconds
        guard delta >= 60 else { return "now" }
        let minutes = Int(delta / 60)
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        if days < 7 { return "\(days)d" }
        if days < 365 { return "\(days / 7)w" }
        return "\(days / 365)y"
    }
}
