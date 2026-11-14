# Conversation layout

How a session's conversation screen is put together: who owns the space, the keyboard, the scroll
position and the state behind them. Read this before changing the session screen, the composer,
the queue or the transcript. The rules below exist because their absence produced a run of
regressions (a gap under the composer, the composer under the keyboard, a blank transcript, the
queue over the navigation bar), each fixed in one place and broken again in another.

## The hierarchy

```
UIWindowScene
└─ SceneRootController                                   UIKit
   ├─ phone: UITabBarController › UINavigationController › SessionHostController
   │         (UIHostingController; safeAreaRegions = .container: SwiftUI never sees the keyboard)
   └─ iPad:  UISplitViewController › detail UIHostingController (DetailView ignores the keyboard
             at its root while it shows sessions or panes)
      └─ SessionScreen                                   SwiftUI: header, ended banner, panels,
         │                                               sheets, alerts, Quick Look
         ├─ gui:      ConversationSurface › ConversationController            UIKit container
         │            ├─ transcript: UIHostingController › TranscriptCollection (rail, ↓, empty
         │            │              states, keys) › TranscriptController (UICollectionView)
         │            ├─ dock:       UIHostingController › ComposerDock › ComposerView (queue,
         │            │              attachments, box)
         │            └─ float:      UIHostingController › ComposerFloat (suggestions, settings)
         ├─ terminal: AboveKeyboard › TerminalScreen
         └─ panel (iPad, beside): AboveKeyboard › PanelView
```

## Who owns what

| Concern | Owner | How |
|---|---|---|
| The screen's bounds and safe area | UIKit (navigation, split, tab controllers) | As UIKit lays them out; SwiftUI places the session screen in them. |
| The keyboard | `ConversationController` (conversation), `AboveKeyboard` (terminal, panels, chooser) | `view.keyboardLayoutGuide`. Nothing else reads the keyboard. Every hosting controller in the session screen leaves `.keyboard` out of its `safeAreaRegions`, so SwiftUI never moves anything for it. |
| Space between transcript and dock | `ConversationController` | The transcript fills the view. The dock stands on the keyboard guide. The transcript's bottom inset is the dock's top, set in the same layout pass. |
| The dock's height | The dock's own content | `ComposerDock` reports its height at the dock's width (`fixedSize` + `onGeometryChange`). The controller sets it as a constraint, animated. It never depends on the dock's frame. |
| The queue's height | `QueueTrayView`, from `ConversationRoom.available` | The room is computed from the keyboard guide and the safe area only, never from the dock, so it can't feed back. |
| Transcript insets and position | `TranscriptController` | One anchor (the end, or a row being read and its distance from the top), applied on every layout before drawing. The controller hands it insets; it never measures SwiftUI geometry. |
| Focus | `SceneModel` (see ARCHITECTURE.md) | Unchanged. |

## Invariants

1. The keyboard is accounted for exactly once, by UIKit's keyboard layout guide. There's no
   keyboard notification math, keyboard height state or custom keyboard animation anywhere.
2. The dock's bottom edge is the keyboard guide's top: the keyboard's top when it's docked, or
   the bottom of the safe area when it's hidden, floating, split or minimized. The guide follows
   the keyboard's animations and an interactive dismissal under the finger, and counts only the
   part of the keyboard over the window (Split View, Stage Manager).
3. The transcript's last row ends at the dock's top. The transcript runs on under the dock and
   the bars, and its insets keep the rows clear of them.
4. Only the dock's content decides its height, and nothing else depends on that height except its
   own frame and the transcript's inset.
5. The queue never takes more than its share of the room, and scrolls inside that share. With too
   little room it folds to its one line, which opens the Queue panel.
6. Nothing in the conversation is positioned by timing. No `asyncAfter`, `Task.sleep` or "again
   after the next layout" moves the transcript or the dock.
