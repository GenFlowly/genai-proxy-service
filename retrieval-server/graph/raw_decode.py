"""Camera RAW -> 8-bit RGB, run as an isolated child process.

image_normalize.py starts this file with `python -I raw_decode.py '<json
params>'`, writes the RAW file to stdin and reads the rendered image from
stdout. LibRaw (via rawpy) is a large C++ parser of hundreds of camera
formats with a history of memory-safety bugs, so it never runs inside the
server process: here it runs under a memory cap and a CPU-time cap, and is the
kernel's first choice if the VM runs out of memory. A crash, a runaway
allocation or a hang costs this child, not the server everyone shares.

Rendering:
- Prefer the preview the camera embedded in the RAW when it is at least
  `min_edge` px on its long edge: it is the camera's own rendering of the
  shot (white balance, tone curve, picture style), costs a few MB to decode,
  and is what phone/desktop galleries show for RAW files.
- Otherwise demosaic the sensor data with LibRaw (camera white balance,
  sRGB, 8-bit; half size when that still covers `min_edge`), if the estimated
  memory fits `max_decode_bytes`.
- Otherwise fall back to any preview at all.
The result is upright (orientation applied) and at most `max_edge` px long.

Protocol: stdout = 4-byte big-endian header length, JSON header
{"width", "height", "source", "sensor"}, then width*height*3 RGB
bytes. On failure: exit status 2 with one JSON line on stderr,
{"error": "unsupported" | "too_large", "detail": "..."}.
"""
import io
import json
import os
import resource
import struct
import sys

# Peak bytes per sensor pixel, measured with LibRaw 0.22 on one core
# (12-22 MP NEF/CR2): half-size demosaic ~4.7, full-size ~12.5 — plus margin.
_HALF_SIZE_BYTES_PER_PIXEL = 5.5
_FULL_SIZE_BYTES_PER_PIXEL = 13.5
# LibRaw flip -> PIL transpose (0 none, 3 = 180°, 5 = 90° CCW, 6 = 90° CW).
_FLIP_TRANSPOSE = {3: "ROTATE_180", 5: "ROTATE_90", 6: "ROTATE_270"}


class _Fail(Exception):
    def __init__(self, kind: str, detail: str):
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _limit_self(max_address_space: int, max_cpu_seconds: int) -> None:
    """Before reading any input: be the OOM killer's first victim, and cap
    this process's address space and CPU time."""
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("1000")
    except OSError:
        pass
    for limit, value in ((resource.RLIMIT_AS, max_address_space), (resource.RLIMIT_CPU, max_cpu_seconds)):
        try:
            resource.setrlimit(limit, (value, value))
        except (ValueError, OSError):
            pass


def _preview(raw, min_edge: int, draft_edge: int = 0):
    """The embedded preview as an upright PIL image, or None when there is
    none (or it is smaller than min_edge). Big JPEG previews decode at
    1/2-1/8 scale (DCT-domain, nearly free) while keeping a long edge of at
    least draft_edge."""
    import rawpy
    from PIL import Image, ImageOps

    try:
        thumb = raw.extract_thumb()
    except rawpy.LibRawError:  # no thumbnail, unsupported thumbnail format, ...
        return None
    if thumb.format == rawpy.ThumbFormat.JPEG:
        im = Image.open(io.BytesIO(thumb.data), formats=["JPEG"])
        if max(im.size) < min_edge:
            return None
        if draft_edge and max(im.size) >= 2 * draft_edge:
            scale = draft_edge / max(im.size)
            im.draft("RGB", (max(1, round(im.width * scale)), max(1, round(im.height * scale))))
        im.load()
        exif_orientation = im.getexif().get(0x0112)
        if exif_orientation and exif_orientation != 1:
            # The preview carries its own orientation (Canon does); applying
            # LibRaw's flip as well would rotate it twice.
            return ImageOps.exif_transpose(im).convert("RGB")
        im = im.convert("RGB")
    elif thumb.format == rawpy.ThumbFormat.BITMAP:
        im = Image.fromarray(thumb.data).convert("RGB")
        if max(im.size) < min_edge:
            return None
    else:
        return None
    transpose = _FLIP_TRANSPOSE.get(raw.sizes.flip)
    return im.transpose(getattr(Image.Transpose, transpose)) if transpose else im


