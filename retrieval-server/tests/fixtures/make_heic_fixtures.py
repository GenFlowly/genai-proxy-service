"""Regenerates the HEIC test fixtures in this directory.

The runtime dependency (pi-heif) is decode-only, so the fixtures are committed
files. Recreating them needs the full pillow-heif (it bundles the x265
encoder) — install it in a throwaway virtualenv, not in requirements.txt:

    python -m venv /tmp/heic-venv && /tmp/heic-venv/bin/pip install pillow-heif
    /tmp/heic-venv/bin/python tests/fixtures/make_heic_fixtures.py

- iphone_like.heic: 160x120, red left half, blue right half; no rotation.
- iphone_portrait.heic: stored 160x80 red left / blue right with EXIF
  Orientation 6 (display rotated 90° clockwise) and an embedded ICC profile,
  like an iPhone portrait photo. Displayed upright it is 80x160, red on top.
"""
import io
import os

import pillow_heif
from PIL import Image, ImageCms

pillow_heif.register_heif_opener()

_HERE = os.path.dirname(os.path.abspath(__file__))


def _halves(w: int, h: int) -> Image.Image:
    im = Image.new("RGB", (w, h), (255, 0, 0))
    im.paste((0, 0, 255), (w // 2, 0, w, h))
    return im


def _save(name: str, im: Image.Image, **kw) -> None:
    buf = io.BytesIO()
    im.save(buf, "HEIF", quality=95, **kw)
    with open(os.path.join(_HERE, name), "wb") as f:
        f.write(buf.getvalue())
    print(f"{name}: {len(buf.getvalue())} bytes")


if __name__ == "__main__":
    _save("iphone_like.heic", _halves(160, 120))
    portrait = _halves(160, 80)
    exif = portrait.getexif()
    exif[0x0112] = 6
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    _save("iphone_portrait.heic", portrait, exif=exif.tobytes(), icc_profile=icc)
