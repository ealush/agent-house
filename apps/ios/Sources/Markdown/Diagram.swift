import Foundation

/// A Mermaid diagram as Markdown carries one (a ```mermaid fence), and the page the app draws it
/// on: a hidden web page holding the bundled mermaid.min.js and nothing else (`MermaidRenderer`).
enum Diagram {
    /// Whether a fence's language names a Mermaid diagram.
    static func isMermaid(_ language: String?) -> Bool {
        language?.trimmingCharacters(in: .whitespaces).lowercased() == "mermaid"
    }

    /// What a diagram is drawn in: the card's ground behind it, and Mermaid's dark or light theme.
    struct Style: Hashable, Sendable {
        var dark: Bool
        /// `#rrggbb`.
        var background: String
    }

    /// A short name for a diagram, for VoiceOver: its kind, from its first line ("flowchart LR"
    /// is a flowchart).
    static func kind(_ source: String) -> String {
        let first = source.split(whereSeparator: \.isNewline).lazy
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("%%") && $0 != "---" } ?? ""
        let word = first.split(separator: " ").first.map(String.init) ?? ""
        switch word.lowercased() {
        case "flowchart", "graph": return "Flowchart"
        case "sequencediagram": return "Sequence diagram"
        case "classdiagram", "classdiagram-v2": return "Class diagram"
        case "statediagram", "statediagram-v2": return "State diagram"
        case "erdiagram": return "Entity relationship diagram"
        case "gantt": return "Gantt chart"
        case "pie": return "Pie chart"
        case "gitgraph": return "Git graph"
        case "mindmap": return "Mind map"
        case "timeline": return "Timeline"
        case "journey": return "User journey"
        default: return "Diagram"
        }
    }

    /// The page a diagram is drawn on, around `script` (mermaid.min.js). Nothing on it reaches
    /// the network or another file: its policy allows only its own inline script and styles, and
    /// pictures and fonts from `data:`. `draw(source, dark, background)` draws one diagram and
    /// answers its size in points, or throws Mermaid's own words when it can't read it.
    static func page(script: String) -> String {
        // A "</script>" inside it would end it early.
        let script = script.replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        return """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html,body{margin:0;padding:0;background:transparent}#box{display:inline-block;padding:\(Int(padding))px}#box svg{display:block}</style>
        </head><body><div id="box"></div>
        <script>\(script)</script>
        <script>
        let drawn = 0;
        window.draw = async (source, dark, background) => {
          document.body.style.background = background;
          mermaid.initialize({
            startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
            theme: dark ? 'dark' : 'default',
            fontFamily: '-apple-system, system-ui, sans-serif',
            themeVariables: { background, fontFamily: '-apple-system, system-ui, sans-serif' },
          });
          const box = document.getElementById('box');
          box.innerHTML = '';
          const id = 'diagram' + (++drawn);
          try {
            const { svg } = await mermaid.render(id, source);
            box.innerHTML = svg;
          } finally {
            document.getElementById('d' + id)?.remove();
          }
          const el = box.querySelector('svg');
          const view = el.viewBox && el.viewBox.baseVal;
          const width = view && view.width ? view.width : el.getBoundingClientRect().width;
          const height = view && view.height ? view.height : el.getBoundingClientRect().height;
          el.setAttribute('width', width);
          el.setAttribute('height', height);
          el.style.maxWidth = 'none';
          const rect = box.getBoundingClientRect();
          return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
        };
        </script>
        </body></html>
        """
    }

    /// Mermaid's words for why it couldn't draw one, without the error's name before them
    /// ("UnknownDiagramError: No diagram type detected…" says "No diagram type detected…").
    static func reason(_ message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespaces)
        guard let colon = trimmed.range(of: ": "), trimmed[..<colon.lowerBound].hasSuffix("Error"),
              trimmed[..<colon.lowerBound].allSatisfy({ $0.isLetter || $0.isNumber }) else { return trimmed }
        let rest = trimmed[colon.upperBound...].trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? trimmed : rest
    }

    /// Room around the diagram on its page, so its edges aren't cut by the picture taken of it.
    static let padding: Double = 12
}