def _demosaic(raw, min_edge: int, max_decode_bytes: int):
    """Sensor data -> upright 8-bit sRGB PIL image, or None when it would not
    fit the memory budget."""
    from PIL import Image

    sizes = raw.sizes
    pixels = sizes.raw_width * sizes.raw_height
    half_long_edge = max(sizes.width, sizes.height) // 2
    half = half_long_edge >= min_edge
    cost = pixels * (_HALF_SIZE_BYTES_PER_PIXEL if half else _FULL_SIZE_BYTES_PER_PIXEL)
    if cost > max_decode_bytes:
        return None
    rgb = raw.postprocess(half_size=half, use_camera_wb=True, output_bps=8)  # applies the flip
    return Image.fromarray(rgb, "RGB")


_MEMORY_ERRORS = ("LibRawUnsufficientMemoryError", "LibRawTooBigError", "LibRawMemPoolOverflowError")


def render(data: bytes, params: dict):
    """(PIL RGB image, source label, sensor size) for a RAW file. Raises _Fail."""
    import rawpy

    try:
        raw = rawpy.imread(io.BytesIO(data))
    except rawpy.LibRawError as e:
        kind = "too_large" if type(e).__name__ in _MEMORY_ERRORS else "unsupported"
        raise _Fail(kind, f"{type(e).__name__}: {e}") from e
    with raw:
        return render_opened(raw, params)


def render_opened(raw, params: dict):
    """render() for an opened LibRaw handle: the preview when it is large
    enough (unless params["prefer"] is "demosaic"), else a demosaic within
    the memory budget, else any preview at all."""
    import rawpy

    min_edge = int(params.get("min_edge", 1568))
    draft_edge = int(params.get("draft_edge", 2400))
    max_decode_bytes = int(params["max_decode_bytes"])
    prefer_preview = params.get("prefer", "preview") == "preview"
    sizes = raw.sizes
    sensor = [sizes.raw_width, sizes.raw_height]
    image, source = None, ""
    if prefer_preview:
        image, source = _preview(raw, min_edge, draft_edge), "preview"
    if image is None:
        try:
            image, source = _demosaic(raw, min_edge, max_decode_bytes), "demosaic"
        except rawpy.LibRawError as e:
            if type(e).__name__ in _MEMORY_ERRORS:
                raise _Fail("too_large", f"{type(e).__name__}: {e}") from e
            image = None  # e.g. a camera LibRaw can read but not decode: try any preview
    if image is None:
        image, source = _preview(raw, 0, draft_edge), "preview"
    if image is None:
        if sizes.raw_width * sizes.raw_height * _HALF_SIZE_BYTES_PER_PIXEL > max_decode_bytes:
            raise _Fail("too_large", f"{sizes.raw_width}x{sizes.raw_height} sensor without a usable preview")
        raise _Fail("unsupported", "no decodable image data")
    return image, source, sensor


def _fit(image, max_edge: int):
    from PIL import Image

    if max(image.size) <= max_edge:
        return image
    scale = max_edge / max(image.size)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS, reducing_gap=3.0)


def main() -> int:
    params = json.loads(sys.argv[1])
    _limit_self(int(params["max_address_space"]), int(params.get("max_cpu_seconds", 60)))
    data = sys.stdin.buffer.read()
    try:
        image, source, sensor = render(data, params)
        del data
        image = _fit(image, int(params.get("max_edge", 3200)))
        pixels = image.tobytes()
    except _Fail as e:
        sys.stderr.write(json.dumps({"error": e.kind, "detail": e.detail[:300]}) + "\n")
        return 2
    except MemoryError:
        sys.stderr.write(json.dumps({"error": "too_large", "detail": "out of memory"}) + "\n")
        return 2
    header = json.dumps({
        "width": image.width, "height": image.height, "source": source, "sensor": sensor,
    }).encode()
    out = sys.stdout.buffer
    out.write(struct.pack(">I", len(header)) + header)
    out.write(pixels)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
