# Mobile chat composer

The mobile composer is a writing surface with a stable action row. Session
configuration is available when requested, instead of wrapping into the space
where a person is trying to write. Desktop keeps its model, effort and permission
chips and its keyboard workflow.

## References and decisions

- [Apple Messages](https://support.apple.com/en-gb/guide/iphone/iph82fb73ba3/26/ios/26):
  text entry and Send are central; Add opens secondary capabilities. Adopt a
  single Add affordance for files and message recall.
- [Astryx ChatComposer](https://github.com/facebook/astryx/blob/main/packages/core/src/Chat/ChatComposer.tsx)
  and [its input contract](https://github.com/facebook/astryx/blob/main/packages/core/src/Chat/ChatComposerInput.spec.md):
  separate the writing surface, supporting controls and delivery state. Protect
  composition, draft history and selection; file intake remains the app's job.
- [assistant-ui mobile composer](https://www.assistant-ui.com/elements/mobile-composer):
  adapt controls to mobile input and response state. In ah, a working agent can
  queue a follow-up, so the action says Queue rather than pretending to send it
  immediately. Stop remains available when the input is empty.
- [shadcn input groups](https://ui.shadcn.com/docs/components/base/input-group):
  compose the textarea and footer as one surface with an intentional focus order.
  Use the existing app components and tokens; no new UI dependency is required.

## Interaction

- A touch-first session has a bounded, growing textarea, an Add button, a compact
  current-model control, optional supported dictation and a 44px delivery action.
- Model, effort and permissions open in a sheet; the draft stays in place.
  Dangerous permission modes remain visible on the trigger and retain existing
  confirmation behavior.
- Software-keyboard Return inserts a paragraph. Hardware Enter sends, Shift+Enter
  inserts a line. IME confirmation never submits.
- Send retains editing focus. It does not autofocus a phone when opening a session.
- Recall can return to the draft that was there before browsing message history.
- Attachments still upload to the real host before sending. Refused sends restore
  text and attachments through the existing delivery flow.
- Text remeasures when its width changes, including rotation and tablet resizing.
- On mobile, the header and composer float over the conversation with live
  backdrop blur. Their measured heights reserve scroll insets, including draft
  growth and queued messages. The last response and Latest action stay clear.
- Panel tabs step aside while the software keyboard is open. Back and the
  conversation menu remain available. Desktop and terminal layout keep their
  existing flow.

## Mobile interface findings

The earlier layout put its title/status, GUI/terminal switch and panel tabs
above the conversation. On a phone those were two persistent rows. Combined with
the previous wrapping composer toolbar, navigation and configuration competed
with the conversation at both ends of the screen. A native-feeling chat should
give those tasks different levels of prominence.

The composer now prioritizes writing. The mobile conversation uses a measured
overlay header and hides its panel strip while the keyboard is open. Back,
agent status and the conversation menu remain available. Message actions,
reading older turns during streaming and returning to the latest response
still need an on-device interaction review before claiming the whole mobile
chat experience is finished.

## Verification

`test/ui/composer.test.ts` exercises the real page and HTTP API against a
disposable host and the existing transcript fixture. It covers small phones,
portrait/landscape, iPad, desktop, editing, sending, upload failure recovery and
settings navigation. `AH_COMPOSER_SHOTS` saves review screenshots.

Local evidence (2026-10-25): typecheck passes; `npm test` passes 533 tests;
the existing Chromium smoke suite passes 29 tests; the composer suite passes
six tests in Chromium. The five mobile composer cases also pass in headless
WebKit, including queue contents verified through the host API. Desktop
headless WebKit times out while booting both this branch and unchanged `main`
in this Linux environment; no desktop Safari verification is claimed.

Combined release evidence (2026-10-26): typecheck and all 43 Chromium browser
checks pass, including the seventh composer case for the real conversation
behind the mobile overlays. The same release's backend passed 552 tests and
the native Swift client passed 33 integration tests against a disposable host.
See [release evidence](releases/2026-10-26-mobile-native.md) and screenshots.

Browser emulation is not a physical iPhone/iPad check. Before shipping, verify
Safari and the home-screen app with the actual keyboard: dictation/autocorrect,
selection, keyboard dismissal, rotation and custom-model entry in the sheet.

This pass changes the live-session GUI composer. The terminal, ended-session
resume input and side-chat composer remain separate surfaces.
