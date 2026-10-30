"""Render icon-180.png (market icon) from the same motif as icon.svg, using Pillow.

The marketplace requires a GitHub-hosted bitmap icon; this script keeps the PNG
reproducible without an SVG rasterizer. Coordinates mirror icon.svg (128x128).
"""
from PIL import Image, ImageDraw
import numpy as np

S = 6  # integer supersample: 128 * 6 = 768px canvas, then downscale to 180
N = 128 * S
c0 = np.array([0x3B, 0x3F, 0xD8], float)
c1 = np.array([0x6C, 0x8C, 0xF5], float)
t = np.linspace(0.0, 1.0, N)[:, None]
t = (t + t.T) / 2.0  # diagonal blend
grad_arr = (c0[None, None, :] * (1 - t[:, :, None]) + c1[None, None, :] * t[:, :, None]).round().astype(np.uint8)
grad = Image.fromarray(grad_arr, "RGB").convert("RGBA")

mask = Image.new("L", (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([4 * S, 4 * S, 124 * S, 124 * S], radius=28 * S, fill=255)
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
d.rounded_rectangle([22 * S, 34 * S, 106 * S, 96 * S], radius=10 * S, fill=(255, 255, 255, 247))
d.rounded_rectangle([22 * S, 34 * S, 106 * S, 50 * S], radius=8 * S, fill=(207, 216, 255, 255))
for cx, col in ((32, (0x3B, 0x3F, 0xD8)), (42, (0x8A, 0x9B, 0xF0)), (52, (0xC3, 0xCC, 0xF8))):
    d.ellipse([(cx - 3) * S, 39 * S, (cx + 3) * S, 45 * S], fill=col + (255,))

bars = ((32, 72, 16, (0x3B, 0x3F, 0xD8)), (49, 62, 26, (0x5D, 0x6E, 0xF0)),
        (66, 56, 32, (0x8A, 0x9B, 0xF0)), (83, 66, 22, (0xC3, 0xCC, 0xF8)))
for x, y, h, col in bars:
    d.rounded_rectangle([x * S, y * S, (x + 10) * S, (y + h) * S], radius=3 * S, fill=col + (255,))

# pin: draw upright around (92,78) on its own layer, then rotate -35 degrees
layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
ld = ImageDraw.Draw(layer)
cx, cy = 92 * S, 78 * S
gold, ink = (255, 176, 32, 255), (0x3B, 0x3F, 0xD8, 255)
ld.rounded_rectangle([cx - 4 * S, cy - 16 * S, cx + 4 * S, cy + 2 * S], radius=3 * S, fill=gold, outline=ink, width=3 * S)
ld.rounded_rectangle([cx - 8 * S, cy - 22 * S, cx + 8 * S, cy - 13 * S], radius=4 * S, fill=gold, outline=ink, width=3 * S)
ld.rounded_rectangle([cx - 2 * S, cy + 1 * S, cx + 2 * S, cy + 17 * S], radius=2 * S, fill=gold, outline=ink, width=3 * S)
layer = layer.rotate(-35, resample=Image.BICUBIC, center=(cx, cy))
img.alpha_composite(layer)

img = img.resize((180, 180), Image.LANCZOS)
img.save(r"D:\DSH-Workspace\dsh-usage-watch\docs\icon-180.png", optimize=True)
print("icon-180.png written", img.size)
