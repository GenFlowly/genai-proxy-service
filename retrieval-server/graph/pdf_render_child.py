"""PDF render (and parse) worker child. Never imported by the server.

Started by graph/pdf_worker.py as

    python -E -s -m graph.pdf_render_child '<json params>'

(params: {"kind": "typst" | "parse", "max_address_space", "max_cpu_seconds"})
from the app directory (the server's working directory). Not `-I`: that
implies -P, which keeps the working directory off sys.path, and `graph` lives
there, not in site-packages. -E and -s still ignore PYTHON* variables and the
user site directory.

The child renders untrusted, model-written documents with a native engine
(Typst) or parses untrusted uploaded PDFs (PDFium). A runaway allocation, a
hang or a crash costs this child, never the shared server process:
- address-space cap (RLIMIT_AS) set before any renderer is imported; a
  CPU-time cap for the job (soft RLIMIT_CPU set to used + max_cpu_seconds);
  file-size cap; no core dumps; first choice of the OOM killer; no new
  privileges;
- on Linux a seccomp filter refuses sockets (no network at all), exec,
  ptrace and other processes' memory. File writes stay allowed (Typst needs
  a per-render root), but the child runs as `nobody` with a private TMPDIR,
  so it can write little else;
- logging is locked down before anything else is imported: no handler can
  ever print document text, logging.lastResort is gone, warnings are
  ignored, and the parent starts the child with stderr on /dev/null.

Protocol (both directions): 4-byte big-endian length + UTF-8 JSON header,
then, when the header carries "data_len" (requests), "pdf_len" or
"payload_len" (responses), that many raw bytes.
  request  {"op": "render", "job": {...generate_pdf.render_job job...}}
  response {"status": "ok"|"error", "kind"?, "pages"?, "warnings"?,
            "render_cpu_seconds"?, "spawn_cpu_seconds", "peak_rss_bytes",
            "rss_after_bytes", "pdf_len"?}
  request  {"op": "inspect_extract"|"render_pages", "params": {...},
            "data_len": N} + the uploaded PDF's bytes (plan 4.1)
  response inspect_extract: {"status", "pages", "page_chars", "payload_len"}
           + a JSON list of each page's text; render_pages: {"status",
           "pages", "image_lens", "payload_len"} + the JPEGs back to back;
           errors carry "kind": encrypted | unreadable | oom | error.
Every child serves exactly ONE job (a Typst render or a PDF parse) and exits;
it waits at most REQUEST_WAIT_SECONDS for that job and exits without one.
--selftest renders with Typst (mixed scripts with the bundled fonts, math
with the vendored mitex), extracts and rasterizes the result with PDFium and
exits 0/1 (the Docker build's smoke step).
"""
import errno
import json
import logging
import os
import platform
import resource
import select
import struct
import sys
import time
import warnings


