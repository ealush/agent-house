# Attached terminal

A session owns one companion shell on its host, independent of its agent terminal.
The session menu and row context menu open Terminal; iPad shows a side panel and
iPhone a panel sheet. Closing either leaves the shell running. Shell code blocks
and selected transcript text offer Send to terminal, which pastes and runs through
that same attachment. A foreground server or editor returns the host's busy error;
the app never picks another session's shell. The terminal glyph in session rows
turns red while its foreground process is active.

The host advertises `features.attachedTerminal: 1`; older hosts don't offer these
controls. `SessionDTO.terminal` and the typed GET/POST/DELETE
`/api/sessions/:uid/terminal` calls share the backend/web contract. The existing
native bearer, peer routing and real SwiftTerm/WebSocket transport are used.
Each reconnect resolves the attachment again. Lookup failures retry without
replaying input. Agent and companion terminal have separate keyboard focus targets,
both tied to the owner uid. The Terminal panel is part of the scene snapshot.

The shell survives ah restarts and viewer disconnects. Explicitly stopping the
terminal, terminating the owner, or forgetting it ends the shell and its processes.
A server started there appears in the owner's Preview port list.

## Verification — 15 November 2026

- Swift 6.2 on Linux: core suite passes; tests cover the DTO, authenticated peer
  requests, distinct focus and panel encoding, retry after failed attachment lookup.
- Three real-host integration tests pass using the project's `it-host.mjs` fixture:
  native enrollment/bearer → owner → attached shell → command → SwiftTerm output;
  scene snippet → owner's panel and focus → hide/reopen → terminate cleanup;
  regression coverage for the agent terminal's existing input/rendering.
- All modified UIKit/SwiftUI files pass Swift parser checks. New Apple UI code has
  not been typechecked in Xcode or walked on a simulator/device in this environment.
- The repository's `integration.sh` launcher stops before tests at its pre-existing
  API coverage check: 12 routes for usage, interruptions, recovery and capabilities
  lack native paths. The three new terminal routes have native paths. Targeted
  integration tests were run directly with the same disposable host fixture.

The native feature is on the local `feat/session-terminal` stack branch. Its host
requires the backend `feat/session-terminal-api` branch (or a descendant).
