#!/usr/bin/env python3
"""Create web and Android icons from the supplied Trill Tuner artwork.

Requires Pillow: python -m pip install Pillow
Usage: python tools/make-icons.py

The maskable PWA icon adds a black margin so the artwork stays visible when a
launcher applies a circular or rounded mask. Other icons use the full image.
"""
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools' / 'assets' / 'trill-tuner-icon.webp'
OUT = ROOT / 'public' / 'icons'


def make_icon(source, size, maskable=False):
    if maskable:
        # Leave a safe area around the image for Android's adaptive masks.
        inset_size = round(size * 0.76)
        icon = Image.new('RGB', (size, size), (0, 0, 0))
        art = ImageOps.fit(source, (inset_size, inset_size), Image.Resampling.LANCZOS)
        offset = (size - inset_size) // 2
        icon.paste(art, (offset, offset))
        return icon
    return ImageOps.fit(source, (size, size), Image.Resampling.LANCZOS)


def main():
    with Image.open(SOURCE) as opened:
        source = ImageOps.exif_transpose(opened).convert('RGB')
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in [
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('icon-maskable-512.png', 512, True),
        ('apple-touch-icon.png', 180, False),
    ]:
        path = OUT / name
        make_icon(source, size, maskable).save(path, optimize=True)
        print('wrote', path.relative_to(ROOT))
    for bucket, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96),
                         ('xxhdpi', 144), ('xxxhdpi', 192)]:
        path = ROOT / 'apk-src' / 'res' / ('mipmap-' + bucket) / 'ic_launcher.png'
        path.parent.mkdir(parents=True, exist_ok=True)
        make_icon(source, size).save(path, optimize=True)
        print('wrote', path.relative_to(ROOT))


if __name__ == '__main__':
    main()
