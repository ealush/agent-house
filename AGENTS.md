# AGENTS.md — Agent House

One product, one repository: the self-hosted server (`ah`) with its web client and CLI, and
the native iPhone, iPad and Mac app that talks to it. `~/code/CLAUDE.md` / `AGENTS.md` (stacked
PRs through `gh stack`, every layer independently green with proof) apply on top of this.

## Layout

| Path | What it is | Built and tested with |
|---|---|---|
| `apps/server/` | The `ah` server (Node 26, TypeScript run directly: `server/`), the React web client (`web/`), the CLI and hooks (`bin/`), the SQLite schema and migrations (`prisma/`), their tests (`test/`, `server/*.test.ts`), the systemd units (`contrib/`). One pnpm package | pnpm |
| `apps/ios/` | The native app: Swift 6, UIKit + SwiftUI, Observation, GRDB, SwiftTerm. `Package.swift` is its portable half (everything but `Sources/Features` and `Sources/Platform`); `project.yml` generates the Xcode project | SwiftPM, XcodeGen, xcodebuild |
| `docs/` | The product spec (`docs/spec/`, both clients), the server's architecture, releases | — |
| `bin/` | `ah.js`, `ah-hook.js`: the stable entry points installs already use (the systemd unit's `node bin/ah.js serve`, hooks written by `ah hooks install`). They only import `apps/server/bin`; keep them | — |
| `packages/protocol/` | The contract between the app and the server: route, shape, error and version pins, and real captured answers | the server's tests (Node) and the app's (Swift) |
| `scripts/` | Workspace scripts: `check.sh` (every check) | — |
| `mise.toml` | Tool pins and the task interface below. It calls the tools; it builds nothing itself | mise |

Each app keeps its own guide: [`docs/architecture.md`](docs/architecture.md) for the server (its paths are inside `apps/server`)
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
- **Versioning**: `API_VERSION` (`apps/server/server/core.ts`) must equal what installed apps accept
  (`HubStateDTO.supportedAPIVersion`): never bump it. New abilities are announced per feature
  in `apps/server/server/features.ts` and read by the app with `supports("<feature>", version:)`.

The contract lives in [`packages/protocol`](packages/protocol/README.md), as data both sides
are tested against (nothing imports it at run time): every route (`api-routes.txt`), every
field clients read with its type (`wire-shapes.txt`), error codes (`errors.md`), the API and
feature versions (`versions.json`), and the real answers and state stream those were read
from (`fixtures/`). The server's tests regenerate and check them against a disposable host;
the app decodes the fixtures with its own decoders (`ProtocolFixtureTests.swift`), and
`check-app.mjs` holds its accepted API version and feature gates to `versions.json`. Changes
are additive only: a field may be added, never removed, retyped or made nullable, because
installed apps decode strictly.

## Commands

`mise tasks` lists them all. Without mise, each is the command in `mise.toml`; the root
`package.json` forwards the familiar `pnpm dev`, `pnpm test`, `pnpm build` … to `apps/server`
(its `build` links new dependencies first, so it's the safe one after a pull).

| | |
|---|---|
| `mise run setup` | `pnpm install` at the root (the workspace: builds node-pty, generates Prisma); on macOS also `ios:bootstrap` |
| `mise run server:dev` · `server:start` | The server on 127.0.0.1:7681 (dev: `--watch` and Vite) |
| `mise run server:typecheck` · `server:build` · `server:test` · `server:test:ui` · `server:prisma` | Typecheck, web build, server tests (real tmux), the page in Chromium, schema vs migrations |
| `mise run ios:static` · `ios:coverage` | The app's portable static checks; every server route reachable from the app |
| `mise run ios:test:core` | `swift test` on the portable package (Linux or macOS) |
| `mise run ios:bootstrap` · `ios:build` · `ios:test` | Generate the Xcode project; simulator + Mac Catalyst build; `verify.sh` (simulator unit + UI tests) — macOS |
| `mise run protocol:check` · `protocol:update` | The contract in `packages/protocol`: check both sides against it; regenerate it from a disposable host |
| `mise run integration` · `integration:review` | The app against a disposable real host built from this checkout |
| `mise run check` | Everything this machine can run, then what it couldn't and why |

## A change on both sides

1. Change the server, additively. A new ability gets a `features.ts` entry (or a version bump
   of its feature); never change `API_VERSION`.
2. `mise run protocol:update`, then review `git diff packages/protocol`: that diff is the API
   change.
3. Change the app: its call, its decoding (optional for anything an older host doesn't
   send), and gate it on `supports(...)` so it still works against an older host.
4. `mise run protocol:check` (pins, fixtures, the app's version and gates, and every route
   reachable from the app), `mise run ios:test:core` (the app decodes the new fixtures),
   `mise run integration`, then `mise run check`.
5. Land server and app in one stack, server layers first.

## Boundaries that don't move

- The server binds loopback only and never changes its own exposure; no plain-http fallback.
- Restarting `ah` never ends sessions: tmux belongs to `ah-tmux.service`.
- Never spoof Origin or Tailscale identity headers, reuse the host's CLI token in the app,
  or loosen admission (`apps/server/server/admission.ts`) outside its tests.
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
