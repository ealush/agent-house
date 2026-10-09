// Positioning for floating (portalled) menus: open below the anchor, flip
// above it when there is no room, and clamp horizontally into the viewport.
export type AnchorRect = { top: number; right: number; bottom: number };
export type Box = { width: number; height: number };
export type PlacedPoint = { top: number; left: number };

export function placeFloatingMenu(
  anchor: AnchorRect,
  menu: Box,
  viewport: Box,
  gap = 6,
  margin = 8,
): PlacedPoint {
  const left = Math.min(
    Math.max(margin, anchor.right - menu.width),
    Math.max(margin, viewport.width - menu.width - margin),
  );
  const below = anchor.bottom + gap;
  const top =
    below + menu.height <= viewport.height - margin
      ? below
      : Math.max(margin, anchor.top - gap - menu.height);
  return { top, left };
}
