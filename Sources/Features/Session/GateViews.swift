import SwiftUI
import UIKit

// A screen an agent draws in front of its own prompt (its folder-trust question, a sign-in,
// setup), off the terminal: its words with their links and its one-time code in place, a
// button to open its link, a box for what it asks to have typed, and Back where Esc goes
// back. A message sent meanwhile waits in the queue (`server/agentgate.ts`).

/// The screen's words, its links as links and its code where it stands.
struct GateTextView: View {
    let lines: [String]
    let gate: AskDTO.Gate
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                if let code = gate.code, line == code {
                    GateCodeView(code: code)
                } else {
                    Text(Self.linked(line, tint: theme.accent))
                        .font(.ah(.callout))
                        .foregroundStyle(theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// A line with each link as a tappable host and path, never its whole query.
    static func linked(_ line: String, tint: Color) -> AttributedString {
        var out = AttributedString()
        var rest = Substring(line)
        while let range = rest.range(of: #"https?://[^\s<>"'`]+"#, options: .regularExpression) {
            out += AttributedString(rest[..<range.lowerBound])
            let raw = String(rest[range]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:"))
            var link = AttributedString(shortLink(raw))
            link.link = URL(string: raw)
            link.foregroundColor = tint
            link.underlineStyle = .single
            out += link
            rest = rest[rest.index(range.lowerBound, offsetBy: raw.count)...]
        }
        out += AttributedString(rest)
        return out
    }

    /// "auth.openai.com/codex/device"; a long path or any query ends in "…".
    static func shortLink(_ url: String) -> String {
        guard let u = URLComponents(string: url), let host = u.host else { return url.count > 40 ? "\(url.prefix(40))…" : url }
        let shown = host + (u.path == "/" ? "" : u.path)
        return shown.count > 40 || u.query != nil ? "\(shown.prefix(40))…" : shown
    }
}

/// The code to type on another page: large enough to read off, and one tap to copy.
private struct GateCodeView: View {
    let code: String
    @Environment(\.theme) private var theme
    @State private var copied = false

    var body: some View {
        HStack(spacing: 10) {
            Text(code)
                .font(.ahMono(.title3).weight(.semibold))
                .tracking(1.5)
                .foregroundStyle(theme.text)
                .textSelection(.enabled)
                .accessibilityLabel("One-time code \(code.map(String.init).joined(separator: " "))")
            Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = code
                Haptics.selection()
                copied = true
            }
            .labelStyle(.titleAndIcon)
            .font(.ah(.footnote).weight(.medium))
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(theme.sunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.line, lineWidth: 0.5))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// The link to open, why it may not finish here, and the box for what the screen asks for.
struct GateActionsView: View {
    let target: AskTarget
    let gate: AskDTO.Gate
    @Environment(\.theme) private var theme

    var body: some View {
        // This device is never the agent's host: a page that hands back to 127.0.0.1 there
        // can't finish here, so it isn't the way to go.
        let away = gate.local == true
        VStack(alignment: .leading, spacing: 10) {
            if let first = gate.links?.first, let url = URL(string: first) {
                if away {
                    Link(destination: url) { Label(openTitle(first), systemImage: "safari") }
                        .buttonStyle(.bordered)
                } else {
                    Link(destination: url) { Label(openTitle(first), systemImage: "safari") }
                        .buttonStyle(.borderedProminent)
                        .tint(theme.accentStrong)
                }
            }
            if away {
                Text("That page hands back to a browser on \(target.row.host), so it can only finish there.\(gate.back == true ? " Go back for another way in, like a code to enter here." : "")")
                    .font(.ah(.footnote))
                    .foregroundStyle(theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let input = gate.input {
                GateInputView(target: target, prompt: input).id(input)
            }
        }
    }

    private func openTitle(_ link: String) -> String {
        gate.kind == "signin" ? "Open the sign-in page" : "Open \(GateTextView.shortLink(link))"
    }
}

/// A code pasted back, or an API key: typed into the screen by the host, never kept.
private struct GateInputView: View {
    let target: AskTarget
    let prompt: String
    @Environment(\.theme) private var theme
    @State private var text = ""
    @State private var sending = false
    @State private var sent = false

    var body: some View {
        // A key or a token is a secret: dots, and no autofill or suggestions.
        // "OPENROUTER_API_KEY (or Enter to cancel):" too.
        let secret = prompt.range(of: #"key|token|secret|password"#, options: [.regularExpression, .caseInsensitive]) != nil
        HStack(spacing: 8) {
            Group {
                if secret {
                    SecureField("Paste it here", text: $text)
                } else {
                    TextField("Type or paste it here", text: $text)
                }
            }
            .font(.ahMono(.body))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.send)
            .onSubmit(send)
            .accessibilityLabel(prompt)
            .accessibilityIdentifier("gateInput")
            .padding(.vertical, 9)
            .padding(.horizontal, 10)
            .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.line, lineWidth: 0.5))
            Button(sending ? "Sending…" : "Send", action: send)
                .accessibilityIdentifier("gateSend")
                .buttonStyle(.borderedProminent)
                .tint(theme.accentStrong)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || sending)
        }
        if sent { Text("Sent.").font(.ah(.footnote)).foregroundStyle(theme.muted) }
    }

    private func send() {
        let value = text.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, !sending else { return }
        sending = true
        Task {
            if await target.answerGate(value) {
                text = ""
                sent = true
            }
            sending = false
        }
    }
}

/// Esc, where the screen says it goes back.
struct GateBackButton: View {
    let target: AskTarget
    @State private var busy = false

    var body: some View {
        Button {
            busy = true
            Task {
                await target.gateBack()
                busy = false
            }
        } label: {
            Label("Back", systemImage: "chevron.backward")
        }
        .accessibilityIdentifier("gateBack")
        .accessibilityHint("Goes back a step on the agent’s screen")
        .disabled(busy)
    }
}
