"""Camera RAW -> 8-bit RGB, run as an isolated child process.

image_normalize.py starts this file with `python -I raw_decode.py '<json
params>'`. The RAW file is a temporary file named by params["path"], and the
rendered image comes back on stdout. LibRaw (via rawpy) is a large C++ parser
of hundreds of camera formats with a history of memory-safety bugs, so it
never runs inside the server process. Here it runs:
- as an unprivileged user (the server starts this process as nobody when the
  server itself runs as root). It can't read the server's environment
  through /proc, signal the server, or read other requests' files (only its
  own RAW file is given to nobody, for the duration of this run);
- under a memory cap and a CPU-time cap, and as the kernel's first choice if
  the VM runs out of memory;
- locked down before LibRaw sees a byte of the file, by limits the process
  can't lift again: no new privileges, no new processes or threads, and a
  seccomp filter that refuses sockets (so no network, not even the server's
  own port), exec, ptrace and every file system change (opening for write,
  creating, renaming, linking, deleting, chmod/chown).
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
{"width", "height", "source", "sensor", "notes"}, then width*height*3 RGB
bytes ("notes": why a preview was unusable, for the server's log). On
failure: exit status 2 with one JSON line on stderr,
{"error": "unsupported" | "too_large" | "error", "detail": "..."}
("error": something went wrong that says nothing about the file).
"""
import errno
import io
import json
import os
import platform
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
# The smallest preview worth sending when there is nothing better (some
# files carry only an icon-sized one).
_MIN_FALLBACK_EDGE = 128
# LibRaw flip -> PIL transpose (0 none, 3 = 180°, 5 = 90° CCW, 6 = 90° CW).
_FLIP_TRANSPOSE = {3: "ROTATE_180", 5: "ROTATE_90", 6: "ROTATE_270"}
_PR_SET_NO_NEW_PRIVS = 38
_MEMORY_ERRORS = ("LibRawUnsufficientMemoryError", "LibRawTooBigError", "LibRawMemPoolOverflowError")
# Address space in use once everything is imported (set by main()): the
# unpack of the sensor data is held to this plus the decode budget.
_base_address_space = 0
# Why a preview was unusable, for the server's log.
_notes: list[str] = []


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


# Syscalls the seccomp filter refuses with EPERM, as (x86_64, aarch64)
# numbers (None: the architecture doesn't have it): network, exec, other
# processes' memory, and file system changes.
_DENIED_SYSCALLS = {
    "socket": (41, 198), "socketpair": (53, 199), "connect": (42, 203),
    "io_uring_setup": (425, 425),  # io_uring can open sockets and files
    "execve": (59, 221), "execveat": (322, 281),
    "ptrace": (101, 117), "process_vm_readv": (310, 270), "process_vm_writev": (311, 271),
    "creat": (85, None), "openat2": (437, 437), "open_by_handle_at": (304, 265),
    "mkdir": (83, None), "mkdirat": (258, 34), "rmdir": (84, None),
    "unlink": (87, None), "unlinkat": (263, 35), "rename": (82, None), "renameat": (264, None),
    "renameat2": (316, 276), "link": (86, None), "linkat": (265, 37),
    "symlink": (88, None), "symlinkat": (266, 36), "mknod": (133, None), "mknodat": (259, 33),
    "chmod": (90, None), "fchmod": (91, 52), "fchmodat": (268, 53), "fchmodat2": (452, 452),
    "chown": (92, None), "fchown": (93, 55), "lchown": (94, None), "fchownat": (260, 54),
    "truncate": (76, 45), "ftruncate": (77, 46),
}
# open/openat: refused when the flags (argument index) ask to write or create.
_OPEN_SYSCALLS = {"open": ((2, 1), None), "openat": ((257, 2), (56, 2))}
_OPEN_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
_SECCOMP_ARCH = {"x86_64": (0xC000003E, 0), "aarch64": (0xC00000B7, 1)}


