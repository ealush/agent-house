# GUI view

Every agent session can be drawn two ways: as its own terminal (xterm.js attached
to the tmux window), or as a GUI built from the agent's **structured transcript**.
Switch with the Terminal / GUI toggle in the session header; the choice is
remembered per device. Both views show the same live session. The GUI never parses
the terminal screen, and switching never restarts anything.

## How it works

```
agent (in tmux) ──writes──▶ transcript (JSONL)
                                 │  server/feed/adapters/<harness>.ts
                                 ▼
                          typed entries (server/feed/schema.ts)
                                 │  GET /api/sessions/:ref/feed/stream (SSE)
                                 ▼
                 web/gui: reducer over the event log ─▶ dispatch to components
```

- **One adapter per harness** turns its native log into one vocabulary: entries
  with a role, a step type and typed parts (`text`, `reasoning`, `media`,
  `tool_call`, `tool_result`, `widget`, `notice`). Claude Code, Codex, Grok,
  Muse and Gemini (JSONL form) ship as line adapters; Gemini's older document
  form, opencode (SQLite store and legacy JSON tree) and Hermes (its SQLite
  `state.db`) ship as document adapters whose loader returns the whole
  conversation per poll. A preset
  opts in with `"feed": "<adapter>"`. Agents without an adapter are
  terminal-only. See [gui-adapters.md](gui-adapters.md) for the per-harness
  format research and what is verified vs documented.
- **`seq` is the transcript line number**: the only ordering authority. The stream
  sends a `snapshot`, then `append`s; older entries are paged with
  `GET /api/sessions/:ref/feed?before=<seq>`. If the transcript is replaced (a
  `/clear`) or truncated, a new snapshot rebuilds the view. Nothing is invented: a
  session with no transcript or no adapter gets an `unavailable` message that says
  which.
- **Tool calls are objects** (`name`, `id`, `args`, and later a result folded in by
  id). `web/gui/tools.tsx` maps tool names to views (command and output, diffs,
  checklists, questions…) with a default for everything else. Adding a view is
  adding an entry there; the server already sends everything a view needs.
- **Composing.** `/` at the start of a message lists the agent's slash commands
  (built in, plus your and the project's `.claude/commands` and skills); `@` lists
  the project's files (`git ls-files`, or a bounded walk outside git). Messages
  you send show at once until the transcript records them; queued follow-ups sit
  under the live turn with Send now / Edit / Cancel. Esc in an empty composer
  stops a working agent.
- **Sending is unchanged.** The GUI composer, widget buttons and approvals go through
  the same send / answer API as the terminal, so the agent sees ordinary text.
- **Answering without the terminal.** A waiting agent's numbered picker (a
  permission prompt's "Yes / Yes, and don't ask again / No") is read off the
  screen and drawn as buttons; Claude Code's question dialog (AskUserQuestion) is
  drawn as a form from the questions its hook records, or from the transcript.
  Digits pick, arrows move, Space toggles, Enter submits. The server types the
  keys (`server/choices.ts`) only after re-checking that the same picker is still
  on screen and untouched, so a stale click never lands in a live agent.
- **Some things exist only in the terminal**: other pickers the agent draws
  (`/model`) and raw keys. The GUI offers "Answer in terminal" for those.

The two views are separate component trees: `web/TerminalSurface.tsx` and
`web/gui/` (loaded on first use). `web/surface.ts` is the only place that knows
both exist.

## Widgets (generative UI)

An agent can ask the GUI to draw something by writing a fenced block with the
language `ah-widget` holding one JSON object with a `type`. In the terminal it's an
ordinary code block. A block that isn't valid JSON stays text, and an unknown
`type` is shown as its raw fields.

| `type` | Fields |
|---|---|
| `card` | `title`, `body` (markdown), `tone` (`info` `success` `warning` `danger`), `actions: [{label, reply}]` |
| `choices` | `prompt`, `options: [string \| {label, reply?, description?}]`. A click sends `reply` (or the label) as your answer. |
| `table` | `title`, `columns: string[]`, `rows: (string\|number)[][]` |
| `checklist` | `title`, `items: [{text, done: true \| false \| "in_progress"}]` |
| `stats` | `title`, `items: [{label, value, delta?, tone?}]` |
| `bar-chart` | `title`, `unit`, `data: [{label, value}]` (one series) |
| `progress` | `label`, `value`, `max` (default 100) |
| `links` | `title`, `items: [{label, url, description?}]` |
| `image` | `src` (absolute path on the host, or a `data:image/…` URL), `alt`, `caption` |
| `code` | `title`, `code` |
| `diff` | `title`, `patch` (unified diff) |

Paths in links and images open through ah's file API, so they are limited to the
folders in `files.roots`.

To have an agent use widgets, add something like this to its `CLAUDE.md` or
`AGENTS.md`:

````markdown
When a result is easier to read as UI (a table, a choice for me, stats, a short
chart), you may add a fenced block with language `ah-widget` containing one JSON
object, e.g.

```ah-widget
{"type": "choices", "prompt": "Which fix?", "options": [{"label": "Retry", "reply": "Add the retry"}, "Skip it"]}
```

Types: card, choices, table, checklist, stats, bar-chart, progress, links, image,
code, diff. Always say the same thing in prose too; the widget is a convenience.
````
