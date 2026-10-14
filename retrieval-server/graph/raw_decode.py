"""Camera RAW -> 8-bit RGB, run as an isolated child process.

image_normalize.py starts this file with `python -I raw_decode.py '<json
params>'`. The RAW file is a temporary file named by params["path"], and the
rendered image comes back on stdout. LibRaw (via rawpy) is a large C++ parser
of hundreds of camera formats with a history of memory-safety bugs, so it
never runs inside the server process. Here it runs:
- as an unprivileged user (the server starts this process as nobody when the
  server itself runs as root), so it can't read the server's environment
  through /proc, signal the server or write to the app;
- under a memory cap and a CPU-time cap, and as the kernel's first choice if
  the VM runs out of memory;
- locked down before LibRaw sees a byte of the file: no new privileges, no
  new processes or threads, no file writes, and no file descriptor beyond the
  one LibRaw reads the file through, so nothing parsed from the file can open
  a socket or another file.
A crash, a runaway allocation, a hang or an exploited parser bug costs this
child, not the server everyone shares.

Rendering:
- Prefer the preview the camera embedded in the RAW when it is at least
  `min_edge` px on its long edge: it is the camera's own rendering of the
  shot (white balance, tone curve, picture style), costs a few MB to decode,
  and is what phone/desktop galleries show for RAW files.
- Otherwise demosaic the sensor data with LibRaw (camera white balance,
  sRGB, 8-bit; half size when that still covers `min_edge`), if the estimated
  memory fits `max_decode_bytes`.
- Otherwise (over budget, or sensor data LibRaw can't decode) fall back to
  any preview at all.
The result is upright (orientation applied) and at most `max_edge` px long.

Protocol: stdout = 4-byte big-endian header length, JSON header
{"width", "height", "source", "sensor"}, then width*height*3 RGB
bytes. On failure: exit status 2 with one JSON line on stderr,
{"error": "unsupported" | "too_large" | "error", "detail": "..."}
("error": something went wrong that says nothing about the file).
"""
import errno
import io
import json
import os
import resource
import struct
import sys

# Peak bytes per sensor pixel, measured with LibRaw 0.22 on one core: Bayer
# (12-66 MP NEF/CR2/DNG) half-size demosaic 4.7-5.8, full size ~12.5;
# non-Bayer data (linear DNG such as ProRAW/Expert RAW, Canon sRAW/mRAW,
# Foveon X3F), which half_size doesn't shrink, 19-25 — plus margin.
_HALF_SIZE_BYTES_PER_PIXEL = 6.0
_FULL_SIZE_BYTES_PER_PIXEL = 14.0
_STACKED_BYTES_PER_PIXEL = 28.0
# LibRaw flip -> PIL transpose (0 none, 3 = 180°, 5 = 90° CCW, 6 = 90° CW).
_FLIP_TRANSPOSE = {3: "ROTATE_180", 5: "ROTATE_90", 6: "ROTATE_270"}
_PR_SET_NO_NEW_PRIVS = 38
_MEMORY_ERRORS = ("LibRawUnsufficientMemoryError", "LibRawTooBigError", "LibRawMemPoolOverflowError")


class _Fail(Exception):
    def __init__(self, kind: str, detail: str):
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _limit_self(max_address_space: int, max_cpu_seconds: int) -> None:
    """First thing, before any input is touched: be the OOM killer's first
    victim; cap address space and CPU time (a soft CPU limit under the hard
    one ends the process with SIGXCPU, which the server reports as "took too
    long"); no core dumps; and no new privileges (setuid binaries) for this
    process or anything it might exec."""
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("1000")
    except OSError:
        pass
    for limit, value in (
        (resource.RLIMIT_AS, (max_address_space, max_address_space)),
        (resource.RLIMIT_CPU, (max_cpu_seconds, max_cpu_seconds + 5)),
        (resource.RLIMIT_CORE, (0, 0)),
    ):
        try:
            resource.setrlimit(limit, value)
        except (ValueError, OSError):
            pass
    try:
        import ctypes

        ctypes.CDLL(None, use_errno=True).prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass


def _lock_down() -> None:
    """Right before LibRaw opens the file: no new processes or threads, no
    file writes, and room for exactly one more file descriptor — the one
    LibRaw reads the file through — so nothing parsed from the file can open
    a socket or another file. Everything the render needs is imported
    before this."""
    free = os.open(os.devnull, os.O_RDONLY)  # the lowest free descriptor
    os.close(free)
    resource.setrlimit(resource.RLIMIT_NOFILE, (free + 1, free + 1))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))


def _out_of_memory(e: BaseException) -> bool:
    """MemoryError, LibRaw's memory errors, or ENOMEM (rawpy raises OSError
    for allocation failures in its image/thumbnail copies)."""
    if isinstance(e, MemoryError) or type(e).__name__ in _MEMORY_ERRORS:
        return True
    if isinstance(e, OSError):
        args = e.args[0] if len(e.args) == 1 and isinstance(e.args[0], tuple) else e.args
        return e.errno == errno.ENOMEM or (bool(args) and args[0] == errno.ENOMEM)
    return False


def _thumbnail(raw):
    """The embedded preview as a rawpy Thumbnail, or None. Read before any
    demosaic: once unpacking the sensor data fails, LibRaw has reset the
    handle and extract_thumb() fails too."""
    try:
        return raw.extract_thumb()
    except Exception:  # no thumbnail, unsupported thumbnail format, out of memory, ...
        return None


