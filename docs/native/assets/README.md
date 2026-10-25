# App icon sources

`app-icon-light.svg`, `app-icon-dark.svg` and `app-icon-tinted.svg` are the sources of `App/Assets.xcassets/AppIcon.appiconset`: the setup screen's mark (three linked rings) in white on the brand pink, pink on near-black for dark mode, and white on black for the tinted home screen.

To rebuild each 1024 × 1024 PNG: `rsvg-convert -w 1024 -h 1024 app-icon-light.svg -o AppIcon.png`.
