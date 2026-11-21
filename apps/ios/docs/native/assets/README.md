# App icon sources

`scripts/app-icon.py` draws `App/Assets.xcassets/AppIcon.appiconset` (light, dark, tinted) and the setup screen's `AppMark`: `=>` stood on its end, an arrow up that reads as a house, the chevron its roof and the two bars its walls. `python3 scripts/app-icon.py` rewrites them (needs Pillow); `--preview out.png` draws one sheet to look at.

`app-icon-light.svg`, `app-icon-dark.svg` and `app-icon-tinted.svg` are the same drawing as vectors, for the README and anywhere else that wants it: white on ah's pink, pink on near-black for dark mode, and white on black for the tinted home screen. The sidebar's wordmark draws the same lines in code (`AhMark` in `Sources/Features/Shell/MainViews.swift`), and ah's web app carries them in `web/public/icon.svg`. Keep them in step with the script.
