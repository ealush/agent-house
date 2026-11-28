# Conformance: ah against the agents' real CLIs

ah drives other programs' terminals: Claude Code, Codex, Gemini through agy, Grok, Muse. Each
release of one can change a screen ah reads, a flag it passes, a transcript it follows, and the
first sign used to be a session that stopped working. The conformance suite catches that first.

## What it runs

`apps/server/conformance/run.mjs` starts a disposable ah from this checkout (its own state and
tmux socket; your agents' own sign-ins, since HOME is yours; your ah's sessions' PATH) and runs
two sets of scenarios against it through ah's HTTP API, the way the app drives it:

- **capabilities.mjs**: each agent replies, queues, approves and denies, stops, switches model
  and effort, resumes, forks, hands a conversation to another agent; two sessions write to each
  other with `ah send`/`ah read`/`ah mail`.
- **history.mjs**: scenarios from ah's own bug-fix history, each naming the commits it re-checks:
  delivery and "not sent", the queue, Send Now and steering, folder trust and permission holds,
  questions, phone widths, ah restarting under a Send Now, forks.

It writes `report.json`, `report.md` and each suite's output and step log to
`$XDG_STATE_HOME/ah/conformance/<time>/`, takes the host and its tmux down, and exits 1 when a
check failed for a reason other than the agent's provider (a rate limit, a request too large).
Real agents answer, so a run spends a little of their quota (Claude on Haiku).

```sh
mise run conformance                                    # every agent, both suites
mise run conformance -- --agents codex --suites history # one agent, one suite
mise run conformance -- --agents claude --only reply,queue
```

## On every agent update

ah reads each installed CLI's version (Settings → Agents → Check Versions, and on its own every
few hours). When one differs from the version the suite last saw, ah runs the suite for that agent
in the background (one run at a time) and keeps the result beside the version in
`$XDG_STATE_HOME/ah/conformance/versions.json`. A failure is an alert: which version, which checks,
where the report is. The first version ah sees of an agent is only noted.

`config.json`:

```json
{ "conformance": { "onUpdate": false } }
```

turns it off (versions are still noted, so turning it on later doesn't run it for updates long
past); `"agents": ["claude", "codex"]` narrows it.
