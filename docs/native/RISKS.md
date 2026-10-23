# Risks and outstanding gates

| Priority | Gate | Next proof |
| --- | --- | --- |
| P0 | No Xcode or simulator on Linux machine | Portable core compiled/tested with an isolated Swift 6.2 toolchain. Run bootstrap and verify on macOS; UIKit/GRDB compilation and native journeys remain unverified. |
| P0 | Browser-centric authentication | Add an explicit scoped native pairing/credential contract and adversarial tests in the backend; preserve Host, Tailscale ownership, browser Origin/CSRF and revocation checks. |
| P0 | Private-host passkeys | Verify Associated Domains/webcredentials feasibility for the actual `.ts.net` host, or use authenticated pairing. No entitlement is provisioned. |
| P0 | No live REST/SSE/WS implementation | Pure DTO/reducer/SSE frame code now exists. Prove auth → live state snapshot/patch → mutation → visible result → revoke. Avoid automatic replay of sends/approvals on reconnect. |
| P0 | Terminal not evaluated | Prove a real ANSI renderer and exact current wire protocol with live disposable tmux sessions and multiple viewers. Interfaces alone are not terminal parity. |
| P0 | APNs/signing absent | Configure app ID, team and environment-specific entitlements, token lifecycle and minimal host APNs support. Existing VAPID push is not APNs. |
| P0 | Only metadata restoration exists | Add routes, selected session/panel/stack, workspace layout and scroll context as implemented; reconcile with server truth after termination/relaunch. |
| P1 | Sensitive local caches | Add account-bound encryption/Keychain access and cleanup before persisting drafts, transcript content or tokens. GRDB alone is not encryption. |
| P1 | Preview authentication/origin isolation | Validate WKWebView proxy auth, navigation policy, cookie isolation, HMR and non-public exposure. |
| P1 | iPad keyboard conflicts and focus | All 89 source commands need deliberate UIKit mapping, contextual availability and hardware verification. No keyboard parity is claimed. |
| P1 | Review confidence and exact-head merge | Preserve reviewed base/head evidence, findings and checks; fresh server gate and explicit user merge action. |
| P1 | Source drift | Compare SOURCE.json before porting. The older keyboard spec says 84, actual executable catalog has 89. Open web features must not be represented as shipped parity. |
| P1 | SSE has no sequence/revision IDs | Parser/reducer tests cannot establish gap detection. Reset every connection and coordinate polling/foreground resync before connecting live state; see TRANSPORT.md. |
| P2 | Release packaging | Supply native icons, privacy review, APNs/associated-domain configuration and distribution signing when the app is ready. |