7. A geometry value written into observable state is written by one owner, never read back by
   that owner in a tracked method, and never feeds the size of what it was measured from.

## Sizing the dock

The room is `ConversationRoom.available`: from the top of the conversation (under the bars) down to
the keyboard guide. It's written by `ConversationController` from the guide and the safe area
alone. Everything in the dock is sized from the room and its own content, in this order of
priority:

1. **The box** keeps at least one line, and grows to its eight lines only into room the
   transcript can spare. Its cap is the room less the queue's line, the attachments and the
   transcript's 120 pt (below 300 pt of room, the transcript's share goes first). Past the cap,
   the text scrolls inside the box.
2. **The queue** gets at most 45% of the room, and never so much that the transcript keeps less
   than 120 pt beside the box. Its line stays put; the list (with uploads and any error) scrolls
   inside what's left of that share, and the "more" row stays below it. With less than 110 pt for
   it, the queue keeps to its line, which opens the Queue panel. With less than 170 pt of room in
   all (a phone on its side, the keyboard up), even the line gives way to the box; the queue is
   in its panel and the session menu's Send Queued Now. Whether it's opened all the way is kept
   on the session's queue (`QueueModel.expanded`), so navigation and model changes leave it be.
3. **The attachments** sit inside the box, above the text, at their own height: never over the
   queue, which is above the box.
4. **The dock** is as tall as all of that. If the room is still too small, the dock is squeezed
   and clips at its top rather than draw over the bars.

## Diagnostics

Debug builds launched with `-AHLayoutProbe` record the conversation's geometry after every layout
and scroll: bounds, safe area, the keyboard guide, the dock and float frames, the room, and the
transcript's offset, content size, insets and anchor. No text is recorded. The record goes to the
log (subsystem `dev.ealush.ah.native`, category `layout`) and to the value of a hidden accessibility
element, `layout-probe`, which the layout tests read. `-AHLayoutHUD` also draws it in a corner of
the screen.

## Tests

`Tests/UI/ConversationLayoutUITests.swift` measures the screen against a demo host it drives
itself (`scripts/demo/host.mjs`; the demo agent's `/stream`, `/burst` and `/long`). See the file
for the cases. It also checks that the transcript is drawn, from the screenshot's pixels, because
a blank transcript still lists its rows to accessibility.

## References

- UIKeyboardLayoutGuide: https://developer.apple.com/documentation/uikit/uikeyboardlayoutguide
  (`usesBottomSafeArea`, `keyboardDismissPadding`, `followsUndockedKeyboard`)
- WWDC23 "Keep up with the keyboard" (10281), the guide as the recommended approach, used by
  Messages, tracking dismiss gestures: https://developer.apple.com/videos/play/wwdc2023/10281/
- WWDC21 "Your guide to keyboard layout" (10259): https://developer.apple.com/videos/play/wwdc2021/10259/
- UIHostingController `safeAreaRegions` ("Disabling a safe area region omits it from the SwiftUI
  layout system altogether"): https://developer.apple.com/documentation/swiftui/uihostingcontroller/safearearegions
- UIHostingController `sizingOptions` (ideal size from an unspecified proposal, hence not used for
  the width-dependent dock): https://developer.apple.com/documentation/swiftui/uihostingcontroller/sizingoptions
- Containment: https://developer.apple.com/documentation/uikit/creating-a-custom-container-view-controller
- Automatic observation tracking in UIKit (`updateProperties`, tracked layout methods):
  https://developer.apple.com/documentation/uikit/automatic-observation-tracking
- `UIView.AnimationOptions.flushUpdates`: https://developer.apple.com/documentation/uikit/uiview/animationoptions/flushupdates
- Diffable reconfigure vs reload (WWDC21 10252): https://developer.apple.com/videos/play/wwdc2021/10252/
- Lazy stacks estimate their content (WWDC26 321, "Group Lab"); the reason the transcript isn't a
  ScrollView over a LazyVStack any more.