def _seccomp_program(machine: str) -> list[tuple[int, int, int, int]]:
    """The classic-BPF seccomp filter for this architecture, as (code, jt,
    jf, k) instructions. Raises KeyError for an unknown architecture."""
    audit_arch, column = _SECCOMP_ARCH[machine]
    ld_abs, jeq, jge, jset, ret = 0x20, 0x15, 0x35, 0x45, 0x06
    allow, deny, kill = 0x7FFF0000, 0x00050000 | errno.EPERM, 0x80000000  # SECCOMP_RET_*
    program: list[list] = []  # jump targets as labels until resolved below

    def emit(code, k, jt=0, jf=0):
        program.append([code, jt, jf, k])

    emit(ld_abs, 4)  # seccomp_data.arch
    emit(jeq, audit_arch, jf="kill")  # a foreign ABI could bypass the numbers below
    emit(ld_abs, 0)  # seccomp_data.nr
    if machine == "x86_64":
        emit(jge, 0x40000000, jt="deny")  # x32 ABI
    for numbers in _DENIED_SYSCALLS.values():
        if numbers[column] is not None:
            emit(jeq, numbers[column], jt="deny")
    for spec in _OPEN_SYSCALLS.values():
        if spec[column] is None:
            continue
        number, flags_arg = spec[column]
        emit(jeq, number, jf=2)  # not this syscall: skip its two-instruction check
        emit(ld_abs, 16 + 8 * flags_arg)  # low 32 bits of seccomp_data.args[flags_arg]
        emit(jset, _OPEN_WRITE_FLAGS, jt="deny", jf="allow")
    labels = {"allow": len(program), "deny": len(program) + 1, "kill": len(program) + 2}
    emit(ret, allow)
    emit(ret, deny)
    emit(ret, kill)
    return [
        (code, labels[jt] - i - 1 if isinstance(jt, str) else jt,
         labels[jf] - i - 1 if isinstance(jf, str) else jf, k)
        for i, (code, jt, jf, k) in enumerate(program)
    ]


def _install_seccomp() -> None:
    """Install the filter (needs no-new-privs, set by _limit_self). Raises
    OSError when it can't be installed: never parse untrusted input without
    it on Linux."""
    import ctypes

    try:
        program = _seccomp_program(platform.machine())
    except KeyError:
        raise OSError(errno.ENOSYS, f"no seccomp filter for {platform.machine()}") from None

    class SockFilter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]

    instructions = (SockFilter * len(program))(*(SockFilter(*i) for i in program))
    fprog = SockFprog(len(program), instructions)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(22, 2, ctypes.byref(fprog), 0, 0) != 0:  # PR_SET_SECCOMP, SECCOMP_MODE_FILTER
        code = ctypes.get_errno()
        raise OSError(code, f"seccomp: {os.strerror(code)}")


def _lock_down() -> None:
    """Right before LibRaw opens the file, by limits this process can't lift:
    no new processes or threads, no writing to files, and the seccomp
    filter (no sockets, exec, ptrace or file system changes). Raises
    OSError when the filter can't be installed on Linux."""
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    if sys.platform.startswith("linux"):
        _install_seccomp()


def _address_space() -> int:
    """This process's current address space in bytes (0 if unknown)."""
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[0]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return 0


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


def _shape_decides(size, flip: int, sensor) -> bool:
    """Whether a preview's shape tells if it was turned: a quarter-turn flip,
    and neither the preview nor the sensor near-square."""
    if flip not in (5, 6) or not sensor:
        return False
    (pw, ph), (sw, sh) = size, sensor
    return min(pw, ph, sw, sh) > 0 and max(pw, ph) >= 1.1 * min(pw, ph) and max(sw, sh) >= 1.1 * min(sw, sh)


def _pre_rotated(size, flip: int, sensor) -> bool:
    """Whether a preview was already turned upright: under a quarter-turn
    flip, its long side isn't the unrotated sensor's."""
    (pw, ph), (sw, sh) = size, sensor or (0, 0)
    return _shape_decides(size, flip, sensor) and (pw > ph) != (sw > sh)


def _preview(thumb, flip: int, min_edge: int, draft_edge: int = 0, sensor=None, *,
             preferred: bool = False, dng: bool = False):
    """The embedded preview as an upright PIL image, or None when there is
    none, it is smaller than min_edge or it can't be decoded. Big JPEG
    previews decode at 1/2-1/8 scale (DCT-domain, nearly free) while keeping
    a long edge of at least draft_edge. `sensor`: the unrotated sensor size.
    `preferred`: chosen over the sensor data, so refused when its
    orientation is a guess. `dng`: from a DNG."""
    import rawpy
    from PIL import Image, ImageOps

    if thumb is None:
        return None
    exif_orientation = None
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
            im = im.convert("RGB")
            # LibRaw never turns a JPEG preview's pixels; camera software
            # sometimes does (Nikon Transfer), recording the turn only for the
            # sensor data. A DNG's previews stay in the sensor's orientation by
            # spec, possibly cropped by an editor, so their shape says nothing.
            if not dng and _pre_rotated(im.size, flip, sensor):
                return im  # already upright: neither LibRaw's flip nor the EXIF it derives from it apply
        elif thumb.format == rawpy.ThumbFormat.BITMAP:
            if max(thumb.data.shape[:2]) < min_edge:
                return None
            im = _rgb(thumb.data)
            # LibRaw turns some bitmap previews itself (those its Kodak loader
            # reads: more than 8 bits per sample, or Kodak's compression) and
            # not others, and rawpy can't say which. Only a quarter turn's
            # shape tells — not a half turn, a near-square shape, or a DNG
            # preview that may be cropped. Where it can't tell, render the
            # sensor data instead, which LibRaw orients itself.
            if preferred and flip != 0 and (dng or not _shape_decides(im.size, flip, sensor)):
                return None
            if _pre_rotated(im.size, flip, sensor):
                return im
        else:
            return None
        if exif_orientation and exif_orientation != 1:
            # The preview's own orientation (Canon writes one; LibRaw adds one
            # derived from its flip to JPEG previews without EXIF). Applying
            # LibRaw's flip as well would rotate it twice.
            im.getexif()[0x0112] = exif_orientation
            return ImageOps.exif_transpose(im)
    except MemoryError:
        raise
    except Exception as e:  # a damaged or unusual preview: render the sensor data instead
        _notes.append(f"preview unusable: {type(e).__name__}: {e}"[:200])
        return None
    transpose = _FLIP_TRANSPOSE.get(flip)
    return im.transpose(getattr(Image.Transpose, transpose)) if transpose else im