def _rgb(array):
    """PIL RGB image from LibRaw's (h, w, c) uint8 output. Monochrome sensors
    and their previews come as (h, w, 1)."""
    from PIL import Image

    if array.ndim == 3 and array.shape[2] == 1:
        array = array[:, :, 0]
    im = Image.fromarray(array)
    return im if im.mode == "RGB" else im.convert("RGB")


def _preview(thumb, flip: int, min_edge: int, draft_edge: int = 0):
    """The embedded preview as an upright PIL image, or None when there is
    none, it is smaller than min_edge or it can't be decoded. Big JPEG
    previews decode at 1/2-1/8 scale (DCT-domain, nearly free) while keeping
    a long edge of at least draft_edge."""
    import rawpy
    from PIL import Image, ImageOps

    if thumb is None:
        return None
    try:
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
            if max(thumb.data.shape[:2]) < min_edge:
                return None
            im = _rgb(thumb.data)
        else:
            return None
    except MemoryError:
        raise
    except Exception:  # a damaged or unusual preview: render the sensor data instead
        return None
    transpose = _FLIP_TRANSPOSE.get(flip)
    return im.transpose(getattr(Image.Transpose, transpose)) if transpose else im


def _demosaic(raw, sizes, min_edge: int, max_decode_bytes: int):
    """Sensor data -> upright 8-bit sRGB PIL image, or None when it would not
    fit the memory budget."""
    import rawpy

    pixels = sizes.raw_width * sizes.raw_height
    half = max(sizes.width, sizes.height) // 2 >= min_edge
    if pixels * (_HALF_SIZE_BYTES_PER_PIXEL if half else _FULL_SIZE_BYTES_PER_PIXEL) > max_decode_bytes:
        return None  # wouldn't fit even as Bayer data: don't unpack at all
    if raw.raw_type == rawpy.RawType.Stack:  # unpacks the sensor data (postprocess would anyway)
        half = False  # half_size only shrinks Bayer data
        if pixels * _STACKED_BYTES_PER_PIXEL > max_decode_bytes:
            return None
    return _rgb(raw.postprocess(half_size=half, use_camera_wb=True, output_bps=8))  # applies the flip


def render(path: str, params: dict):
    """(PIL RGB image, source label, sensor size) for a RAW file. Raises _Fail."""
    import rawpy

    try:
        raw = rawpy.imread(path)
    except rawpy.LibRawError as e:
        raise _Fail("too_large" if _out_of_memory(e) else "unsupported", f"{type(e).__name__}: {e}") from e
    with raw:
        return render_opened(raw, params)


def render_opened(raw, params: dict):
    """render() for an opened LibRaw handle: the preview when it is large
    enough (unless params["prefer"] is "demosaic"), else a demosaic within
    the memory budget, else any preview at all."""
    min_edge = int(params.get("min_edge", 1568))
    draft_edge = int(params.get("draft_edge", 2400))
    max_decode_bytes = int(params["max_decode_bytes"])
    prefer_preview = params.get("prefer", "preview") == "preview"
    sizes = raw.sizes  # a snapshot: a failed unpack resets the handle
    sensor = [sizes.raw_width, sizes.raw_height]
    thumb = _thumbnail(raw)
    image, source, failure = None, "", None
    if prefer_preview:
        image, source = _preview(thumb, sizes.flip, min_edge, draft_edge), "preview"
    if image is None:
        try:
            # None: over the memory budget
            image, source = _demosaic(raw, sizes, min_edge, max_decode_bytes), "demosaic"
        except Exception as e:
            # e.g. a camera LibRaw can read but not decode, truncated sensor
            # data, or more memory than the cap allows: try any preview
            image, failure = None, e
    if image is None:
        image, source = _preview(thumb, sizes.flip, 0, draft_edge), "preview"
    if image is None:
        if failure is None or _out_of_memory(failure):
            raise _Fail("too_large", f"{sizes.raw_width}x{sizes.raw_height} sensor without a usable preview")
        raise _Fail("unsupported", f"{type(failure).__name__}: {failure}")
    return image, source, sensor


def _fit(image, max_edge: int):
    from PIL import Image

    if max(image.size) <= max_edge:
        return image
    scale = max_edge / max(image.size)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS, reducing_gap=3.0)


def _fail(kind: str, detail: str) -> int:
    sys.stderr.write(json.dumps({"error": kind, "detail": detail[:300]}) + "\n")
    return 2


def main() -> int:
    params = json.loads(sys.argv[1])
    _limit_self(int(params["max_address_space"]), int(params.get("max_cpu_seconds", 60)))
    try:
        import numpy  # noqa: F401
        import rawpy  # noqa: F401
        from PIL import Image, ImageOps, JpegImagePlugin, TiffImagePlugin  # noqa: F401

        Image.preinit()
        path = params["path"]
        if not os.access(path, os.R_OK):
            return _fail("error", f"input file not readable as uid {os.getuid()}")
        _lock_down()
        image, source, sensor = render(path, params)
        image = _fit(image, int(params.get("max_edge", 3200)))
        pixels = image.tobytes()
    except _Fail as e:
        return _fail(e.kind, e.detail)
    except Exception as e:
        return _fail("too_large" if _out_of_memory(e) else "unsupported", f"{type(e).__name__}: {e}")
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
