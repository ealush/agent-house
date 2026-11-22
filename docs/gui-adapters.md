# Feed adapter research: Grok, Gemini (agy), Muse, opencode

Per-harness notes for the adapters in `server/feed/adapters/`, written for
BACKLOG F47 (issue #7). Honesty marker, stated once and true of every section
but Gemini's: none of these formats was verified against a local install of
the harness. Each
was documented from third-party readers and reverse-engineering reports that
were themselves written against real installs (late 2026), and each adapter
ships with a synthetic fixture built to that documented shape. Where a
report said "verified on a real corpus", the shape is marked documented-
verified; where a shape was inferred or unpublished, it is marked
documented-unverified and the adapter tolerates its absence.

## Grok (xAI Grok Build CLI): priority 1

- Store: `~/.grok/sessions/<percent-encoded-cwd>/<session-id>/` with
  `chat_history.jsonl` (transcript), `summary.json` (metadata: `info.id`,
  `info.cwd`, `generated_title`, `current_model_id`, RFC3339 timestamps),
  plus `updates.jsonl` and other state the adapter does not read.
  Documented-verified by several independent readers.
- Format: JSONL, one object per line, `type` in system, user, assistant,
  reasoning, tool_result, backend_tool_call, and more (open set; unknown
  types skipped). User content is text blocks; real prompts carry
  `prompt_index` and a `<user_query>` wrapper; injected context carries
  `synthetic_reason` or no `prompt_index`. Assistant content is a bare
  string plus top-level `tool_calls` (`arguments` is a JSON string).
  Reasoning carries a plaintext `summary`. No per-line timestamps.
- Append behavior: append-only lines, written live. The line feed fits as-is.
- Resume: `grok --resume <id>`, `grok --continue` for the latest in a cwd.
  The conversation id is the session directory name and matches `info.id`.
- Subagent sessions carry `session_kind: "subagent"` in summary.json and are
  skipped in discovery, matching Grok's own session list.

## Gemini (Google Antigravity CLI, `agy`)

Gemini runs in agy since Gemini CLI stopped being meant for Gemini 4 (the
`gemini` preset's command is `agy`). Unlike the others on this page, this
format was read from a real install (agy 1.5.14) and the schema agy ships in
its own binary, and its fixture (`server/fixtures/agy/conversation.json`) is a
real conversation trimmed to the fields the adapter reads.

- Store: `~/.gemini/antigravity-cli/conversations/<conversation id>.db`, one
  SQLite database per conversation, written through a WAL. Beside it,
  `conversation_summaries.db` holds each conversation's title, folders and,
  for a subagent's, the conversation that started it.
- Format: table `steps` (`idx`, `step_type`, `status`, `step_payload`), each
  payload a protobuf `exa.cortex_pb.Step` (third_party/jetski/cortex_pb/
  cortex.proto). Rendered: user input (type 14), planner responses (15:
  response, thinking, tool calls with `arguments_json`), and every step whose
  metadata answers a tool call (its generic result text, the command's exit
  code). System reminders (101) and the rest are skipped. Table
  `trajectory_metadata_blob` has the workspace URI and start time.
- Append behavior: steps are rewritten in place as they run (RUNNING → DONE,
  a reply streams in), so it is a document loader, re-read whole when the
  database or its WAL changes.
- Resume: `agy --conversation <id>` (the file name), `agy -c` for the latest
  in the folder.

## Muse (Meta Muse Code CLI): priority 4 in the spec's order, built third

The spec named "Muse"; in this repo the `muse` preset is Meta's Muse
Code, and it does have a durable per-conversation transcript, so it is not
descoped:

- Store: `~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`
  (XDG_DATA_HOME honored), append-only JSONL of envelope records:
  `{ schema_version, id, stream: { kind, id }, sequence, recorded_at,
  payload_type, payload }`. `recorded_at` is microseconds since the epoch.
- Conversation lives in `runtime.session` records whose `payload.kind` is
  `run`, by `payload.event.kind`: `started` (`event.prompt`),
  `assistant_message_committed` (`event.text`),
  `assistant_tool_calls_committed` (`event.tool_calls[]` with `name`,
  `call_id`, and `args` as a JSON string), and
  `tool_result_batch_committed` (`event.results[]` with `tool_call_id` and
  `text`). Session metadata is a separate `runtime.session.metadata` record
  (`payload.record.workspace_root`). Documented-verified against a small
  real corpus by the reporting project; the wider event vocabulary is
  mostly telemetry and is skipped.
- Documented-unverified here: the `reasoning_committed` payload shape (the
  adapter accepts `text` or `summary` and otherwise skips it), and tool
  result error flags (the adapter accepts `is_error` or an error `status`
  when present).
- Subagent transcripts nest under `<session>/subagent/<id>/` and carry no
  metadata record; discovery lists top-level sessions only.
- Resume: no resume flags are wired in the preset yet. The CLI's session
  store is its own; ah falls back to the generic resume path until the
  flags are confirmed. This is the one acceptance gap for Muse.

## opencode: priority 3

- Store, current (v1.2+): one SQLite database at
  `~/.local/share/opencode/opencode.db` (WAL). Tables `session` (typed
  columns incl. `directory`, `title`, `parent_id`, `time_updated`),
  `message` and `part` (each with a JSON `data` blob: role and time on the
  message; the typed part on the part row). Legacy (pre-1.2): a JSON tree
  at `~/.local/share/opencode/storage/` (`session/<project>/<id>.json`,
  `message/<session>/<msg>.json`, `part/<message>/<part>.json`, with a
  later variant nesting parts under the session id too). Both generations
  can coexist after migration; the database wins per session id.
  Documented-verified by several independent readers.
- Part vocabulary: text, reasoning, tool (`callID`, `tool`, `state` with
  status pending, running, completed or error plus `input`, `output`,
  `error`), step-start, step-finish, snapshot, patch, agent, subtask,
  retry, compaction, file. Message time prefers `data.time.created`: on
  migration-copied rows the `time_created` column holds the migration time.
- Access: `node:sqlite` (built into Node 23.6+, this repo's floor) opened
  strictly read-only, one short-lived connection per poll, never written
  and never held. A locked or unreadable database yields no entries, which
  the stream surfaces as no transcript.
- Resume: `opencode --session <id>`, `opencode --continue`. Session ids
  (`ses_...`) are the resume ids. Subagent sessions have `parent_id` set
  and are skipped in discovery.

## Fixture policy

Fixtures under `server/fixtures/` are synthetic, built to the documented
shapes above, with neutral content and placeholder home paths. No real
transcript text, tokens, or personal data. When a real install becomes
available, the fixture-first policy from the spec applies: capture a
scrubbed real sample, watch the tests, then fix the adapter.
