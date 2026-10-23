# Transport foundation

Source drift was checked on 24 October 2026: `../ah` still matches `SOURCE.json`, including its revision and all audited file hashes. No backend changes are part of this slice.

## Wire contract in this scaffold

| Boundary | Source | Native implementation |
| --- | --- | --- |
| API version 28 and state | `../ah/web/api.ts`, `../ah/server/core.ts` | `HubStateDTO` is a read-only projection of `api`, `hostname`, `hosts`, `windows` and `focus`. Session properties cover initial Inbox reads, including statuses, asks, devices and queue counts. Unknown top-level state fields are ignored; history/presets/review are not modeled yet. |
| Stable identity | `../ah/web/useHosts.ts`, `../ah/server/sessions.ts` | `SessionDTO.identity(on:)` uses host + uid. The tmux `id` can change without changing navigation identity. Host attribution comes from the stream owner, never a client-only `host` field expected in the wire window. |
| SSE frames | `../ah/server/main.ts` `/api/events` | `ServerSentEventParser` handles byte chunks, UTF-8/BOM, LF/CR/CRLF, comments, multiline data, empty data, event names, ID and retry fields. Defaults bound each line to 1 MiB and each event block to 8 MiB. Bounds are configurable; malformed UTF-8 fails closed. |
| Initial state and updates | `../ah/server/core.ts` `subscribe`/`tick`, `../ah/web/api.ts` `subscribe` | `HubStateReducer` requires `state` before `patch`. Patches replace supplied top-level fields, including entire arrays. An omitted focus stays unchanged; explicit null clears it. Required fields cannot become null. |
| Incompatibility/resync | API version and state validation | An unsupported API, unknown status/ask kind, malformed recognized event or ambiguous session identity invalidates the baseline. A new full snapshot is required. Unknown event names are ignored. |

No stream revision, event sequence or replay guarantee exists in this audited protocol. The reducer cannot detect lost/reordered patches by itself. The future stream owner must process events serially, reset on a new connection, fetch/reconnect to full state after any gap/error and coordinate polling so an old response cannot overwrite a newer stream snapshot. It must not reuse an incomplete SSE event at EOF.

SSE syntax follows the [WHATWG event-stream specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation). One deliberate stricter behavior is rejecting invalid UTF-8 rather than substituting replacement characters into state JSON. Retry/ID parsing is groundwork only: this backend does not emit IDs, and no reconnection scheduler or Last-Event-ID request is implemented.

## Ownership when transport is connected

The following are requirements for the next slice, not implemented behavior:

- A host/account owner holds the authenticated URLSession and state stream task; scenes observe its state rather than creating competing streams for one host.
- Each active connection gets a new parser and baseline. Only its owner may apply events, publish fresh state, run bounded reconnect/polling or invalidate the account. Tasks and URLSession work are canceled on disconnect/revocation; foregrounding forces resync.
- A separate terminal task belongs to a viewer and resolves host/uid to the current tmux address at attachment. Reconnection must not replay keystrokes, sends or approvals.
- Session payloads stay in memory. The GRDB scene journal continues to contain non-secret navigation metadata only.

## Authentication gate

The audited backend still requires browser Origin/CSRF checks for writes and WebSocket upgrades, plus Serve-injected owner identity and its existing authentication. The scaffold does not manufacture Origin/Tailscale headers, import CLI credentials, accept browser cookies or claim that saving an HTTPS host authorizes requests.

Before URLSession REST/SSE/WS is connected, the backend needs a separately reviewed, scoped and revocable per-device enrollment/credential contract, preservation of browser protections, server audit events and revocation that closes live streams. Credentials must use Keychain. Associated Domains feasibility, signing and APNs remain unresolved. No speculative route, token format or enrollment-success UI is introduced here.
