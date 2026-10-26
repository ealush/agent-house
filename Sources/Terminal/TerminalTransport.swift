import Foundation

/// Implement after native HTTP/WS authentication has a reviewed server contract.
/// Resolve stable host/uid to the current tmux address on each attachment.
protocol TerminalTransport: Actor {
    func connect(to session: SessionIdentity) async throws
    func send(_ message: TerminalInput) async throws
    func disconnect() async
}

/// Keep the terminal renderer replaceable while SwiftTerm is evaluated on iOS 26.
@MainActor
protocol TerminalRenderer: AnyObject {
    func receive(output: Data)
    func reset()
}

