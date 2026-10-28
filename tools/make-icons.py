#!/usr/bin/env python3
"""Generate the matching neon-wave PWA and Android launcher icons.

Requires Pillow. Draw at 4x and downsample so small launcher icons remain crisp.
Usage: python tools/make-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'icons')
SS = 4
BG = (10, 9, 21, 255)


def mix(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def draw_logo(size, full_bleed=False):
    width = size * SS
    img = Image.new('RGBA', (width, width), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    margin = 0 if full_bleed else int(width * .055)
    radius = int(width * .22)
    d.rounded_rectangle((margin, margin, width - margin, width - margin),
                        radius=radius if not full_bleed else 0, fill=BG)
    if not full_bleed:
        d.rounded_rectangle((margin, margin, width - margin, width - margin),
                            radius=radius, outline=(52, 42, 76, 255), width=max(2, width // 150))

    # The safe zone leaves room around the mark when Android masks the icon.
    mark = Image.new('L', (width, width), 0)
    md = ImageDraw.Draw(mark)
    bar_width = width * .065
    gap = width * .112
    heights = (.15, .32, .50, .32, .15)
    for i, height in enumerate(heights):
        cx = width * .5 + (i - 2) * gap
        h = width * height
        md.rounded_rectangle((int(cx - bar_width / 2), int(width * .5 - h / 2),
                              int(cx + bar_width / 2), int(width * .5 + h / 2)),
                             radius=int(bar_width / 2), fill=255)

    gradient = Image.new('RGBA', (width, width))
    gd = ImageDraw.Draw(gradient)
    pink, violet, cyan = (240, 48, 162), (163, 103, 246), (67, 207, 249)
    for x in range(width):
        t = x / max(1, width - 1)
        color = mix(pink, violet, min(1, t * 2)) if t < .5 else mix(violet, cyan, (t - .5) * 2)
        gd.line((x, 0, x, width), fill=(*color, 255))
    glow = gradient.copy()
    glow.putalpha(mark.filter(ImageFilter.GaussianBlur(width * .035)).point(lambda v: int(v * .55)))
    img = Image.alpha_composite(img, glow)
    gradient.putalpha(mark)
    img = Image.alpha_composite(img, gradient)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ('icon-192.png', 192, False), ('icon-512.png', 512, False),
        ('icon-maskable-512.png', 512, True), ('apple-touch-icon.png', 180, True)
    ]
    for name, size, full_bleed in jobs:
        draw_logo(size, full_bleed).save(os.path.join(OUT, name))
        print('wrote', os.path.join('public/icons', name))
    for bucket, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        directory = os.path.join(ROOT, 'apk-src', 'res', 'mipmap-' + bucket)
        os.makedirs(directory, exist_ok=True)
        draw_logo(size, True).save(os.path.join(directory, 'ic_launcher.png'))
        print('wrote', os.path.join('apk-src/res', 'mipmap-' + bucket, 'ic_launcher.png'))


if __name__ == '__main__':
    main()
