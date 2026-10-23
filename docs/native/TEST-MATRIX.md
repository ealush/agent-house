# Test matrix and evidence

Preparation environment: Linux, 23 October 2026. `swift`, `xcodegen` and `xcodebuild` are unavailable. Static source checks are the only checks runnable here. No simulator/device journey has been verified.

Scaffolding update, 24 October 2026: an isolated official Swift 6.2 Linux toolchain now allows `Package.swift` and `Tests/Core` to compile and run. All 19 portable tests passed. XcodeGen/Xcode and an Apple simulator remain unavailable; UIKit, Observation feature models, GRDB and UI tests have not been compiled/run here.

Requirement status and checked implementation scope are maintained in the specification's [completion companion](PARITY.md): [built components](PARITY.md#built-component-inventory), [specification/phase crosswalk](PARITY.md#specification-crosswalk) and [remaining detailed checks](PARITY.md#detailed-pending-work). A passed test in this matrix closes only the specific tested scope; it does not automatically complete its parent native journey.

| Check | Implementation / invocation | Status |
| --- | --- | --- |
| Destination duplicate content and case-colliding paths; metadata/plist/local Markdown link validation | `./scripts/verify.sh --static` | Run during workspace preparation; see final preparation evidence below. |
| Source provenance, original documents and source file hashes | `python3 scripts/check-workspace.py --source ../ah` | Run during workspace preparation. |
| Swift compilation and dependency resolution | `./scripts/bootstrap.sh`; `./scripts/verify.sh` | Blocked here: macOS/Xcode required. |
| Tailscale origin normalization and rejection of insecure/credential-bearing addresses | `Tests/Core/HostEndpointTests.swift` | PASS on Linux Swift 6.2; not Apple UI/auth verification. |
| Migration, reopen, independent scene rows, removal and future-version write rejection | `Tests/Unit/SceneStoreTests.swift` | Authored, not run. |
| Current PTY JSON frame compatibility and bounded scroll | `Tests/Core/TerminalInputTests.swift` | PASS on Linux Swift 6.2; no live terminal integration yet. |
| API 28 read DTOs; state-before-patch, full-array replacement, null/omitted fields, malformed events and stable identities | `Tests/Core/HubStateReducerTests.swift` | PASS on Linux Swift 6.2; synthetic contract examples, no live transport. |
| SSE byte chunk boundaries, BOM/UTF-8, line endings, multiline/empty data, comments, IDs/retry, EOF and bounds | `Tests/Core/ServerSentEventParserTests.swift` | PASS on Linux Swift 6.2; no URLSession/reconnect scheduler. |
| Setup validation visible through UIKit-hosted content | `Tests/UI/HostSetupUITests.swift` | Authored, not run. |
| Native enrollment, authorization, CSRF/browser regression and revocation closes terminal | Disposable backend + native integration | Unstarted; contract required. |
| Inbox → approve/deny; GUI/terminal → send/queue/stop; create/resume | iPhone simulator + disposable agents + device | Unstarted. |
| SSE initial state/patch, disconnect, wake resync, polling fallback | Transport tests + fault-injected server | Unstarted. |
| Terminal ANSI, Unicode, IME, selection, modifiers, resize, two viewers and reconnect | Emulator integration + hardware device | Unstarted. |
| Termination/relaunch, two iPad scenes, independent navigation and conflicting drafts | Native UI tests + hardware keyboard | Unstarted; v1 metadata journal is only groundwork. |
| iPad portrait/landscape, narrow Stage Manager, keyboard/pointer and all 89 commands | iPad/device interaction matrix | Unstarted. |
| APNs permission, token rotation/revocation, suspended delivery, badge and stable-uid routing | Signed physical iPhone/iPad | Unstarted. |
| Review → request fixes → changed head → re-review → explicit merge next | Disposable GitHub fixture stack | Unstarted. |
| Files containment/upload/download, preview isolation/HMR | Backend integration + native UI | Unstarted. |
| VoiceOver, Dynamic Type, contrast, Reduce Motion and first-keystroke focus | Accessibility inspector + physical devices | Unstarted. |

Use disposable hosts/tmux/agents and synthetic data. Never use production agents or secrets as fixtures. A view existing or a static check passing does not establish feature parity.

## Preparation evidence — 23 October 2026

- `./scripts/verify.sh --static`: PASS; 36 workspace files scanned, no exact duplicates or case collisions, scaffold/local-link/plist/provenance/89-command checks passed; shell scripts passed `bash -n`.
- `python3 scripts/check-workspace.py --source ../ah`: PASS; all 385 tracked source file hashes and both ZIP member/original-document comparisons matched.
- Both XcodeGen and CI YAML files parsed successfully; all target source/configuration paths exist. `exactVersion` was checked against the upstream XcodeGen schema. This does not establish successful project generation.
- The source executable command catalog returned 89 entries and 89 unique IDs. The separate source duplicate scan covered 388 non-generated files and found no nonempty exact duplicate groups; archive contents are duplicates of the loose port documents and were omitted from the target.
- Original `ah` Git status remains `?? port/`, matching the initial state. Native preparation is on local branch `scaffold/native-port`; no remote is configured and no commit/push/deployment was made.
- Not run: Xcode project generation, Swift compilation, XCTest/Swift Testing, simulator/device UI or live backend integration. Required Apple tools are absent on this machine.

## Scaffolding evidence — 24 October 2026

- `swift test` using official Swift 6.2 (`swift-6.2-RELEASE`, x86_64 Linux): PASS; core library compiled, 19 Swift Testing tests passed, including 12 host-validation and 9 invalid-state/patch parameterized cases. The XCTest runner's separate “0 tests” line is expected: these tests use Swift Testing.
- The toolchain was extracted into `~/.cache/ah-native-swift-validation`, alongside unpacked Ubuntu ncurses/tinfo, libxml2 and ICU runtime libraries required on this Arch Linux host. System packages and shell profiles were not modified. Invocation uses that toolchain's `usr/bin/swift test` with the two compat library directories in `LD_LIBRARY_PATH`; normal Swift installations/CI use plain `swift test`.
- `./scripts/verify.sh --static`: PASS; 43 workspace files, scaffold/link/plist/provenance/89-command checks and shell syntax checks.
- `python3 scripts/check-workspace.py --source ../ah`: PASS; baseline revision, all 385 tracked file hashes and original document/archive provenance still match.
- The UIKit unit-test target includes `Tests/Core` as well as the GRDB tests. Linux core CI was authored; neither CI job has run.
- Work remains local on `scaffold/state-foundations`. The source backend/web app is unchanged. No commit, push, remote or deployment was added.
- Not run: XcodeGen project generation, UIKit/GRDB compilation, Apple unit/UI tests, simulator/device checks, authenticated host requests or terminal/APNs integration.

