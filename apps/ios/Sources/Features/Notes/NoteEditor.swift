import SwiftUI
import UIKit

/// A note's Markdown in a plain UIKit text view: selection, undo, the edit menu, a hardware
/// keyboard and long text as iOS does them. Its text is the note's box (`NoteDocument.box`),
/// so typing and dictation write to the same place; a change made elsewhere (dictation's
/// words, the host's version taken) goes in as the smallest replacement, keeping the caret,
/// the scroll and the undo history. Return carries a list on: "- ", "- [ ] ", "1. ", "> ".
struct NoteEditor: UIViewRepresentable {
    let scene: SceneModel
    let key: String
    let doc: NoteDocument
    @Environment(\.theme) private var theme

    func makeUIView(context: Context) -> NoteTextView {
        let view = NoteTextView(frame: .zero, textContainer: nil)
        view.delegate = context.coordinator
        view.font = AhType.uiFont(.body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 14, left: 14, bottom: 24, right: 14)
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        // Markdown is text that machines read too: straight quotes and dashes, as typed.
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.autocapitalizationType = .sentences
        view.dataDetectorTypes = []
        view.accessibilityIdentifier = "note-editor"
        view.accessibilityLabel = "Note"
        view.text = doc.box.text
        view.placeholder = "Write, or hold the microphone to dictate. Markdown: # headings, - lists, - [ ] tasks, ``` code."
        context.coordinator.restore(view)
        return view
    }

    func updateUIView(_ view: NoteTextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if context.coordinator.theme != theme {
            coordinator.theme = theme
            view.textColor = UIColor(theme.text)
            view.tintColor = UIColor(theme.accent)
        }
        let wanted = doc.box.text
        if view.text != wanted { coordinator.apply(wanted, to: view) }
        if let request = scene.focusRequest, request.nonce != coordinator.handledFocus, request.target == .composer(key) {
            coordinator.handledFocus = request.nonce
            view.becomeFirstResponder()
            DispatchQueue.main.async { if !view.isFirstResponder { view.becomeFirstResponder() } }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NoteEditor
        var theme: Theme?
        var handledFocus = 0
        /// A change being put in from the box (not typed): not written back.
        private var applying = false
        private var remembering: Task<Void, Never>?

        init(parent: NoteEditor) { self.parent = parent }

        private var notes: NotesModel { parent.scene.notes }

        /// Where the note was left: the selection, and how far down.
        func restore(_ view: NoteTextView) {
            guard let note = notes.note(parent.doc.id) else { return }
            let length = (view.text as NSString).length
            let start = min(max(0, note.selectionStart), length)
            view.selectedRange = NSRange(location: start, length: min(max(0, note.selectionLength), length - start))
            let offset = note.scrollOffset
            if offset > 0 {
                DispatchQueue.main.async {
                    view.layoutIfNeeded()
                    let top = -view.adjustedContentInset.top
                    let bottom = max(top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
                    view.setContentOffset(CGPoint(x: 0, y: min(max(top, offset), bottom)), animated: false)
                }
            }
            parent.doc.box.caret = start
        }

        /// The box's text into the view as the one span that differs.
        func apply(_ wanted: String, to view: NoteTextView) {
            let old = view.text as NSString, new = wanted as NSString
            var head = 0
            let shorter = min(old.length, new.length)
            while head < shorter, old.character(at: head) == new.character(at: head) { head += 1 }
            var tail = 0
            while tail < shorter - head, old.character(at: old.length - 1 - tail) == new.character(at: new.length - 1 - tail) { tail += 1 }
            let replaced = NSRange(location: head, length: old.length - head - tail)
            let inserted = new.substring(with: NSRange(location: head, length: new.length - head - tail))
            applying = true
            defer { applying = false }
            if let start = view.position(from: view.beginningOfDocument, offset: replaced.location),
               let end = view.position(from: start, offset: replaced.length),
               let range = view.textRange(from: start, to: end) {
                let selection = view.selectedRange
                view.replace(range, withText: inserted)
                // Where the box asks (dictation's words end there), else the caret kept in step.
                if let place = parent.doc.box.placeCaret {
                    parent.doc.box.placeCaret = nil
                    view.selectedRange = NSRange(location: min(max(0, place), new.length), length: 0)
                } else if selection.location >= replaced.location + replaced.length {
                    view.selectedRange = NSRange(location: selection.location - replaced.length + (inserted as NSString).length, length: selection.length)
                } else {
                    view.selectedRange = selection
                }
            } else {
                view.text = wanted
            }
            view.refreshPlaceholder()
        }

        func textViewDidChange(_ textView: UITextView) {
            (textView as? NoteTextView)?.refreshPlaceholder()
            guard !applying else { return }
            parent.doc.box.text = textView.text
            parent.doc.box.caret = textView.selectedRange.location
            parent.scene.fieldState = fieldState(textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !applying else { return }
            parent.scene.fieldState = fieldState(textView)
            // Mid-keystroke the caret moves before the text arrives: the text's change sets it.
            if textView.text == parent.doc.box.text { parent.doc.box.caret = textView.selectedRange.location }
            remember(textView)
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard let view = scrollView as? UITextView else { return }
            remember(view)
        }

        private func remember(_ view: UITextView) {
            remembering?.cancel()
            let id = parent.doc.id
            remembering = Task { [weak self, weak view] in
                try? await Task.sleep(for: .milliseconds(600))
                guard !Task.isCancelled, let self, let view else { return }
                self.notes.remember(id, selection: view.selectedRange, scroll: view.contentOffset.y + view.adjustedContentInset.top)
            }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.scene.keyScope = .field
            parent.scene.fieldState = fieldState(textView)
            parent.scene.didFocus(.composer(parent.key))
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.scene.keyScope = .app
            parent.scene.didBlur(.composer(parent.key))
            notes.flushText(parent.doc.id)
        }

        /// Return in a list item starts the next item; on an empty item it ends the list.
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard text == "\n", range.length == 0, let next = NoteLists.continuation(of: textView.text, at: range.location) else { return true }
            guard let start = textView.position(from: textView.beginningOfDocument, offset: next.replace.location),
                  let end = textView.position(from: start, offset: next.replace.length),
                  let span = textView.textRange(from: start, to: end) else { return true }
            textView.replace(span, withText: next.with)
            return false
        }

        private func fieldState(_ textView: UITextView) -> FieldState {
            let r = textView.selectedRange
            return FieldState(text: textView.text, selection: r.location..<(r.location + r.length))
        }
    }
}

/// The note's text view: a placeholder while it's empty.
final class NoteTextView: UITextView {
    private let placeholderLabel = UILabel()
    var placeholder = "" { didSet { placeholderLabel.text = placeholder } }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        setUp()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func setUp() {
        placeholderLabel.font = AhType.uiFont(.body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.numberOfLines = 0
        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)
    }

    func refreshPlaceholder() { placeholderLabel.isHidden = !text.isEmpty }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset = textContainerInset, pad = textContainer.lineFragmentPadding
        let width = bounds.width - inset.left - inset.right - pad * 2
        let size = placeholderLabel.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        placeholderLabel.frame = CGRect(x: inset.left + pad, y: inset.top, width: width, height: size.height)
        refreshPlaceholder()
    }
}
