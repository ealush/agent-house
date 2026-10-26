# Transport

How the app talks to `ah`. Backward compatible: browsers and the CLI see no change.

## Authentication

| Step | Route | What happens |
| --- | --- | --- |
| Setup code | issued by a signed-in device (`POST /api/auth/code`) or `ah auth code` on the host | One-time, ten minutes |
| Enroll | `POST /api/auth/native/enroll/options` → `/verify` | The device signs `ah-native-enroll-v1\n<challenge>\n<host>\n<public key>\n<label>` with its new P-256 key; the host stores the public key as a device and returns a bearer session |
| Sign in | `POST /api/auth/native/login/options` → `/verify` | Signs `ah-native-login-v1\n<challenge>\n<host>\n<device id>\n<label>` (Face ID unlocks the key) |
| Requests | any | `Authorization: Bearer <token>`, `X-AH: 1` on writes, no cookies; Origin may be absent only with a native bearer and no Cookie header |
| WebSocket | `/ws/@<window>` (or `/h/<peer>/ws/@<window>`) | Same bearer; a revoked session closes with 4401; an upgrade refused with 401/403 signs out |
| Preview | `POST /api/auth/native/preview-session` | A child session as a host-only cookie for the non-persistent preview web view |
| Remove device | `DELETE /api/auth/devices/:id` | Ends every sign-in from that device and its push registration |

Any 401 or 4401 signs the account out across windows (fail closed); nothing is retried with weaker credentials. Labels are sanitized to `[\w .·()-]`, 60 characters.

## State

`StateStream` (`Sources/Connection`) owns one host's `/api/events` SSE: a new parser and reducer per connection, `state` then `patch` events, reconnect with backoff, polling `/api/state` while the stream is down (never concurrently with it, so an old poll can't overwrite a newer snapshot), and a forced resync on foreground. `HubStore` runs one for the hub and one per online peer through `/h/<peer>`, merging rows with keys `uid` (hub) or `peer/uid`.

The protocol has no sequence numbers, so every reconnect starts from a full snapshot; no send, approval or keystroke is ever replayed on reconnect.

## Feed and terminal

- `FeedStream`: the transcript snapshot then appends over SSE, older pages on demand, a sealed cached page painted first (never over live data).
- `TerminalConnection`: resolves the session's current tmux window at each attach (ids change across restarts), sends input/resize/scroll frames, and reports `signedOut` on 4401.

## Push

`PUT /api/push/apns` registers `{token, environment, events: {waiting, done}, preview}` for the current native sign-in; `DELETE` withdraws it; `GET` reports provider configuration. The host signs ES256 JWTs with `config.apns` (`teamId`, `keyId`, `keyFile`, `topic`) and talks HTTP/2 to Apple; `AH_APNS_ORIGIN` points it at a loopback gateway in tests. Payload: `aps` (title/body or title only, badge, thread, `time-sensitive` for needs-you, `AH_APPROVAL` category for plain permission prompts) plus `ah: {v: 1, host, route, event}`.
