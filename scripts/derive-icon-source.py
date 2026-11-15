"""Derives assets/icon-source.png from the official DeepSeek mark.

The official icon (https://fe-static.deepseek.com/chat/icon-512.png, referenced
as the apple-touch-icon / manifest icon by chat.deepseek.com) is a blue whale on
a solid white square. Windows shows icons on arbitrary backgrounds, so the white
square has to go - but naively turning white into alpha also punches holes in the
whale's white belly.

This script flood-fills from the border, so only white reachable from outside
becomes transparent; enclosed white stays opaque. The 1px anti-aliased rim is
recovered from the red channel (white 255, brand blue 78) and un-premultiplied,
which is what removes the white halo around the edge.

Run once, commit the result. The build itself only needs scripts/make-icons.js.

    python scripts/derive-icon-source.py path/to/icon-512.png

Requires Pillow and numpy. Not part of `npm install`.
"""

import sys
from collections import deque

import numpy as np
from PIL import Image

BRAND_BLUE_R = 78.0  # red channel of #4E6CFE
WHITE_CUTOFF = 244   # "white enough" to be background


def main(src: str, dst: str = "assets/icon-source.png") -> None:
    im = Image.open(src).convert("RGBA")
    arr = np.array(im).astype(np.int16)
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3]

    is_white = np.all(rgb >= WHITE_CUTOFF, axis=2)

    # Flood fill the background from every border pixel.
    bg = np.zeros((h, w), dtype=bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_white[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if is_white[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))

    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not bg[ny, nx] and is_white[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))

    alpha = np.where(bg, 0.0, 1.0)

    # Edge band = anything adjacent to a pixel of a different alpha.
    edge = np.zeros((h, w), dtype=bool)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        shifted = np.roll(np.roll(alpha, dy, axis=0), dx, axis=1)
        edge |= np.abs(shifted - alpha) > 0.5

    # Coverage estimate for the anti-aliased rim.
    r = rgb[:, :, 0].astype(np.float64)
    coverage = np.clip((255.0 - r) / (255.0 - BRAND_BLUE_R), 0.0, 1.0)
    alpha_final = np.where(edge, np.clip(coverage, 0.0, 1.0), alpha)

    # Un-premultiply against white so semi-transparent rim pixels are not white.
    a = alpha_final[:, :, None]
    a_safe = np.where(a < 1e-6, 1.0, a)
    color = np.clip((rgb.astype(np.float64) - (1.0 - a) * 255.0) / a_safe, 0, 255)
    partial = (alpha_final > 0.02) & (alpha_final < 0.995)

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[:, :, :3] = np.where(partial[:, :, None], color, rgb.astype(np.float64)).astype(np.uint8)
    out[:, :, 3] = np.round(alpha_final * 255).astype(np.uint8)

    Image.fromarray(out, "RGBA").save(dst)
    print(f"wrote {dst} ({w}x{h}); transparent pixels: {int(bg.sum())}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "assets/icon-source.png")
