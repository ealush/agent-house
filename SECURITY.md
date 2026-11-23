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
- **A lost or stolen phone running the native app.** The iPhone/iPad app enrolls with the
  same host-issued one-time code, then holds a device key that never leaves the Secure
  Enclave and needs Face ID/Touch ID to sign. Each sign-in signs a fresh, single-use
  challenge bound to its purpose, the addressed host and the device's name, and becomes an
  ordinary session (same expiry and revocation, which also closes its streams and
  terminals) carried as a bearer secret in the Keychain. Removing the device from Settings
  ends all of its sign-ins.
- **Malicious web pages you visit.** Host allowlist (DNS rebinding), exact-Origin checks
  on WebSockets and writes (a dev server on another port of the same name doesn't pass), an `X-AH` header on every write (needs a CORS preflight ah never
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

Test paths are inside [`apps/server`](apps/server).

| Invariant | Test |
|---|---|
| Listens on loopback only; no flag overrides it | `test/security/authz.test.ts` |
| Default deny: every route but the sign-in surface needs a session or token | `authz.test.ts` (route matrix) |
| Writes need X-AH + ah's exact Origin (scheme, host and port: another port on the same name is another site) | `authz.test.ts`, `websocket.test.ts` |
| Host allowlist; Serve requests need the owner's identity; loopback ignores the header | `authz.test.ts`, `websocket.test.ts` |
| WebSockets: same checks; revoke closes them; oversized frames don't crash ah | `websocket.test.ts` |
| Native app: writes need X-AH; Origin may be absent only with a native bearer (or on the native sign-in routes) and no cookie; bearer and cookie secrets never substitute for each other | `test/security/native.test.ts` |
| Native sign-in: code spent only after the key proves possession; signatures bound to purpose/Host/challenge/label; revoking a sign-in or removing a device cuts its streams and terminals | `test/security/native.test.ts` |
| Native push: only a native sign-in registers an APNs token; signing out, revocation or removing the device drops it; tokens go only to Apple's origins | `test/security/apns.test.ts`, `server/apns.test.ts` |
| Hub never forwards cookies, never follows redirects, never uses plain-http LAN peers | `peers.test.ts` |
| Usage reads only the agents' own transcripts on this host: no provider endpoints, no credentials; exports neutralise spreadsheet formulas | `server/usage.test.ts`, `test/usage.test.ts` |
| Recovery acts only on recorded evidence and only when switched on; it never changes model, provider or permission mode, never retries a credentials failure, types into a crashed agent's window only at a shell prompt and only that agent's own resume command, and is bounded per session and per host | `test/recovery.test.ts`, `server/recovery.test.ts` |
| Jobs act only as you could: behind the same sign-in, launching configured agents only (choices checked as New session does), a dangerous permission mode only with `allowDangerous`, every create/decide/resolve audited; transcript text filled into a job's message is data, never a scheduler instruction | `test/jobs.test.ts`, `server/jobs.test.ts`, `authz.test.ts` |
| Moving a session between hosts: the destination's incoming routes take only a machine token it issued (never a device sign-in), check every file's sha256, write only inside its own roots and its harness stores, never over an existing conversation; environment values, credential stores and keys never travel; the source is never deleted | `test/migrate.test.ts` |
| Voice: audio and its text go only to the speech and cleanup subscriptions chosen in Settings → Voice, each with its own key; audio is held in memory for the one request and never written; the activity log records that a dictation happened and its size, never the words; the cleanup model gets the transcript as tagged data with rules not to act on it | `server/voice.test.ts`, `test/voice.test.ts`, `authz.test.ts` |
| Files: configured roots only, symlinks resolved, uploads 0600, downloads sandboxed; media (`/api/fs/media`) also from `files.media`, read-only, pictures, video and sound only by the real path's extension | `files.test.ts`, `server/files.test.ts` |
| Uploads stream to a hidden part file and take their name only when whole; size, upload-folder total and free disk space are capped (`uploads` in config); refused, cut or stalled uploads leave nothing behind; names can't leave the folder | `test/reliability.test.ts` |
| Setup codes spent only after a passkey verifies; throttling per mechanism/source | `server/auth.test.ts` |
| Unreadable auth state stops startup instead of starting empty | `server/auth.test.ts` |
| ah crashing or being killed never kills sessions | `test/tmux.test.ts` |

## Sensitive state on disk

All under `~/.local/state/ah/` (mode 0700 directory, 0600 files):

| File | Contains |
|---|---|
| `auth.json` | passkey and native-device public keys, hashed session and token secrets, scrypt password hash, the browser cache secret |
| `local-token` | the host CLI's bearer token (regenerated each start) |
| `peer-tokens.json` | tokens other hosts issued to this one |
| `ah.db` (SQLite via Prisma) | the session registry (titles, directories, conversation ids, queued messages), recent prompts (may contain anything you pasted — `promptHistory: 0` keeps none; Security → Clear prompt history), chat API keys and side-chat history (the API returns a key only masked, its first and last few characters), session environment variables (Settings → Environment; secret values are returned masked the same way, and every window ah starts gets them, so any agent you run can read them), and loose settings. First boot imports `sessions.json`/`prompts.json`/`sidechat.json` once when present; those legacy files are then unused |
| `audit.log` | sign-ins, failures, enrollments, and session actions (create, send, approve, kill, upload, subscription save/remove, environment variable save/remove by name, never value, voice dictations by size and subscription, never the words) |
| `push.json`, `vapid.json` | Web Push subscriptions and keys |
| `apns.json` | the native app's APNs device tokens, each tied to the native sign-in that registered it (dropped when that sign-in ends). The APNs signing key itself is wherever `apns.keyFile` points |
| `drafts.json` | unsent composer text per session (may contain anything you typed or pasted), so it follows you between devices; cleared when sent or emptied, dropped after 14 days untouched |

Uploads go to `~/.cache/ah/uploads/` (0600), streamed to disk: by default up to 4 GB a
file, 20 GB for the folder, and never below 1 GB free on the disk (`uploads.maxBytes`,
`maxTotalBytes`, `minFreeBytes`; an upload that sends nothing for `idleMs`, 2 minutes,
is dropped). Part files a crash left behind are swept at the next start.

Previews (a session's dev server, `server/preview.ts`) are proxied on ports of their
own (47600–47699 by default), each published with `tailscale serve`. A preview requires the
same Serve identity and sign-in as ah, never forwards ah's session cookie or Tailscale
identity headers to the dev server, drops any `Set-Cookie` that would overwrite ah's, and
may be framed only by ah and itself. Being another origin, the previewed page can't read
ah's pages; ah's exact-Origin check keeps it from writing to ah or opening a terminal.
Mappings a crashed ah left behind are removed at start (only ours: a port proxied to
itself).

In the browser, the GUI keeps the newest page of recently viewed conversations, and a
copy of the session list (titles, directories, statuses; refreshed every 20s at most), in
IndexedDB (`ah-feed-cache`) so a reload paints at once. Every record is AES-GCM
encrypted with a key the server derives from that device's sign-in (`cacheSecret` in
`auth.json`, HMAC'd with the session); the key is fetched after sign-in and never
stored. Signing out deletes the cache; a revoked or expired sign-in leaves only
ciphertext nobody can read, and the next sign-in clears it.

## Hardening checklist for your tailnet

- Restrict who can reach port 443 on the host in your tailnet policy (see README).
- Keep `peers` empty unless you use multi-host; prefer explicit peers over `"auto"`.
- Keep `files.roots` narrow; add `"~"` only if you really want your whole home browsable.
