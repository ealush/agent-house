# Web glass materials

The shared glass material filters content behind floating controls. Its tint
and subtle sheen are translucent; inset shadows draw the thin edges. The old
rim gradient used `border-box`, which paints the whole box, so it also sat
under the interior and washed out the backdrop. The sidebar separately used
an opaque fill and had no backdrop filtering.

The material now has three densities: small chrome, sidebar panels, and
reading sheets. Chrome retains color and movement from its backdrop; sheets
use more tint to protect longer text. Secondary labels use stronger ink.
The composer settings sheet shares one backdrop rather than stacking a second
frosted header over it. Conversation text and the writing surface remain on
their regular reading grounds.

The sidebar's backing pseudo-element owns its filter. Putting the filter on
the sidebar itself would establish a containing block for its fixed menus,
breaking their viewport placement. A pane chooser also takes focus in a layout
effect before its first paint: its existing two-frame focus recovery is kept,
but no longer delays the first keystroke while glass is being composited.

Reduced-transparency and increased-contrast preferences use solid materials;
increased contrast adds a stronger edge. A browser without backdrop-filter
support also gets solid fills. All colors still derive from the existing
theme tokens, including Omarchy's palette.

## Evidence and limits

`test/ui/glass.test.ts` paints the production CSS over changing backgrounds
and reads screenshot pixels. It checks transmission, real blur, small-label
contrast over black and white content, the solid high-contrast fallback, and
viewport placement of a fixed sidebar menu. `AH_GLASS_SHOTS` saves material
previews. `AH_GLASS_CSS_REF=474a393` reproduces the previous material for comparison.

Verified locally on 2026-10-26: typecheck, 19 design/theme/hover checks, and
all 42 Chromium UI checks pass. The UI run includes seven material paint and
contrast checks, the six composer flows, and the existing desktop/phone/iPad
smoke suite. The first-keystroke pane regression passes with the focus fix.

In the local Linux WPE WebKit captures, backdrop filtering is not visible even
though computed styles report it; both the project's r2370 and a separate
r2376 check show this. Its transmission and solid-fallback checks are useful,
but these captures cannot establish Safari's visual blur. Physical Safari/PWA
inspection is still needed. No native refraction or on-device check is claimed.

## Platform references

- [MDN backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter):
  transparent fills and the boundaries that limit backdrop sampling.
- [WebKit's Safari 18 notes](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/):
  Safari supports unprefixed backdrop filters; both spellings remain in the CSS.
- [WebKit SVG backdrop reference tracking](https://bugs.webkit.org/show_bug.cgi?id=317059):
  SVG displacement chains are not a dependable Safari enhancement. This pass
  uses standard CSS filter functions, without duplicated scenes or filter animations.