def _unpack_is_stacked(raw, max_bytes: int) -> bool:
    """Unpack the sensor data with the address space held to what is in use
    plus the decode budget — non-Bayer data takes several times the memory
    and rawpy can't tell before unpacking — and say whether it is non-Bayer
    ("stacked"). A memory error here means it doesn't fit."""
    import rawpy

    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    capped = _base_address_space > 0
    if capped:
        limit = _base_address_space + max_bytes
        resource.setrlimit(resource.RLIMIT_AS, (limit if hard == resource.RLIM_INFINITY else min(hard, limit), hard))
    try:
        return raw.raw_type == rawpy.RawType.Stack  # unpacks
    finally:
        if capped:
            resource.setrlimit(resource.RLIMIT_AS, (soft, hard))


def _demosaic(raw, sizes, min_edge: int, max_decode_bytes: int):
    """Sensor data -> upright 8-bit sRGB PIL image, or None when it would not
    fit the memory budget."""
    pixels = sizes.raw_width * sizes.raw_height
    half = max(sizes.width, sizes.height) // 2 >= min_edge
    if pixels * (_HALF_SIZE_BYTES_PER_PIXEL if half else _FULL_SIZE_BYTES_PER_PIXEL) > max_decode_bytes:
        return None  # wouldn't fit even as Bayer data: don't unpack at all
    if _unpack_is_stacked(raw, max_decode_bytes):
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
    unrotated = (sizes.width, sizes.height)
    dng = bool(params.get("dng"))
    thumb = _thumbnail(raw)
    image, source, failure = None, "", None
    if prefer_preview:
        image, source = _preview(thumb, sizes.flip, min_edge, draft_edge, unrotated, preferred=True, dng=dng), "preview"
    if image is None:
        try:
            # None: over the memory budget
            image, source = _demosaic(raw, sizes, min_edge, max_decode_bytes), "demosaic"
        except Exception as e:
            # e.g. a camera LibRaw can read but not decode, truncated sensor
            # data, or more memory than the budget allows: try any preview
            image, failure = None, e
    if image is None:
        image, source = _preview(thumb, sizes.flip, _MIN_FALLBACK_EDGE, draft_edge, unrotated, dng=dng), "preview"
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
    global _base_address_space

    params = json.loads(sys.argv[1])
    _limit_self(int(params["max_address_space"]), int(params.get("max_cpu_seconds", 60)))
    try:
        import numpy  # noqa: F401
        import rawpy  # noqa: F401
        from PIL import Image, ImageOps, JpegImagePlugin, MpoImagePlugin, TiffImagePlugin  # noqa: F401

        Image.preinit()
        path = params["path"]
        if not os.access(path, os.R_OK):
            return _fail("error", f"input file not readable as uid {os.getuid()}")
        _base_address_space = _address_space()
        try:
            _lock_down()
        except OSError as e:
            return _fail("error", f"lockdown failed: {e}")
        image, source, sensor = render(path, params)
        image = _fit(image, int(params.get("max_edge", 3200)))
        pixels = image.tobytes()
    except _Fail as e:
        return _fail(e.kind, e.detail + "".join(f"; {note}" for note in _notes))
    except Exception as e:
        return _fail("too_large" if _out_of_memory(e) else "unsupported", f"{type(e).__name__}: {e}")
    header = json.dumps({
        "width": image.width, "height": image.height, "source": source, "sensor": sensor, "notes": _notes,
    }).encode()
    out = sys.stdout.buffer
    out.write(struct.pack(">I", len(header)) + header)
    out.write(pixels)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
