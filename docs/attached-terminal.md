# Attached terminals

Each session can own one companion shell, separate from its agent's GUI and TUI.
Opening or hiding its panel never restarts either process. The shell starts in the
session's current working directory, inherits the configured launch environment,
and lives in tmux across browser, native client, and ah restarts. It has no registry
or history row. Explicitly terminating or forgetting the owner also stops its shell;
closing the panel only detaches the viewer. Servers it runs appear in the owner's Preview.

Hosts advertise `features.attachedTerminal: 1`. Authenticated routes, including
native bearer auth and `/h/:host` peer forwarding, use the existing protections:

- `GET /api/sessions/:uid/terminal` → `{ terminal: null | AttachedTerminal }`.
- `POST /api/sessions/:uid/terminal` with `{}` opens or reuses the shell.
- The same POST with `{ command: string }` pastes the command and presses Enter.
  A foreground program returns HTTP 409 with
  `code: "terminal_busy"`; commands are never queued or sent to an unrelated shell.
- `DELETE /api/sessions/:uid/terminal` stops the shell and its processes.
- `AttachedTerminal` is `{ id, cwd, command, busy }`; the same value is included as
  each live window's optional `terminal`. `busy` describes the foreground process,
  including a quiet server. Clients show attachment and activity separately from
  the agent's own status.

The existing authenticated `/ws/:id` terminal transport renders the shell. Clients
resolve the attachment again on reconnect so closing and recreating it cannot send
input to an old tmux window. Shell commands must be deliberately selected by the
person using a snippet button; rendering a snippet never executes it.
