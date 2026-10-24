# Risks and outstanding gates

Updated 24 October 2026.

| Priority | Gate | State and next proof |
| --- | --- | --- |
| P0 | **No Apple build has run.** This machine is Linux: no Xcode, iOS SDK or simulator. | Every non-UI source compiles and is tested on Linux (Swift 6.2): 130 unit tests and 18 integration tests against a real disposable `ah`. The UIKit/SwiftUI layer (`Sources/Features`, `Sources/Platform`, `App`) has only been syntax-checked (`swiftc -parse`) and cross-referenced against model declarations; it has **never been type-checked**. Expect a round of compile fixes on the first `./scripts/verify.sh` on a Mac. Then run the UI tests and the device matrix in TEST-MATRIX. |
| P0 | Signing, APNs key and provisioning need the account owner | `Config/AgentHubNative.entitlements` declares `aps-environment` and time-sensitive notifications; a team ID, bundle ID, APNs auth key (`.p8`, key ID, team ID, topic) and a device are needed. The host side is built and tested with a loopback fake APNs gateway; real delivery is unverified. |
| P0 | Backend branches are local | `ah` `native/1-device-auth` (native enrollment, bearer sessions, device removal, preview session) and `native/2-apns` pass the full `ah` suite (552) and typecheck; they're committed locally, not pushed or reviewed. The app requires them on the host. |
| P0 | Secure Enclave and Face ID behavior | Built against documented APIs (`SecureEnclave.P256.Signing.PrivateKey`, `SecAccessControl` `.userPresence`); the simulator falls back to a software key. Needs a device check: enrollment, sign-in prompt, lock, key loss after passcode removal. |
| P1 | `ah` window-creation race | Two concurrent `POST /api/windows` on one host can collide on a tmux session name (observed in integration; suites run serially). Native creates one at a time, but two devices could still race. Fix belongs in `ah`. |
| P1 | Linux toolchain lacks `URLSessionWebSocketTask` | FoundationNetworking in the Linux toolchain was built without WebSocket support, so integration tests use a test-only raw WebSocket client. The app's `URLSessionTransport` WebSocket path is exercised only on Apple platforms. |
| P1 | Keyboard on real hardware | All 89 commands route through tested `SceneModel` logic; the `UIKeyCommand` mapping, `canPerformAction` deferral to text/terminal, Colemak/physical-key handling and system-shortcut conflicts need an iPad with a hardware keyboard. |
| P1 | Review confidence | Exact-head merge re-syncs and refuses a moved head; "No checks reported" is never treated as passing; nothing is marked reviewed for you. Needs a disposable GitHub stack fixture to verify end to end. |
| P2 | Preview isolation | Non-persistent `WKWebView` with a host-only preview cookie; HMR/WebSocket behavior through the proxy needs a device check. |
| P2 | Release packaging | App icon, privacy manifest review, App Store metadata and distribution signing. |
