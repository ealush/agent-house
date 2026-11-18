import Foundation

/// Sending a note to an agent session as a message (`../ah/docs/spec/15-scratchpads.md`
/// SCR-6): through the host's own send (typed in when the agent is idle, queued while it
/// works, resumed first when it has ended), never into tmux. Each hand-off has an id kept on
/// this device before anything goes, so asking again (a lost answer, Try Again) is answered
/// by the host from what happened instead of sending twice. What's said afterwards is what
/// the host said: nothing is claimed offline, and a send whose fate is unknown says so.
@MainActor
enum NoteHandoff {
    /// Where it goes: a live session (`ref` its uid) or an ended one (`ref` its history ref,
    /// which the host resumes), on the host `host` (nil: the hub).
    struct Destination: Equatable, Sendable {
        let key: String
        let ref: String
        let title: String
        let host: String?
        let live: Bool
    }

    enum Outcome: Equatable, Sendable {
        case delivered(resumed: Bool)
        /// Waiting in the session's queue behind its turn (or until a just-started agent is up).
        case queued(resumed: Bool)
        /// The request went out and no answer came: it may or may not have arrived.
        case uncertain(String)
        case failed(String)
        /// Nothing was sent: the host can't be reached.
        case offline
        /// Past what a message carries: send it as a file instead.
        case tooLong

        var sentence: String {
            switch self {
            case .delivered(let resumed): return resumed ? "Resumed the session and sent the note." : "Sent the note."
            case .queued(let resumed): return resumed ? "Resumed the session; the note is queued for its next turn." : "Queued: the note goes in when this turn ends."
            case .uncertain(let why): return "Not sure it arrived (\(why)). Try Again asks the host what happened; it won’t send twice."
            case .failed(let why): return "Not sent: \(why)"
            case .offline: return "Not sent: your host can’t be reached. The note is kept here."
            case .tooLong: return "Too long for one message. Send it as a file instead."
            }
        }

        var arrived: Bool {
            switch self {
            case .delivered, .queued: return true
            default: return false
            }
        }
    }

    /// One message holds at most this (the host's limit for a send).
    static let maxText = 32 * 1024

    /// Sends note `id` to `to`. `retrying`: the hand-off to ask about again (same id, same
    /// text); `resend`: send an uncertain one again. `asFile`: the note goes as an uploaded
    /// Markdown file, the message naming it.
    static func send(_ id: String, to: Destination, notes: NotesModel, api: APIClient, hostKeepsNotes: Bool, reachable: Bool, asFile: Bool, retrying: NoteHandoffRecord? = nil, resend: Bool = false, origin: String) async -> (Outcome, NoteHandoffRecord?) {
        notes.flushText(id)
        guard let note = notes.note(id) else { return (.failed("the note is gone"), nil) }
        guard reachable else { return (.offline, retrying) }
        var record: NoteHandoffRecord
        if let retrying {
            record = retrying
        } else {
            let text: String
            if asFile {
                do {
                    let path = try await api.upload(name: NoteFiles.fileName(for: note), data: Data(note.markdown.utf8))
                    text = Uploads.shellQuote(path) + " " + note.shownTitle
                } catch {
                    // Nothing was sent: the message never left without its file.
                    let wrapped = APIError.wrap(error)
                    if case .transport = wrapped { return (.offline, nil) }
                    return (.failed("the note couldn’t be uploaded: \(wrapped.message)"), nil)
                }
            } else {
                text = note.markdown
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (.failed("the note is empty"), nil) }
                guard text.count <= maxText else { return (.tooLong, nil) }
            }
            record = NoteHandoffRecord(id: NoteKey.newID(), noteId: id, version: note.version, targetKey: to.key, origin: origin, state: .sending, sentText: text, detail: nil, createdAt: Date().timeIntervalSince1970)
            // Kept before it goes: a crash or a lost answer can be asked about by this id.
            try? notes.repository.saveHandoff(record)
        }
        let outcome: Outcome
        if hostKeepsNotes {
            outcome = await viaLedger(record, to: to, api: api, resend: resend)
        } else {
            outcome = await plainSend(record, to: to, api: api)
        }
        record.state = state(outcome)
        record.detail = outcome.sentence
        try? notes.repository.saveHandoff(record)
        return (outcome, record)
    }

    private static func viaLedger(_ record: NoteHandoffRecord, to: Destination, api: APIClient, resend: Bool) async -> Outcome {
        let body = NoteHandoffBody(id: record.id, noteId: record.noteId, revision: record.version, target: to.ref, text: record.sentText, resend: resend)
        do {
            switch try await api.handOff(body) {
            case .ok(let result):
                switch result.outcome {
                case .delivered: return .delivered(resumed: result.resumed)
                case .queued: return .queued(resumed: result.resumed)
                case .uncertain: return .uncertain("the host was interrupted while sending it")
                case .failed: return .failed(result.error ?? "the host couldn’t send it")
                }
            case .refused(let refusal):
                return refusal.code == "handoff_too_long" ? .tooLong : .failed(refusal.error)
            }
        } catch {
            return failure(error)
        }
    }

    /// A host older than notes: its ordinary send, which can't be asked about later.
    private static func plainSend(_ record: NoteHandoffRecord, to: Destination, api: APIClient) async -> Outcome {
        do {
            let result = try await api.send(to.ref, text: record.sentText)
            return result.outcome == .queued ? .queued(resumed: result.resumed) : .delivered(resumed: result.resumed)
        } catch {
            if case .transport(let why) = APIError.wrap(error) { return .uncertain("\(why); this host can’t say, so look in the session before sending again") }
            return .failed(APIError.wrap(error).message)
        }
    }

    private static func failure(_ error: any Error) -> Outcome {
        let wrapped = APIError.wrap(error)
        if case .transport(let why) = wrapped { return .uncertain(why) }
        return .failed(wrapped.message)
    }

    private static func state(_ outcome: Outcome) -> NoteHandoffRecord.State {
        switch outcome {
        case .delivered: return .delivered
        case .queued: return .queued
        case .uncertain: return .uncertain
        case .failed, .tooLong, .offline: return .failed
        }
    }
}
