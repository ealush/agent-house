import Foundation

/// The question form a waiting session shows, kept with the session rather than in the view:
/// the transcript draws the form as one of its rows, and a row can be drawn again (scrolled
/// away and back, or remade when a typed answer grows it). What's been picked and typed so far
/// stays. Only the current form is kept; a new question starts afresh.
@MainActor
final class AskFormStore {
    private var kept: (id: String, model: AnyObject)?

    func model<Model: AnyObject>(_ id: String, make: () -> Model) -> Model {
        if let kept, kept.id == id, let model = kept.model as? Model { return model }
        let model = make()
        kept = (id, model)
        return model
    }
}
