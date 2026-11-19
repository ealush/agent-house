#!/usr/bin/env python3
"""Draws the app's mark and writes the app icon (light, dark, tinted) and the in-app
AppMark: `=>` stood on its end, an arrow pointing up that reads as a house (the chevron
its roof, the two bars its walls).

    python3 scripts/app-icon.py            # writes into App/Assets.xcassets
    python3 scripts/app-icon.py --preview out.png   # one sheet to look at

Needs Pillow. The same geometry is drawn in code for the sidebar's wordmark
(`AhMark` in Sources/Features/Shell/MainViews.swift): keep the two in step.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

# The mark on a 1024 grid: a chevron over two bars, round ends, one weight.
STROKE = 84
ROOF = [(268, 492), (512, 248), (756, 492)]
WALLS = [((404, 548), (404, 776)), ((620, 548), (620, 776))]
SCALE = 4  # drawn large and brought down, for clean edges


def gradient(size, stops):
    """Top-left to bottom-right through `stops` [(at 0…1, (r, g, b))]."""
    ramp = Image.new("RGB", (256, 1))
    for x in range(256):
        t = x / 255
        for (a, ca), (b, cb) in zip(stops, stops[1:]):
            if a <= t <= b:
                u = (t - a) / (b - a) if b > a else 0
                ramp.putpixel((x, 0), tuple(round(ca[i] + (cb[i] - ca[i]) * u) for i in range(3)))
                break
    # A diagonal ramp: a horizontal one on a square twice the size, turned 45 degrees.
    wide = ramp.resize((size * 2, size * 2), Image.BILINEAR)
    turned = wide.rotate(-45, resample=Image.BICUBIC)
    side = int(size * 2 / 2 ** 0.5)
    left = (size * 2 - side) // 2
    return turned.crop((left, left, left + side, left + side)).resize((size, size), Image.LANCZOS)


def mark(size, color):
    """The mark alone on a clear ground, `size` square."""
    big = size * SCALE
    k = big / 1024
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    width = round(STROKE * k)

    def line(points):
        scaled = [(x * k, y * k) for x, y in points]
        draw.line(scaled, fill=color, width=width, joint="curve")
        for x, y in scaled:  # round ends and a round peak
            draw.ellipse((x - width / 2, y - width / 2, x + width / 2, y + width / 2), fill=color)

    line(ROOF)
    for wall in WALLS:
        line(wall)
    return layer.resize((size, size), Image.LANCZOS)


LOOKS = {
    "AppIcon": ([(0, (255, 119, 165)), (0.5, (236, 50, 112)), (1, (163, 18, 74))], (255, 255, 255, 255)),
    "AppIcon-Dark": ([(0, (50, 28, 44)), (0.5, (31, 18, 30)), (1, (14, 10, 18))], (255, 79, 139, 255)),
    "AppIcon-Tinted": ([(0, (0, 0, 0)), (1, (0, 0, 0))], (255, 255, 255, 255)),
}


def icon(name, size):
    stops, color = LOOKS[name]
    ground = gradient(size, stops).convert("RGBA")
    ground.alpha_composite(mark(size, color))
    return ground.convert("RGB")


def main():
    root = Path(__file__).resolve().parent.parent / "App" / "Assets.xcassets"
    if len(sys.argv) == 3 and sys.argv[1] == "--preview":
        names = list(LOOKS)
        sheet = Image.new("RGB", (512 * len(names) + 16 * (len(names) + 1), 512 + 32 + 120), (128, 128, 128))
        for i, name in enumerate(names):
            sheet.paste(icon(name, 512), (16 + i * 528, 16))
        for i, small in enumerate([88, 60, 40, 29]):  # how it holds up small
            sheet.paste(icon("AppIcon", small), (16 + i * 110, 544))
            sheet.paste(icon("AppIcon-Dark", small), (500 + i * 110, 544))
        sheet.save(sys.argv[2])
        return
    for name in LOOKS:
        icon(name, 1024).save(root / "AppIcon.appiconset" / f"{name}.png")
    icon("AppIcon", 176).save(root / "AppMark.imageset" / "AppMark@2x.png")
    icon("AppIcon", 264).save(root / "AppMark.imageset" / "AppMark@3x.png")


if __name__ == "__main__":
    main()
