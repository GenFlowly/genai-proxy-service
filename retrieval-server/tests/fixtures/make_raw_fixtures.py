"""Regenerates the camera RAW test fixture in this directory.

Needs pidng (a pure-Python DNG writer) and numpy, in a throwaway virtualenv —
neither is a runtime dependency:

    python -m venv /tmp/raw-venv && /tmp/raw-venv/bin/pip install pidng
    /tmp/raw-venv/bin/python tests/fixtures/make_raw_fixtures.py

- camera_raw.dng: a 160x96 RGGB Bayer mosaic (12-bit, uncompressed, no
  embedded preview), red on the left half and blue on the right, with
  Orientation 6 (display rotated 90° clockwise). Rendered upright it is
  96x160 with red on top. Without a preview it exercises LibRaw's demosaic.
"""
import os

import numpy as np
from pidng.core import RAW2DNG, DNGTags, Tag
from pidng.defs import CalibrationIlluminant, CFAPattern, DNGVersion, PhotometricInterpretation

_HERE = os.path.dirname(os.path.abspath(__file__))
WIDTH, HEIGHT = 160, 96


def _mosaic() -> np.ndarray:
    """RGGB: (even row, even col) R, (odd, odd) B, the rest G."""
    bayer = np.full((HEIGHT, WIDTH), 200, dtype=np.uint16)  # dim G everywhere
    rows, cols = np.indices(bayer.shape)
    red_site = (rows % 2 == 0) & (cols % 2 == 0)
    blue_site = (rows % 2 == 1) & (cols % 2 == 1)
    left = cols < WIDTH // 2
    bayer[red_site & left] = 3800
    bayer[red_site & ~left] = 200
    bayer[blue_site & left] = 200
    bayer[blue_site & ~left] = 3800
    return bayer


if __name__ == "__main__":
    tags = DNGTags()
    tags.set(Tag.ImageWidth, WIDTH)
    tags.set(Tag.ImageLength, HEIGHT)
    tags.set(Tag.TileWidth, WIDTH)
    tags.set(Tag.TileLength, HEIGHT)
    tags.set(Tag.Orientation, 6)  # EXIF: rotate 90° clockwise (pidng has no named value)
    tags.set(Tag.PhotometricInterpretation, PhotometricInterpretation.Color_Filter_Array)
    tags.set(Tag.SamplesPerPixel, 1)
    tags.set(Tag.BitsPerSample, 12)
    tags.set(Tag.CFARepeatPatternDim, [2, 2])
    tags.set(Tag.CFAPattern, CFAPattern.RGGB)
    tags.set(Tag.BlackLevel, 0)
    tags.set(Tag.WhiteLevel, 4095)
    tags.set(Tag.ColorMatrix1, [[1, 1], [0, 1], [0, 1], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1], [1, 1]])
    tags.set(Tag.CalibrationIlluminant1, CalibrationIlluminant.D65)
    tags.set(Tag.AsShotNeutral, [[1, 1], [1, 1], [1, 1]])
    tags.set(Tag.Make, "GenFlowly")
    tags.set(Tag.Model, "Synthetic test fixture")
    tags.set(Tag.DNGVersion, DNGVersion.V1_4)
    tags.set(Tag.DNGBackwardVersion, DNGVersion.V1_2)
    writer = RAW2DNG()
    writer.options(tags, path=_HERE, compress=False)
    writer.convert(_mosaic(), filename="camera_raw")
    print("camera_raw.dng:", os.path.getsize(os.path.join(_HERE, "camera_raw.dng")), "bytes")
