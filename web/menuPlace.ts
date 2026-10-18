// Positioning for floating (portalled) menus: open below the anchor, flip
// above it when there is no room, and clamp into the visible viewport. A menu
// that fits on neither side stays at its button, on the side with more room,
// as tall as that room (it scrolls inside), as iPadOS's menus do.
// A software keyboard offsets that viewport (visualViewport.offsetTop) and
// shortens it; `top`/`left` on the box are that origin, defaulting to 0.
export type AnchorRect = { top: number; right: number; bottom: number };
export type Box = { width: number; height: number; top?: number; left?: number };
export type PlacedPoint = { top: number; left: number; maxHeight?: number };

/** The band a menu must stay inside. Pinch-zoom keeps the layout viewport. */
export function menuViewport(
  layout: { width: number; height: number },
  visual: { width: number; height: number; offsetTop?: number; offsetLeft?: number; scale?: number } | null,
): Box {
  const scale = visual?.scale ?? 1;
  if (!visual || !Number.isFinite(visual.height) || visual.height <= 0 || Math.abs(scale - 1) > 0.05) {
    return { top: 0, left: 0, width: layout.width, height: layout.height };
  }
  return {
    top: visual.offsetTop ?? 0,
    left: visual.offsetLeft ?? 0,
    width: visual.width,
    height: visual.height,
  };
}

export function placeFloatingMenu(
  anchor: AnchorRect,
  menu: Box,
  viewport: Box,
  gap = 6,
  margin = 8,
): PlacedPoint {
  const originTop = viewport.top ?? 0;
  const originLeft = viewport.left ?? 0;
  const viewRight = originLeft + viewport.width;
  const viewBottom = originTop + viewport.height;
  const left = Math.min(
    Math.max(originLeft + margin, anchor.right - menu.width),
    Math.max(originLeft + margin, viewRight - menu.width - margin),
  );
  const below = anchor.bottom + gap;
  const roomBelow = viewBottom - margin - below;
  const roomAbove = anchor.top - gap - (originTop + margin);
  if (menu.height <= roomBelow) return { top: below, left };
  if (menu.height <= roomAbove) return { top: anchor.top - gap - menu.height, left };
  if (roomBelow >= roomAbove) return { top: below, left, maxHeight: Math.max(0, roomBelow) };
  return { top: originTop + margin, left, maxHeight: Math.max(0, roomAbove) };
}
