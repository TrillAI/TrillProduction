#!/usr/bin/env python3
"""Verify the web and APK icons are derived from the checked-in artwork.

Requires Pillow and a freshly built APK. Run: python3 test/icons-test.py
"""
import importlib.util
import io
from pathlib import Path
from zipfile import ZipFile
from PIL import Image, ImageChops, ImageOps

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('make_icons', ROOT / 'tools' / 'make-icons.py')
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)

with Image.open(icons.SOURCE) as opened:
    artwork = ImageOps.exif_transpose(opened).convert('RGB')
assert artwork.width == artwork.height and artwork.width >= 512, 'source artwork must be square'


def check(image, expected, label):
    actual = image.convert('RGB')
    assert actual.size == expected.size, f'{label}: incorrect dimensions {actual.size}'
    assert ImageChops.difference(actual, expected).getbbox() is None, f'{label}: artwork differs'
    print('PASS', label)


for name, size, maskable in [
    ('icon-192.png', 192, False),
    ('icon-512.png', 512, False),
    ('icon-maskable-512.png', 512, True),
    ('apple-touch-icon.png', 180, False),
]:
    with Image.open(ROOT / 'public' / 'icons' / name) as image:
        check(image, icons.make_icon(artwork, size, maskable), 'web ' + name)
        if maskable:
            # The meaningful coloured artwork must fit in the maskable safe circle.
            rgb = image.convert('RGB')
            center, radius = (size - 1) / 2, size * 0.4
            for y in range(size):
                for x in range(size):
                    if (x - center) ** 2 + (y - center) ** 2 <= radius ** 2:
                        continue
                    pixel = rgb.getpixel((x, y))
                    assert max(pixel) <= 120 or max(pixel) - min(pixel) <= 35, 'artwork outside safe circle'
            print('PASS maskable artwork fits the safe circle')

apk = ROOT / 'public' / 'downloads' / 'TrillTuner.apk'
with ZipFile(apk) as package:
    for bucket, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96),
                         ('xxhdpi', 144), ('xxxhdpi', 192)]:
        source_path = ROOT / 'apk-src' / 'res' / ('mipmap-' + bucket) / 'ic_launcher.png'
        expected = icons.make_icon(artwork, size)
        with Image.open(source_path) as image:
            check(image, expected, 'Android source ' + bucket)
        with Image.open(io.BytesIO(package.read('res/mipmap-' + bucket + '-v4/ic_launcher.png'))) as image:
            check(image, expected, 'APK launcher ' + bucket)

print('\n✅ All icons match the supplied artwork')
