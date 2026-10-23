import Foundation

/// Current wire contract from ../ah/server/terminal.ts. Authorization is separate.
enum TerminalInput: Encodable, Sendable {
    case input(String)
    case resize(columns: Int, rows: Int)
    case scroll(lines: Int, column: Int?, row: Int?)

    private enum CodingKeys: String, CodingKey { case t, d, c, r, n }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .input(let data):
            try container.encode("i", forKey: .t)
            try container.encode(data, forKey: .d)
        case .resize(let columns, let rows):
            try container.encode("r", forKey: .t)
            try container.encode(min(1000, max(2, columns)), forKey: .c)
            try container.encode(min(500, max(2, rows)), forKey: .r)
        case .scroll(let lines, let column, let row):
            try container.encode("s", forKey: .t)
            try container.encode(min(500, max(-500, lines)), forKey: .n)
            try container.encodeIfPresent(column.map { min(1000, max(1, $0)) }, forKey: .c)
            try container.encodeIfPresent(row.map { min(500, max(1, $0)) }, forKey: .r)
        }
    }
}

