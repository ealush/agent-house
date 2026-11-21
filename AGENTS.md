# AGENTS.md — Agent House

One product, one repository: the self-hosted server (`ah`) with its web client and CLI, and
the native iPhone, iPad and Mac app that talks to it. `~/code/CLAUDE.md` / `AGENTS.md` (stacked
PRs through `gh stack`, every layer independently green with proof) apply on top of this.

## Layout

| Path | What it is | Built and tested with |
|---|---|---|
| `server/` `web/` `bin/` `prisma/` `test/` `contrib/` | The `ah` server (Node 26, TypeScript run directly), the React web client, the CLI and hooks, the SQLite schema and migrations, their tests, the systemd units | pnpm |
| `apps/ios/` | The native app: Swift 6, UIKit + SwiftUI, Observation, GRDB, SwiftTerm. `Package.swift` is its portable half (everything but `Sources/Features` and `Sources/Platform`); `project.yml` generates the Xcode project | SwiftPM, XcodeGen, xcodebuild |
| `docs/` | The server's specs (`docs/spec/`), architecture and releases | — |
| `scripts/` | Workspace scripts: `check.sh` (every check), `prisma-check.mjs` | — |
| `mise.toml` | Tool pins and the task interface below. It calls the tools; it builds nothing itself | mise |

Each app keeps its own guide: [`docs/architecture.md`](docs/architecture.md) for the server
(layers, the functional core, routes, errors, contracts) and
[`apps/ios/AGENTS.md`](apps/ios/AGENTS.md) for the app. They're binding; this page only adds
what spans both.

Neither app depends on the other at build or run time. The server deploys on Linux with no
Xcode; the app builds with Apple's tools alone. Only tests and scripts cross the line: the
app's integration suite starts a disposable server from this repository, and the server's
contract manifests pin what the app reads.

## How the app and the server talk

The server listens on loopback only; Tailscale Serve carries every other device to it.

- **HTTP JSON under `/api`**: browsers sign in with passkeys (cookies); the app enrolls a
  P-256 device key with a one-time setup code and sends `Authorization: Bearer`, `X-AH: 1` on
  writes. Details: [`apps/ios/docs/native/TRANSPORT.md`](apps/ios/docs/native/TRANSPORT.md),
  [`SECURITY.md`](SECURITY.md).
- **SSE**: `/api/events` (the whole state, then patches), a session's transcript feed.
- **WebSocket**: `/ws/@<window>`, a terminal.
- **Versioning**: `API_VERSION` (`server/core.ts`) must equal what installed apps accept
  (`HubStateDTO.supportedAPIVersion`): never bump it. New abilities are announced per feature
  in `server/features.ts` and read by the app with `supports("<feature>", version:)`.

The contracts are pinned on the server side: [`docs/spec/api-routes.txt`](docs/spec/api-routes.txt)
(every route, `server/routes.test.ts`), [`docs/spec/wire-shapes.txt`](docs/spec/wire-shapes.txt)
(every field clients read, with its type, `test/contract.test.ts`) and
[`docs/spec/errors.md`](docs/spec/errors.md) (error codes). Changes are additive only: a
field may be added, never removed, retyped or made nullable, because installed apps decode
strictly.

## Commands

`mise tasks` lists them all. Without mise, each is the command in `mise.toml`.

| | |
|---|---|
| `mise run setup` | `pnpm install` (builds node-pty, generates Prisma); on macOS also `ios:bootstrap` |
| `mise run server:dev` · `server:start` | The server on 127.0.0.1:7681 (dev: `--watch` and Vite) |
| `mise run server:typecheck` · `server:build` · `server:test` · `server:test:ui` · `server:prisma` | Typecheck, web build, server tests (real tmux), the page in Chromium, schema vs migrations |
| `mise run ios:static` · `ios:coverage` | The app's portable static checks; every server route reachable from the app |
| `mise run ios:test:core` | `swift test` on the portable package (Linux or macOS) |
| `mise run ios:bootstrap` · `ios:build` · `ios:test` | Generate the Xcode project; simulator + Mac Catalyst build; `verify.sh` (simulator unit + UI tests) — macOS |
| `mise run integration` · `integration:review` | The app against a disposable real host built from this checkout |
| `mise run check` | Everything this machine can run, then what it couldn't and why |

## A change on both sides

1. Change the server, additively. A new ability gets a `features.ts` entry (or a version bump
   of its feature); never change `API_VERSION`.
2. Regenerate and review the pins: `AH_UPDATE_CONTRACT=1 node --test test/contract.test.ts`,
   `AH_UPDATE_ROUTES=1 node --test server/routes.test.ts`. The diff is the API change.
3. Change the app: its call, its decoding (optional for anything an older host doesn't
   send), and gate it on `supports(...)` so it still works against an older host.
4. `mise run ios:coverage` (the new route has a way in from the app, or a stated reason),
   `mise run integration`, then `mise run check`.
5. Land server and app in one stack, server layers first.

## Boundaries that don't move

- The server binds loopback only and never changes its own exposure; no plain-http fallback.
- Restarting `ah` never ends sessions: tmux belongs to `ah-tmux.service`.
- Never spoof Origin or Tailscale identity headers, reuse the host's CLI token in the app,
  or loosen admission (`server/admission.ts`) outside its tests.
- Secrets stay out of the tree, logs, fixtures and generated files: device keys in the
  Keychain, the APNs `.p8` beside the host config, App Store Connect keys in `~/.config`.
- State is the user's: `~/.local/state/ah` (SQLite, registry), `~/.config/ah`, tmux. Nothing
  here resets, moves or migrates it except the committed Prisma migrations at startup.
- Bundle IDs, signing team, entitlements and Keychain groups (`apps/ios/Config`) change only
  on purpose.

## Done means

`mise run check` passes, with every skipped line named in the PR and run where it can be (the
Mac for `ios:test`). Never report a check you didn't run, and never skip or weaken a test to
get green.
