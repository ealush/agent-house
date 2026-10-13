# Polish audit, 14 October 2026

The findings behind BACKLOG.md's "Polish pass (14 October 2026)", ranked by how
often they'd hit someone in a working day. Every one was found by operating the
built page in Chromium (Playwright), on desktop (1280–1440 wide), iPad Pro 11 in
both orientations and iPhone 15 Pro / SE emulation, against a throwaway ah: its
own tmux socket, state and port, and fake Claude agents that write a long
Claude-shaped transcript, set hook state, draw a permission prompt, stay busy,
or resume their conversation. Emulation is not Safari on a device: touch, the
on-screen keyboard and safe areas still need a real iPhone and iPad.

## Fixed

| # | What happened | How to see it (before) | Change | Commit |
|---|---|---|---|---|
| 1 | Keys typed into New session went into the previous session's hidden terminal | Open a session, press ⌃⇧↵ within 1.5 s, type | The session's keyboard claim stops under a screen marked `data-focus-owner`; browser test | 946323a |
| 2 | A double tap on Send stopped the agent; clicking Send dropped focus (phone keyboard closed) | Agent working, GUI, double tap Send: one `/interrupt` request | Send doesn't take focus on press; Stop waits 700 ms after a send | 58e5ce6 |
| 3 | Approving from the Inbox by keyboard: the 1/2/3 drawn on choices did nothing from the card's title; answering dropped focus to the page | Inbox, ↓ then 1 | Digits work card-wide; aria-disabled keeps focus; browser test | 2de106f |
| 4 | Header said "On Linux" about your own device for ~5 s after switching to the GUI | Open a session in terminal view, switch to GUI | Server counts viewers per page id; test/viewers.test.ts | 0761ef9 |
| 5 | Send to… preselected a shell: one ⌘↵ typed a Markdown reply into bash | Send to… in a project with a shell first | Prefers an agent in the project, then any agent, then New session | 5456c91 |
| 6 | iPhone SE: session title cut to "C…"; composer chips stacked three deep | SE, open a session that needs you | Status pill leads the subtitle; chips/actions wrap together; "Effort" default label | 3710ddb |
| 7 | Typing a project's name ("acme-web") in New session said "No such folder" | New session, type a chip's name | A bare name of exactly one project resolves to it; test/projectPath.test.ts | 5c5961f |
| 8 | Long project names broke the Inbox table (overlap; title gone on iPad) and wrapped headings | A project named `a-really-long-…` | Ellipsis in bounded columns and headings, full name on hover | 6f4384d, 6d1857f, 3971532 |
| 9 | Unreachable host read "Failed to fetch" in the sidebar and a modal | Stop ah with a page open, send | web/errors.ts: plain wording for Chrome, Safari and Firefox; test | 18389c4 |
| 10 | Grouped lists repeated the project on every row; Permissions chip hid the active mode | Phone Sessions; Inbox by Project | Rows say what the agent is doing or which agent; chip names the mode | 6d1857f |
| 11 | New session's agent grid dead-ended at edges, no Home/End | ⌃⇧↵, arrows | Radio-group keys; smoke test | 3eb448a |
| 12 | Light theme secondary text 4.4:1 (below AA) | Contrast probe on times/details | #6e6e6e; design test checks both themes | e8513f3 |
| 13 | Palette showed a terminal glyph for every session; shortcut table listed ⌘ chords on Linux; 60 "Clear" buttons | ⌃⇧P → Go to; ⌃⇧/ | Agent logos; platform chords; actions on hover | 5a775e0, 0c1b40f |
| 14 | Phone Sessions tab blank with no sessions; terse empty History | First run | Shared empty state | c4744be |
| 15 | Phone action sheet's Continue in was six bare logos | ··· on a phone | Names under marks, one even row | db8075a |
| 16 | Touch placeholders named Enter/Esc; clipped Files path had no cue; "1 conversations" | Queue on a phone; iPad panel; History | Key-free touch hints; edge fade; plurals | 0761ef9, bad95cf, 2364b0f |

## Measured, not changed

- GUI session switch (click to new title, in-page): 10–20 ms at 1x CPU,
  40–90 ms at 4x; one ~100 ms long task at 4x is the first render of a
  1,700-node feed. CLS 0 on every switch.
- 40 sessions at 4x CPU: Inbox load to rows 0.9 s (long tasks 82/86/121 ms);
  switcher filtering 20–30 ms per key; opening a shell 267 ms.
- Motion: one curve, 120–300 ms, transform and opacity; with reduced motion
  only a 1 ms scrim fade remains.
- No unnamed buttons, links or fields on any desktop or phone page.
- A device that leaves a session drops out of "On …" within ~2 s.

## Checked and fine

Drafts follow you between devices (the box you're typing in wins, the other
side pulls on focus); Handoff clears once continued; ended sessions show in
place and resume with ⌃↵, keeping title, place and mode; splits, resize mode and
pane focus by keyboard; Settings in both themes; phone terminal and key bar.

## Left open

- A session's title and model label still compete in the sidebar at 260 px;
  showing the model only where it differs would be a product call.
- The phone session header carries both a GUI/terminal toggle and a "GUI" tab.
- The Inbox's permission card shows a Bash command in proportional type: the
  screen text has lost its indentation by then, so telling the command from
  its description needs the hook's structured detail.
- Real-device checks: iOS keyboard and safe areas, swipe back, hardware
  keyboards on iPad.
