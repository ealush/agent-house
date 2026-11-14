// The transcript's end, read from where its scroll view says it is. The numbers are the
// scroll geometry an iPhone and an iPad logged (`ScrollGeometry`): the container is what's
// left between the insets, so a transcript at its end reads as at it, not the bars' height
// away. Features is the app's alone, so this runs in the app's tests, not the package's.
#if !SWIFT_PACKAGE
import SwiftUI
import Testing
import UIKit
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

@Test func aShortConversationSitsByTheComposerAndHasNowhereToScroll() {
    // A phone: 874 tall, the bar 116 over the top, the composer 87 under the bottom.
    let short = TranscriptPlacement(height: 874, top: 116, bottom: 87, content: 128)
    #expect(short.pad == 543)
    #expect(short.minOffset == -659)
    #expect(short.end == -659, "the end is where it already sits")
    #expect(short.below(-659) == 0)
}

@Test func aLongConversationEndsAboveTheComposer() {
    let long = TranscriptPlacement(height: 874, top: 116, bottom: 87, content: 956)
    #expect(long.pad == 0)
    #expect(long.end == 169)
    #expect(long.below(169) == 0)
    // The keyboard rising (336 more under the bottom) moves the end up with it.
    #expect(TranscriptPlacement(height: 874, top: 116, bottom: 423, content: 956).end == 505)
}

@Test func aRowBeingReadStaysUnderTheBar() {
    let long = TranscriptPlacement(height: 874, top: 116, bottom: 87, content: 3000)
    // The row at 1200 in the content, 40 below the bar: the view sits at 1044.
    #expect(long.offset(rowTop: 1200, fromTop: 40) == 1044)
    // A page of 800 going in above moves the row to 2000, and the view with it.
    #expect(TranscriptPlacement(height: 874, top: 116, bottom: 87, content: 3800).offset(rowTop: 2000, fromTop: 40) == 1844)
    // Never past either end.
    #expect(long.offset(rowTop: 0, fromTop: 200) == -116)
    #expect(long.offset(rowTop: 2990, fromTop: 0) == long.end)
}

/// A collection view of `count` plain rows for the transcript's layout to lay out.
@MainActor private final class Rows: NSObject, UICollectionViewDataSource {
    let count: Int
    init(_ count: Int) { self.count = count }
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { count }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        collectionView.dequeueReusableCell(withReuseIdentifier: "row", for: indexPath)
    }
}

@MainActor private func laidOut(_ count: Int, heights: [CGFloat] = []) -> (TranscriptLayout, UICollectionView, Rows) {
    let layout = TranscriptLayout()
    layout.item = { .outgoing($0.item) }
    let view = UICollectionView(frame: CGRect(x: 0, y: 0, width: 402, height: 874), collectionViewLayout: layout)
    view.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "row")
    let rows = Rows(count)
    view.dataSource = rows
    for (index, height) in heights.enumerated() { _ = layout.set(height, for: .outgoing(index)) }
    view.layoutIfNeeded()
    layout.prepare()
    return (layout, view, rows)
}

@MainActor @Test func rowsStackAtTheHeightsTheyMeasured() {
    let (layout, _, _) = laidOut(3, heights: [100, 40])
    let frames = (0..<3).map { layout.layoutAttributesForItem(at: IndexPath(item: $0, section: 0))!.frame }
    #expect(frames.map(\.minY) == [12, 130, 188], "18 between rows, 12 above the first")
    #expect(frames.map(\.height) == [100, 40, TranscriptLayout.estimate], "one not yet drawn at the estimate")
    #expect(layout.collectionViewContentSize.height == 188 + TranscriptLayout.estimate + 12)
    // A phone: the column is the width less 16 a side.
    #expect(frames[0].minX == 16 && frames[0].width == 370)
}

@MainActor @Test func aRowDrawnAtTheSameHeightLeavesTheLayoutAlone() {
    let (layout, _, _) = laidOut(1, heights: [100])
    #expect(!layout.set(100, for: .outgoing(0)))
    #expect(layout.set(120, for: .outgoing(0)))
}

@MainActor @Test func aRowThatWontSettleKeepsTheHeightItHas() {
    let (layout, _, _) = laidOut(1)
    let tries = (0..<6).map { layout.set($0.isMultiple(of: 2) ? 61 : 106, for: .outgoing(0)) }
    #expect(tries == [true, true, true, true, false, false])
}
#endif
