import Foundation

/// The line a list shows under a session's title, as a chat list shows a conversation's
/// last message: what it asks while it waits on you, its usage limit, else the last thing
/// said (the agent's reply, or your message it's working on). Not the last tool it ran:
/// "$ git push …" says little about where a conversation is.
enum SessionSnippet {
    static func line(_ dto: SessionDTO) -> String? {
        if dto.status == .waiting {
            let ask = AskParts.line(dto.ask)
            if !ask.isEmpty { return ask }
        }
        if dto.status != .busy, let limit = dto.limit, !limit.isEmpty { return limit }
        if let reply = dto.reply, !reply.text.isEmpty { return reply.isYours ? "You: \(reply.text)" : reply.text }
        // A host without last messages, or an agent without a transcript: what it's doing,
        // only while it's doing it.
        guard dto.status == .busy || dto.status == .waiting, let detail = dto.detail, !detail.isEmpty else { return nil }
        return detail
    }
}
