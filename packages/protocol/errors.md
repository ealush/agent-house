# Errors

Every refusal is JSON: `{ "error": "<for people>", "code": "<for programs>" }`, with
the HTTP status that fits. Branch on `code`, never on the wording, which may change.
`code` is absent where no client needs to tell the case apart; an unexpected failure is
`500 { "error": "internal error" }` and nothing more (details stay in the host's log).

A field longer than its route takes is `400 too_long`, its message saying by how much. A
message for an agent (a send, its draft, a fork's prompt) takes up to 131,072 characters
(`MESSAGE_MAX`, `server/http.ts`).

Each context documents its own codes beside its routes (portable, migrations, jobs,
recovery, interruptions, usage, notes, uploads, voice, spaces in `13-conductor.md`,
`14-voice.md`, `15-scratchpads.md`, `17-spaces.md`). The sessions' codes (`server/core.ts`):

| Code | Status | Means | A client should |
|---|---|---|---|
| `session_not_found` | 404 | No session by that uid or ref. | Drop it from view. |
| `not_running` | 404 | The session exists but has no window now. | Offer Resume. |
| `no_agent` | 404 | The session is a shell; this needs an agent. | Hide the action. |
| `no_conversation` | 422 | The agent hasn't reported a conversation id yet. | Try again shortly. |
| `empty_message` | 400 | Nothing to send. | — |
| `not_waiting` | 409 | It stopped waiting (answered elsewhere, or moved on). | Refresh, don't retry. |
| `prompt_changed` | 409 | It's asking something else than what you answered. | Show the new prompt. |
| `already_answered` | 409 | That prompt was just answered (here or on another device). | Don't retry. |
| `bridge_unavailable` | 503 | pi's bridge (experimental) didn't take the answer; its dialog is still on screen. | Retry, or answer in the terminal. |
| `choice_gone` | 409 | The picker row isn't on screen any more. | Refresh. |
| `answer_first` | 409 | A prompt is on screen in front of what you asked for. | Show the prompt. |
| `gate_first` | 409 | A sign-in, trust or setup screen is in front of the agent. | Show the gate. |
| `busy` | 409 | It's working; this needs it idle (relaunch, fork, restore without interrupt). | Offer to wait or stop. |
| `did_not_stop` | 409 | It was told to stop and didn't. | Offer Stop again. |
| `running` | 409 | It's running; this needs it ended. | — |
| `queue_item_gone` | 404 | That queued message was sent or removed already. | Refresh the queue. |
| `snapshot_not_found` | 404 | No snapshot by that turn. | Refresh the list. |
| `message_in_flight` | 409 | A message went in since a relaunch was checked; nothing changed. | Try again after its turn. |
| `subagent_read_only` | 409 | A subagent its parent agent runs: nothing reaches it on its own (`docs/spec/16-subagents.md`). | Send to the parent instead. |
| `subagent_running` | 409 | A spawned thread whose tree still runs: it can't go on as a session of its own yet. | Wait for the parent to stop. |
| `no_subagents` | 404 | This session's agent has no subagents ah can read. | Hide the Subagents entry. |
| `guardrail_blocked` | 403 | An external safety guardrail refused delegated approval of a destructive command or sign-in gate. | Forward the prompt to the user. |
| `self_control_denied` | 403 | A session tried to answer its own prompt, change its own permission mode, modify its own supervision, or decide a user decision. | Forward to the user or supervisor. |
| `upward_control_denied` | 403 | Unidirectional hierarchy (`CoS > session`): a session tried to control its supervisor/ancestor or a chief session. | Communicate up via `ah mail send` (non-directive) or safe live `ah send`. |
| `lateral_control_denied` | 403 | A supervised session tried to directly drive or message a sibling or peer outside its subtree. | Communicate up to its supervisor or broadcast via `ah mail broadcast`. |
| `not_managed_by_caller` | 403 | The target session is supervised by a different session than the caller, or outside the caller's subtree. | Ask its supervising session instead. |
| `supervision_cycle` | 400 | Setting `managedBy` would create a self-loop or cycle in the supervision tree. | Pick an acyclic supervisor. |
| `invalid_session_token` | 403 | `X-AH-Session` named a launched session without a matching `X-AH-Session-Token`. | Include the session's `AH_SESSION_TOKEN` header. |
| `invalid_space_name` | 400 | Space name is empty, too long, or contains path separators (`/` or `..`). | Use a plain Space name (1–64 chars, no `/`). |
| `space_not_found` | 404 | A session was put in (or started in) a Space this host doesn't have (`docs/spec/17-spaces.md`). | Refresh the Spaces list; offer the ones there are. |
