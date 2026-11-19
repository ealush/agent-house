# Errors

Every refusal is JSON: `{ "error": "<for people>", "code": "<for programs>" }`, with
the HTTP status that fits. Branch on `code`, never on the wording, which may change.
`code` is absent where no client needs to tell the case apart; an unexpected failure is
`500 { "error": "internal error" }` and nothing more (details stay in the host's log).

Each context documents its own codes beside its routes (portable, migrations, jobs,
recovery, interruptions, usage, notes, uploads, voice in `13-conductor.md`,
`14-voice.md`, `15-scratchpads.md`). The sessions' codes (`server/core.ts`):

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
