# The pi bridge (experimental)

ah drives most agents through their terminal: it types a message into the TUI and presses
Enter, presses Escape to stop, presses the keys of a permission prompt to answer it, and reads
the screen to find out which of those just happened. The bridge is the other way to do it, for
pi: ah hands pi the message, the Stop and the answer, and pi says what happened.

It is off unless you turn it on, and it is built to be either the way pi always runs, or
deleted, without touching anything else.

## Turning it on

In `~/.config/ah/config.json`:

```json
{ "experimental": { "piBridge": true } }
```

Restart ah. Sessions started after that load the extension; sessions already running keep
what they started with.

## What it changes for a pi session

- **A message goes in once.** It reaches pi through its extension API (`pi.sendUserMessage`),
  never as keystrokes, so it can't be lost to a dropped Enter or land in a picker. Each one
  carries ah's id for it; pi remembers the ids it took (in the session file, never sent to the
  model), so a retry after a lost reply, or after pi restarted, isn't taken twice.
- **Stop stops.** `ctx.abort()`, not Escape into whatever is on screen.
- **Approvals.** pi has none of its own. With the bridge, ah's default mode ("Ask") makes pi
  wait before it runs a command or changes a file; reads and searches don't ask. The question is
  on pi's screen (Yes/No) and in ah at once; whichever answers first wins and closes the other.
  A message sent while it waits is the answer "no, and here's why". Stop declines it. "YOLO"
  (`--ah-approval never`) asks nothing, like plain pi.
- **An approval outlives ah.** It's held inside pi's process, in tmux. Restart ah while pi
  waits and the new ah shows the same question and its answer goes through.
- **Live model and thinking switches.** `/model provider/id` and `/thinking level` from ah's
  model picker go to pi's own `setModel` and `setThinkingLevel`. (Typed into pi's TUI,
  `/model provider/id` opens its picker filtered to that text, so plain pi has no live switch.)
- **State from pi itself.** Working, done, waiting, what it's running and the model, written to
  the same tmux window options ah's Claude Code and Codex hooks write. Nothing is read off the
  screen for it.

What stays as before: the terminal (open it, type in it, `/login`, any slash command, any
screen ah doesn't model), its transcript in the chat view and History (server/feed/adapters/pi.ts),
resume, and everything about other agents.

## How it fits together

```
 ah (server/pi/bridge.ts)                      tmux window
 ─────────────────────────                     ──────────────────────────────────
 send / stop / answer ──── Unix socket ──────▶ pi, its TUI
   one connection a request                    └ ah's extension (bin/pi-extension.ts)
   nothing listening → type it as before          ├ takes prompts, Stop, answers, switches
                                                  ├ holds approvals (Yes/No on screen too)
 readWindows (server/sessions.ts) ◀── tmux ─────  └ writes @ah-state, @ah-ask, @ah-model…
   window options, as ah's hooks write them
```

- ah starts pi as `pi -e <apps/server/bin/pi-extension.ts>` with `AH_PI_SOCKET` set
  (`$XDG_RUNTIME_DIR/ah-pi/<session uid>.sock`, a folder only you can open).
- ah never holds pi's process or a connection to it: each request connects, gets its answer and
  closes. ah restarting, a request lost, a client gone: the next request connects again.
- A session counts as bridged when pi is running in it and the extension wrote its state
  (`piBridged`, server/pi/bridge.ts). Anything else, including pi started by hand without ah,
  is handled as plain pi.
- No wire change: the app and the web client see the same `status`, `ask`, `answerable` and
  `askId` as for any agent with hooks, so they need no update.

## Making it the way pi always runs

1. Apply `withPiBridge` to the pi preset unconditionally (`Core.applyHarnesses`, server/core.ts),
   or fold its fields into the pi preset in server/config.ts.
2. Drop `experimental.piBridge` from `Config` and `loadConfig` (server/config.ts).
3. Keep test/pi-bridge.test.ts running where pi is installed.

## Removing it

1. Delete `apps/server/bin/pi-extension.ts`, `apps/server/server/pi/`, `test/pi-extension.test.ts`,
   `test/pi-bridge.test.ts`, `test/fixtures/fake-openai.ts` and this page.
2. Remove `experimental` from `Config` and `loadConfig`, the `withPiBridge` line in
   `Core.applyHarnesses`, `AH_PI_SOCKET` in `Core.launch`, and `typeInto`/`stopKeys`'s bridge
   branch and `answer`'s (server/core.ts); `bridged` in `readWindows` (server/sessions.ts); the
   optional `w`, `id` of the queue's `paste` (server/queue.ts).

pi then runs as before: its transcripts, History and model list (the layer under this one)
don't depend on the bridge.

## Checking it

- `node --test test/pi-extension.test.ts`: the extension against a stand-in for pi's API, and
  ah's client, over a real socket. Runs anywhere.
- `node --test test/pi-bridge.test.ts`: the real pi in its real TUI in a disposable host, a
  scripted model instead of a provider, driven through ah's HTTP API only: a message once
  (and its retry not again), an approval answered after ah restarted, a message as the answer,
  Stop mid-stream, a live model switch. Skipped where pi isn't installed (CI); set
  `AH_TEST_PI` to a pi binary to pick one.

## Limits

- Models: pi reaches what its providers list. Gemini through pi is the Gemini API
  (`GEMINI_API_KEY`) or Vertex, not a Google subscription sign-in; pi 1.2.0's catalog has no
  Gemini 4 models (the ones agy runs). A model the API serves but the catalog lacks can be added
  in pi's `models.json`.
- Approvals cover pi's built-in tools and any tool that doesn't declare itself read-only;
  an extension of yours that runs commands its own way isn't asked about.
- pi's /tree branches are in the one session file; the chat view shows them in the order they
  happened, not as a tree.
