// The transcript's end, read from where its scroll view says it is. The numbers are the
// scroll geometry an iPhone and an iPad logged (`ScrollGeometry`): the container is what's
// left between the insets, so a transcript at its end reads as at it, not the bars' height
// away. Features is the app's alone, so this runs in the app's tests, not the package's.
#if !SWIFT_PACKAGE
import SwiftUI
import Testing
@testable import AgentHubNative

private func insets(top: CGFloat, bottom: CGFloat) -> EdgeInsets {
    EdgeInsets(top: top, leading: 0, bottom: bottom, trailing: 0)
}

@Test func aLongTranscriptAtItsEndUnderAPhonesBarsIsAtTheEnd() {
    // A phone's navigation bar above (116) and the composer below (87).
    #expect(TranscriptEnd.below(contentHeight: 956, offset: 169, room: 671, insets: insets(top: 116, bottom: 87)) == 0)
    // Scrolled back half a screen, the end is that far below.
    #expect(TranscriptEnd.below(contentHeight: 956, offset: -167, room: 671, insets: insets(top: 116, bottom: 87)) == 336)
}

@Test func aLongTranscriptAtItsEndUnderAnIPadsComposerIsAtTheEnd() {
    #expect(TranscriptEnd.below(contentHeight: 2170, offset: 1333, room: 837, insets: insets(top: 0, bottom: 53)) == 0)
}

@Test func aShortConversationSatByTheComposerIsAtTheEnd() {
    // The scroll view sits a short conversation down by the composer with a top inset as
    // tall as the space above it: resting there, the end is in view.
    #expect(TranscriptEnd.below(contentHeight: 128, offset: -659, room: 671, insets: insets(top: 659, bottom: 87)) == 0)
    // Before the insets are in, the same.
    #expect(TranscriptEnd.below(contentHeight: 150, offset: 0, room: 671, insets: insets(top: 0, bottom: 0)) == 0)
}
#endif