def _lock_down_logging() -> None:
    """No log record may ever reach a stream: install a do-nothing root
    handler and remove logging's last-resort stderr handler."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    root.addHandler(logging.NullHandler())
    root.setLevel(logging.CRITICAL + 1)
    logging.lastResort = None
    warnings.simplefilter("ignore")


_lock_down_logging()

_PR_SET_NO_NEW_PRIVS = 38

# Syscalls refused with EPERM, as (x86_64, aarch64) numbers (None: absent on
# that architecture): network, exec, other processes' memory.
_DENIED_SYSCALLS = {
    "socket": (41, 198), "socketpair": (53, 199), "connect": (42, 203),
    "bind": (49, 200), "listen": (50, 201), "accept": (43, 202), "accept4": (288, 242),
    "io_uring_setup": (425, 425),
    "execve": (59, 221), "execveat": (322, 281),
    "ptrace": (101, 117), "process_vm_readv": (310, 270), "process_vm_writev": (311, 271),
}
_SECCOMP_ARCH = {"x86_64": (0xC000003E, 0), "aarch64": (0xC00000B7, 1)}


def _seccomp_program(machine: str) -> list[tuple[int, int, int, int]]:
    audit_arch, column = _SECCOMP_ARCH[machine]
    ld_abs, jeq, jge, ret = 0x20, 0x15, 0x35, 0x06
    allow, deny, kill = 0x7FFF0000, 0x00050000 | errno.EPERM, 0x80000000
    program: list[list] = []

    def emit(code, k, jt=0, jf=0):
        program.append([code, jt, jf, k])

    emit(ld_abs, 4)  # seccomp_data.arch
    emit(jeq, audit_arch, jf="kill")
    emit(ld_abs, 0)  # seccomp_data.nr
    if machine == "x86_64":
        emit(jge, 0x40000000, jt="deny")  # x32 ABI
    for numbers in _DENIED_SYSCALLS.values():
        if numbers[column] is not None:
            emit(jeq, numbers[column], jt="deny")
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
    import ctypes

    program = _seccomp_program(platform.machine())

    class SockFilter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]

    instructions = (SockFilter * len(program))(*(SockFilter(*i) for i in program))
    fprog = SockFprog(len(program), instructions)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(22, 2, ctypes.byref(fprog), 0, 0) != 0:  # PR_SET_SECCOMP, FILTER
        code = ctypes.get_errno()
        raise OSError(code, f"seccomp: {os.strerror(code)}")


def _limit_self(params: dict) -> None:
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("1000")
    except OSError:
        pass
    address_space = int(params.get("max_address_space") or 0)
    limits = [
        (resource.RLIMIT_CORE, (0, 0)),
        (resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024)),
        # Hard CPU cap for the child's whole life; the soft cap is moved per
        # job (see _arm_cpu_cap).
        (resource.RLIMIT_CPU, (int(params.get("lifetime_cpu_seconds") or 3600),) * 2),
    ]
    if address_space:
        limits.append((resource.RLIMIT_AS, (address_space, address_space)))
    for limit, value in limits:
        try:
            resource.setrlimit(limit, value)
        except (ValueError, OSError):
            pass
    try:
        import ctypes

        ctypes.CDLL(None, use_errno=True).prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass
    if sys.platform.startswith("linux") and params.get("seccomp", True):
        _install_seccomp()


def _arm_cpu_cap(max_cpu_seconds: int) -> None:
    """Soft RLIMIT_CPU = CPU used so far + this job's allowance: a job that
    burns more than its allowance gets SIGXCPU (the parent reports a timeout)."""
    used = resource.getrusage(resource.RUSAGE_SELF)
    spent = int(used.ru_utime + used.ru_stime) + 1
    _, hard = resource.getrlimit(resource.RLIMIT_CPU)
    soft = spent + max_cpu_seconds
    if hard != resource.RLIM_INFINITY:
        soft = min(soft, hard)
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (soft, hard))
    except (ValueError, OSError):
        pass


def _rss_bytes() -> int:
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError):
        return 0


def _peak_rss_bytes() -> int:
    """This process's own peak RSS. VmHWM, not ru_maxrss: Linux carries
    ru_maxrss across fork+exec, so a child spawned by a large server would
    report the server's size."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    # ru_maxrss is KiB on Linux.
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


_MAX_REQUEST_DATA = 64 * 1024 * 1024


def _read_frame(stream, wait_seconds: float | None) -> tuple[dict, bytes] | None:
    """One request frame (header, data), or None on EOF or when nothing
    arrives within wait_seconds."""
    fd = stream.fileno()
    if wait_seconds:
        ready, _, _ = select.select([fd], [], [], wait_seconds)
        if not ready:
            return None
    header = _read_exact(stream, 4)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length > 64 * 1024 * 1024:
        return None
    body = _read_exact(stream, length)
    if body is None:
        return None
    request = json.loads(body.decode("utf-8"))
    data_len = int(request.get("data_len") or 0)
    if data_len > _MAX_REQUEST_DATA:
        return None
    data = _read_exact(stream, data_len) if data_len else b""
    if data is None:
        return None
    return request, data


