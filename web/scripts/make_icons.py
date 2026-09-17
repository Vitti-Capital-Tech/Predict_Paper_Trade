#!/usr/bin/env python
"""Rasterise the Predict mark to PNG.

The SVG in web/public/favicon.svg is the source of truth for modern browsers.
Safari's apple-touch-icon and the PWA manifest still want PNGs, so this draws
the same shapes with Pillow rather than adding a headless-browser or cairo
dependency just for three files.

Drawn at 4x and downsampled, since Pillow's shape drawing is not antialiased.

  python web/scripts/make_icons.py
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public")
SIZES = {"apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512}

SS = 4  # supersample factor

BG_TOP = (18, 26, 42)
BG_BOTTOM = (8, 12, 20)
TARGET = (93, 107, 130)
PRICE = (47, 143, 239)
PRICE_TIP = (95, 176, 255)


def draw_icon(px: int) -> Image.Image:
    """Draw at `px`, using the 64x64 coordinate space of the SVG."""
    n = px * SS
    u = n / 64.0  # one SVG unit in device pixels

    # Vertical background gradient, then mask it to a rounded square.
    bg = Image.new("RGB", (n, n))
    grad = ImageDraw.Draw(bg)
    for y in range(n):
        t = y / max(1, n - 1)
        grad.line(
            [(0, y), (n, y)],
            fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)),
        )

    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=14 * u, fill=255)

    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # The target threshold a Predict market resolves against.
    d.line([(11 * u, 38 * u), (53 * u, 38 * u)],
           fill=TARGET, width=round(3.5 * u), joint="curve")

    # Price crossing it.
    pts = [(12 * u, 47 * u), (26 * u, 43 * u), (38 * u, 25 * u), (52 * u, 15 * u)]
    d.line(pts, fill=PRICE, width=round(6.5 * u), joint="curve")
    # Round the ends, which ImageDraw.line does not do.
    r = 6.5 * u / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=PRICE)

    # Tip marker.
    r = 5 * u
    d.ellipse([52 * u - r, 15 * u - r, 52 * u + r, 15 * u + r], fill=PRICE_TIP)

    return img.resize((px, px), Image.LANCZOS)


def main() -> None:
    out = os.path.abspath(OUT_DIR)
    os.makedirs(out, exist_ok=True)
    for name, px in SIZES.items():
        path = os.path.join(out, name)
        draw_icon(px).save(path, "PNG", optimize=True)
        print("wrote %-22s %dx%d  %d bytes" % (name, px, px, os.path.getsize(path)))


if __name__ == "__main__":
    main()
