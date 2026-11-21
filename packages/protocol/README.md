# packages/protocol — what the app and the server agree on

Nothing imports this at run time. The server (TypeScript, `apps/server`) and the app (Swift,
`apps/ios`) each keep their own code; this folder is the contract between them, as data, with
the tests on each side that hold that side to it. A change to anything here is an API change:
review it as one, and run both sides' checks (CI does, for any change under `packages/`).

| File | What it is | Written by | Checked by |
|---|---|---|---|
| [`api-routes.txt`](api-routes.txt) | Every HTTP route under `/api`, in match order | `AH_UPDATE_ROUTES=1 node --test server/routes.test.ts` | `apps/server/server/routes.test.ts`; the app's `scripts/backend-coverage.mjs` (every route has a way in from the app, or a stated reason) |
| [`wire-shapes.txt`](wire-shapes.txt) | Every field clients read, with its JSON type | `AH_UPDATE_CONTRACT=1 node --test test/contract.test.ts`, against a disposable real host | `apps/server/test/contract.test.ts` |
| [`errors.md`](errors.md) | Error `code`s clients act on | by hand | `apps/server/server/errors.test.ts` |
| [`versions.json`](versions.json) | `API_VERSION` and every feature's version, as the server announces them | `apps/server/test/protocol.test.ts` (`AH_UPDATE_CONTRACT=1`) | that test (server); [`check-app.mjs`](check-app.mjs) and `ProtocolFixtureTests.swift` (app) |
| [`fixtures/`](fixtures) | The real answers the manifest was read from (hello, auth status, state, capabilities, create, send, queue, errors) and the `?delta=1` state stream the app subscribes to: a snapshot, then a patch. Machine paths, names and ports scrubbed | `contract.test.ts` (`AH_UPDATE_CONTRACT=1`) | `protocol.test.ts` (they hold exactly the pinned shapes); `apps/ios/Tests/Core/ProtocolFixtureTests.swift` (the app's own decoders, parser and reducer read them) |

What isn't pinned here is covered live: the transcript feed, terminal WebSocket frames and
close codes, device enrollment and sign-in signatures, revocation, uploads and drafts run in
the app's integration suite against a disposable host built from this checkout
(`apps/ios/Tests/Integration`, `mise run integration`). The transport itself is described in
[`apps/ios/docs/native/TRANSPORT.md`](../../apps/ios/docs/native/TRANSPORT.md).

## Rules

- **Additive only.** A field may be added; never removed, renamed, retyped or made nullable.
  Installed apps decode strictly and can't be updated in step with a host.
- **`API_VERSION` stays 28.** The app accepts exactly one value
  (`HubStateDTO.supportedAPIVersion`); a host that sends another is refused by every installed
  app. New abilities get a feature (or a feature version bump) in
  `apps/server/server/features.ts`, and the app asks `supports("feature", version:)`.
- **The app tolerates an older host.** Anything the app reads that an older host doesn't send
  is optional on the Swift side, behind its feature where it's a new route.

## Changing the contract

```bash
mise run protocol:update   # regenerate routes, shapes, versions and fixtures from a disposable host
git diff packages/protocol # the API change, to review
mise run protocol:check    # the server's tests of it, and the app's sources against it
mise run ios:test:core     # the app decodes the new fixtures (Swift)
mise run integration       # the app against a live host from this checkout (Swift + tmux)
```

## Why not OpenAPI or generated clients

Considered and left for later. The server's routes are regex tables with hand-written
validation, so an OpenAPI document would be a second hand-kept description, not a source.
The SSE state stream (snapshot, patches, `windowsDelta`) and the terminal WebSocket don't fit
OpenAPI. And the Swift models are deliberately uneven (strict where every host sends a field,
optional where older ones don't), which generated code would flatten. Pinning what the server
really sends, and decoding those exact bytes in the app, catches drift in both directions
without rewriting either side. Once routes declare their schemas in code, generate the
manifest (and an OpenAPI document for the HTTP part) from those declarations.