def _read_exact(stream, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def _write_response(stream, header: dict, payload: bytes = b"", length_key: str = "pdf_len") -> None:
    if payload:
        header = dict(header, **{length_key: len(payload)})
    body = json.dumps(header, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack(">I", len(body)) + body + payload)
    stream.flush()


# Uploaded-PDF parsing (plan 4.1). PDFium is not thread-safe and the input is
# untrusted, so it only ever runs here, under the same caps as rendering.
_MAX_EXTRACT_PAGES = 2_000
_MAX_TEXT_CHARS = 8_000_000
_MAX_RENDER_PAGES = 20


def _parse(op: str, data: bytes, params: dict) -> tuple[dict, bytes]:
    import io

    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        kind = "encrypted" if "password" in str(e).lower() else "unreadable"
        return {"status": "error", "kind": kind}, b""
    try:
        pages = len(pdf)
        if op == "inspect_extract":
            texts: list[str] = []
            total = 0
            for i in range(min(pages, _MAX_EXTRACT_PAGES)):
                page = pdf[i]
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range()
                finally:
                    textpage.close()
                    page.close()
                text = text.replace("\r\n", "\n").replace("\r", "\n")
                total += len(text)
                if total > _MAX_TEXT_CHARS:
                    text = ""
                texts.append(text)
            payload = json.dumps(texts, ensure_ascii=False).encode("utf-8")
            return {"status": "ok", "pages": pages,
                    "page_chars": [len(t.strip()) for t in texts]}, payload
        if op == "render_pages":
            from PIL import Image

            wanted = [int(p) for p in (params.get("pages") or []) if 0 <= int(p) < pages]
            max_edge = max(256, min(int(params.get("max_edge") or 1568), 4096))
            images: list[bytes] = []
            for i in wanted[:_MAX_RENDER_PAGES]:
                page = pdf[i]
                try:
                    width, height = page.get_size()
                    scale = min(max_edge / max(width, height, 1.0), 4.0)
                    bitmap = page.render(scale=scale)
                    image = bitmap.to_pil().convert("RGB")
                finally:
                    page.close()
                if max(image.size) > max_edge:
                    image.thumbnail((max_edge, max_edge), Image.LANCZOS)
                buf = io.BytesIO()
                image.save(buf, "JPEG", quality=80, optimize=True)
                images.append(buf.getvalue())
            return {"status": "ok", "pages": pages,
                    "image_lens": [len(b) for b in images]}, b"".join(images)
        return {"status": "error", "kind": "error"}, b""
    finally:
        pdf.close()


def _handle(request: dict, params: dict, data: bytes = b"") -> tuple[dict, bytes, str]:
    op = request.get("op")
    _arm_cpu_cap(int(params.get("max_cpu_seconds") or 115))
    if op in ("inspect_extract", "render_pages"):
        try:
            header, payload = _parse(op, data, request.get("params") or {})
        except MemoryError:
            header, payload = {"status": "error", "kind": "oom"}, b""
        except Exception:
            header, payload = {"status": "error", "kind": "error"}, b""
        header["peak_rss_bytes"] = _peak_rss_bytes()
        header["rss_after_bytes"] = _rss_bytes()
        return header, payload, "payload_len"
    if op != "render":
        return {"status": "error", "kind": "error"}, b"", "pdf_len"

    from graph_tools.tools.generate_pdf import render_job

    try:
        result = render_job(request.get("job") or {})
    except MemoryError:
        result = {"status": "error", "kind": "oom"}
    pdf = result.pop("pdf", b"") if result.get("status") == "ok" else b""
    header = {k: v for k, v in result.items() if k != "pdf"}
    header["peak_rss_bytes"] = _peak_rss_bytes()
    header["rss_after_bytes"] = _rss_bytes()
    return header, pdf, "pdf_len"


def _preload(kind: str) -> float:
    """Import what the job needs before reading it, so the import cost is
    reported apart from the job's (spawn_cpu_seconds). Returns the CPU
    seconds the imports took."""
    start = time.process_time()
    if kind == "parse":
        import pypdfium2  # noqa: F401
        from PIL import Image  # noqa: F401
    else:
        import graph_tools.tools.generate_pdf  # noqa: F401

        try:
            from graph_tools.tools import pdf_typst

            # Caps glibc's per-thread malloc arenas in this process only
            # (the parent also sets MALLOC_ARENA_MAX for the child).
            pdf_typst.prepare_render_process()
            import typst  # noqa: F401
        except ImportError:
            pass  # render_job reports the renderer as unsupported
    return round(time.process_time() - start, 3)


_SELFTEST_MD = "# Selftest\n\nLatin text, a list:\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"


def _selftest() -> int:
    """The Docker smoke step: Typst renders a mixed-script page with the
    bundled fonts and the vendored mitex (pdf_typst.selftest), a document
    renders through render_job, the production entry point, and PDFium
    extracts its text and rasterizes its page. 0 only when all of it works."""
    try:
        from graph_tools.tools import pdf_typst
        from graph_tools.tools.generate_pdf import render_job

        pdf_typst.selftest()
    except Exception:
        return 1
    result = render_job({"renderer": "typst", "markdown": _SELFTEST_MD, "title": None,
                         "options": {"locale": "en-US"}})
    if result.get("status") != "ok" or not result.get("pdf", b"").startswith(b"%PDF"):
        return 1
    header, payload = _parse("inspect_extract", result["pdf"], {})
    if header.get("status") != "ok" or header.get("pages") != 1:
        return 1
    if "Selftest" not in "".join(json.loads(payload.decode("utf-8"))):
        return 1
    header, payload = _parse("render_pages", result["pdf"], {"pages": [0], "max_edge": 512})
    if header.get("status") != "ok" or not payload.startswith(b"\xff\xd8"):
        return 1
    return 0


# How long a child waits for its one job: the parent writes it right after
# the spawn, so a child that gets nothing (its parent was cancelled while it
# started) exits instead of lingering.
REQUEST_WAIT_SECONDS = 60


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    params = json.loads(args[0]) if args else {}
    if "--selftest" in flags:
        _limit_self({**params, "seccomp": True})
        return _selftest()
    _limit_self(params)
    spawn_cpu = _preload(params.get("kind") or "typst")
    frame = _read_frame(sys.stdin.buffer, REQUEST_WAIT_SECONDS)
    if frame is None:
        return 0
    request, data = frame
    header, payload, length_key = _handle(request, params, data)
    header["spawn_cpu_seconds"] = spawn_cpu
    _write_response(sys.stdout.buffer, header, payload, length_key)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
