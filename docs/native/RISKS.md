# Risks and outstanding gates

Updated 25 October 2026.

| Priority | Gate | State and next proof |
| --- | --- | --- |
| P0 | **The screens haven't been exercised.** | The app builds with Xcode 27.1, and `./scripts/verify.sh` passes on an iOS 27 simulator (25 October 2026, by hand on the owner's Mac; the GitHub `Native checks` job can't start until Actions billing is fixed). The 2 UI tests cover setup only. No one has walked setup → Inbox → session → terminal against a real host (gate G-0), and none of the workspace spec's pointer, hover or hardware-keyboard behavior has been seen running. Next: the G-0 walk on a simulator against a loopback `ah` on the native branches, then the device matrix in TEST-MATRIX. |
| P0 | Signing, APNs key and provisioning need the account owner | `Config/AgentHubNative.entitlements` declares `aps-environment` and time-sensitive notifications; a team ID, bundle ID, APNs auth key (`.p8`, key ID, team ID, topic) and a device are needed. The host side is built and tested with a loopback fake APNs gateway; real delivery is unverified. |
| P0 | Backend branches are local | `ah` `native/1-device-auth` (native enrollment, bearer sessions, device removal, preview session) and `native/2-apns` pass the full `ah` suite (552) and typecheck; they're committed locally, not pushed or reviewed. The app requires them on the host. |
| P0 | Secure Enclave and Face ID behavior | Built against documented APIs (`SecureEnclave.P256.Signing.PrivateKey`, `SecAccessControl` `.userPresence`); the simulator falls back to a software key. Needs a device check: enrollment, sign-in prompt, lock, key loss after passcode removal. |
| P1 | `ah` window-creation race | Two concurrent `POST /api/windows` on one host can collide on a tmux session name (observed in integration; suites run serially). Native creates one at a time, but two devices could still race. Fix belongs in `ah`. |
| P1 | Linux toolchain lacks `URLSessionWebSocketTask` | FoundationNetworking in the Linux toolchain was built without WebSocket support, so integration tests use a test-only raw WebSocket client. The app's `URLSessionTransport` WebSocket path is exercised only on Apple platforms. |
| P1 | Keyboard on real hardware | All 89 commands route through tested `SceneModel` logic; the `UIKeyCommand` mapping, `canPerformAction` deferral to text/terminal, Colemak/physical-key handling and system-shortcut conflicts need an iPad with a hardware keyboard. |
| P1 | Review confidence | Exact-head merge re-syncs and refuses a moved head; "No checks reported" is never treated as passing; nothing is marked reviewed for you. Needs a disposable GitHub stack fixture to verify end to end. |
| P2 | Preview isolation | Non-persistent `WKWebView` with a host-only preview cookie; HMR/WebSocket behavior through the proxy needs a device check. |
| P2 | Release packaging | App icon, privacy manifest review, App Store metadata and distribution signing. |
