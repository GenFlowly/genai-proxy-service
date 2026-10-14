"""Regenerates the camera RAW test fixtures in this directory.

Needs pidng (a pure-Python DNG writer), numpy and Pillow, in a throwaway
virtualenv — pidng is not a runtime dependency:

    python -m venv /tmp/raw-venv && /tmp/raw-venv/bin/pip install pidng Pillow
    /tmp/raw-venv/bin/python tests/fixtures/make_raw_fixtures.py

- camera_raw.dng: a 160x96 RGGB Bayer mosaic (12-bit, uncompressed, no
  embedded preview), red on the left half and blue on the right, with
  Orientation 6 (display rotated 90° clockwise). Rendered upright it is
  96x160 with red on top. Without a preview it exercises LibRaw's demosaic.
- camera_raw_truncated.dng: a 160x120 JPEG preview (red left, blue right) in
  IFD0 and a 320x240 16-bit RGGB mosaic in a SubIFD, cut off a third of the
  way into the sensor data, like an interrupted upload. LibRaw opens it but
  can't demosaic it; the small preview is all there is to show.
"""
import io
import os
import struct

import numpy as np
from PIL import Image
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


def write_camera_raw_dng() -> None:
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


# TIFF field types
_BYTE, _ASCII, _SHORT, _LONG, _RATIONAL, _SRATIONAL = 1, 2, 3, 4, 5, 10


def _ifd(entries: list, offset: int) -> bytes:
    """A little-endian IFD at `offset`: [(tag, type, values)], values > 4
    bytes stored right after it. No next IFD."""
    entries = sorted(entries)
    data_offset = offset + 2 + 12 * len(entries) + 4
    head, extra = struct.pack("<H", len(entries)), b""
    for tag, field_type, values in entries:
        if field_type == _ASCII:
            payload, count = values.encode() + b"\0", len(values) + 1
        elif field_type in (_RATIONAL, _SRATIONAL):
            fmt = "<ii" if field_type == _SRATIONAL else "<II"
            payload, count = b"".join(struct.pack(fmt, *v) for v in values), len(values)
        else:
            fmt = {_BYTE: "<B", _SHORT: "<H", _LONG: "<I"}[field_type]
            payload, count = b"".join(struct.pack(fmt, v) for v in values), len(values)
        if len(payload) <= 4:
            head += struct.pack("<HHI", tag, field_type, count) + payload.ljust(4, b"\0")
        else:
            extra += b"\0" * (len(extra) % 2)
            head += struct.pack("<HHII", tag, field_type, count, data_offset + len(extra))
            extra += payload
    return head + struct.pack("<I", 0) + extra


def write_truncated_dng() -> None:
    preview = Image.new("RGB", (160, 120), (220, 30, 30))
    preview.paste((30, 30, 220), (80, 0, 160, 120))
    buf = io.BytesIO()
    preview.save(buf, "JPEG", quality=90)
    jpeg = buf.getvalue()
    width, height = 320, 240
    rows, cols = np.indices((height, width))
    mosaic = np.full((height, width), 1000, np.uint16)
    mosaic[(rows % 2 == 0) & (cols % 2 == 0)] = 30000
    sensor = mosaic.astype("<u2").tobytes()

    sub_offset = jpeg_offset = sensor_offset = 0
    for _ in range(3):  # offsets depend on the IFD sizes: iterate to a fixed point
        ifd0 = _ifd([
            (254, _LONG, [1]), (256, _LONG, [160]), (257, _LONG, [120]), (258, _SHORT, [8, 8, 8]),
            (259, _SHORT, [7]), (262, _SHORT, [6]), (271, _ASCII, "GenFlowly"),
            (272, _ASCII, "Synthetic test fixture"), (273, _LONG, [jpeg_offset]), (274, _SHORT, [1]),
            (277, _SHORT, [3]), (278, _LONG, [120]), (279, _LONG, [len(jpeg)]), (330, _LONG, [sub_offset]),
            (50706, _BYTE, [1, 4, 0, 0]), (50707, _BYTE, [1, 2, 0, 0]),
            (50708, _ASCII, "GenFlowly Synthetic test fixture"),
            (50721, _SRATIONAL, [(1, 1), (0, 1), (0, 1), (0, 1), (1, 1), (0, 1), (0, 1), (0, 1), (1, 1)]),
            (50778, _SHORT, [21]), (50728, _RATIONAL, [(1, 1), (1, 1), (1, 1)]),
        ], 8)
        sub_offset = 8 + len(ifd0) + (8 + len(ifd0)) % 2
        sub = _ifd([
            (254, _LONG, [0]), (256, _LONG, [width]), (257, _LONG, [height]), (258, _SHORT, [16]),
            (259, _SHORT, [1]), (262, _SHORT, [32803]), (273, _LONG, [sensor_offset]), (277, _SHORT, [1]),
            (278, _LONG, [height]), (279, _LONG, [len(sensor)]), (33421, _SHORT, [2, 2]),
            (33422, _BYTE, [0, 1, 1, 2]), (50714, _LONG, [0]), (50717, _LONG, [65535]),
        ], sub_offset)
        jpeg_offset = sub_offset + len(sub) + (sub_offset + len(sub)) % 2
        sensor_offset = jpeg_offset + len(jpeg) + (jpeg_offset + len(jpeg)) % 2
    out = bytearray(b"II*\x00" + struct.pack("<I", 8)) + ifd0
    for offset, chunk in ((sub_offset, sub), (jpeg_offset, jpeg), (sensor_offset, sensor[: len(sensor) // 3])):
        out += b"\0" * (offset - len(out)) + chunk
    with open(os.path.join(_HERE, "camera_raw_truncated.dng"), "wb") as f:
        f.write(out)


if __name__ == "__main__":
    write_camera_raw_dng()
    write_truncated_dng()
    for name in ("camera_raw.dng", "camera_raw_truncated.dng"):
        print(f"{name}:", os.path.getsize(os.path.join(_HERE, name)), "bytes")
