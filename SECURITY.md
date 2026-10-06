# Security

ah hands out shells. A single authorization mistake is remote code execution as your
user, so it's built to fail closed and is tested adversarially on every commit
(`pnpm test:security`, its own CI job).

## Reporting

Please report vulnerabilities privately: open a GitHub security advisory on this
repository, or email the maintainer. Don't file a public issue.

## Threat model

**Protected against**

- **Other devices and people on your tailnet.** ah listens on loopback only and is
  reached through `tailscale serve`. Requests through Serve must carry the machine
  owner's Tailscale identity (Serve strips client-supplied identity headers and omits
  them for tagged devices), so shared nodes, tagged servers and other users get 403.
- **A lost or borrowed device.** Every device must sign in with a passkey (or the
  optional master password); sessions expire after 24h idle / 30 days, and can be
  revoked from any signed-in device, which also closes their open terminals.
- **Malicious web pages you visit.** Host allowlist (DNS rebinding), Origin checks on
  WebSockets and writes, an `X-AH` header on every write (needs a CORS preflight ah never
  grants), `SameSite=Strict` cookies, strict CSP with no third-party origins, no framing.
- **Brute force.** Guessable secrets (master password, setup codes) are throttled per
  source and per mechanism, with a global ceiling. Passkeys can't be guessed, so failed
  passkey attempts are never throttled — nobody can lock you out of passkey sign-in.
- **Hostile peers (multi-host, opt-in).** The hub forwards only the token that peer
  issued it, never the browser's cookie; redirects are not followed; peers are reached
  over https only (loopback http for local setups).
- **Crashes from bad input.** Malformed frames, oversized messages and bad requests
  close the offending connection; they don't take the server down.

**Not protected against (by design)**

- **Anything already running as your user on the host.** It can read ah's state files
  and drive tmux directly; ah adds nothing it can't already do. The file browser's
  path checks (`realpath` containment) can in principle be raced by such a process
  (time-of-check/time-of-use); that's within this boundary.
- **A compromised Tailscale account or tailscaled.** Tailscale is the network trust
  root.
- **What your agents do.** ah relays your approvals; it doesn't sandbox agents.

## Invariants (and the tests that pin them)

| Invariant | Test |
|---|---|
| Listens on loopback only; no flag overrides it | `test/security/authz.test.ts` |
| Default deny: every route but the sign-in surface needs a session or token | `authz.test.ts` (route matrix) |
| Writes need X-AH + same-site Origin | `authz.test.ts` |
| Host allowlist; Serve requests need the owner's identity; loopback ignores the header | `authz.test.ts`, `websocket.test.ts` |
| WebSockets: same checks; revoke closes them; oversized frames don't crash ah | `websocket.test.ts` |
| Hub never forwards cookies, never follows redirects, never uses plain-http LAN peers | `peers.test.ts` |
| Files: configured roots only, symlinks resolved, uploads 0600, downloads sandboxed | `files.test.ts`, `server/files.test.ts` |
| Setup codes spent only after a passkey verifies; throttling per mechanism/source | `server/auth.test.ts` |
| Unreadable auth state stops startup instead of starting empty | `server/auth.test.ts` |
| ah crashing or being killed never kills sessions | `test/tmux.test.ts` |

## Sensitive state on disk

All under `~/.local/state/ah/` (mode 0700 directory, 0600 files):

| File | Contains |
|---|---|
| `auth.json` | passkey public keys, hashed session and token secrets, scrypt password hash |
| `local-token` | the host CLI's bearer token (regenerated each start) |
| `peer-tokens.json` | tokens other hosts issued to this one |
| `ah.db` (SQLite via Prisma) | the session registry (titles, directories, conversation ids, queued messages), recent prompts (may contain anything you pasted — `promptHistory: 0` keeps none; Security → Clear prompt history), chat API keys and side-chat history (keys are never returned by the API), and loose settings. First boot imports `sessions.json`/`prompts.json`/`sidechat.json` once when present; those legacy files are then unused |
| `audit.log` | sign-ins, failures, enrollments, and session actions (create, send, approve, kill, upload, subscription save/remove) |
| `push.json`, `vapid.json` | Web Push subscriptions and keys |

Uploads go to `~/.cache/ah/uploads/` (0600).

## Hardening checklist for your tailnet

- Restrict who can reach port 443 on the host in your tailnet policy (see README).
- Keep `peers` empty unless you use multi-host; prefer explicit peers over `"auto"`.
- Keep `files.roots` narrow; add `"~"` only if you really want your whole home browsable.
