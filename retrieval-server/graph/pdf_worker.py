"""Host side of PDF rendering: runs generate_pdf.render_job in a child process.

One large table could exhaust the shared 1 GB machine when xhtml2pdf rendered
inside the server: 2,000 rows took 52-68 s and peaked at 0.9-1.4 GB, an
asyncio.to_thread render can't be cancelled, and it stalls the event loop
(GIL). With durable runs that was not one crash but a crash loop: recovery
replayed the same render after every restart. Here the render runs in
graph/pdf_render_child.py under an address-space cap, so a too-large document
costs one child and becomes a tool error ("oom") instead.

- x2p_v1: one WARM child, started lazily and reused, because importing
  xhtml2pdf costs 0.5-0.8 CPU-s, often more than the render. Recycled after
  RECYCLE_RENDERS renders or when it reports more than RECYCLE_RSS_MB of RSS
  after a render; it exits by itself after IDLE_SECONDS without work, so
  there is no idle RSS when nobody makes PDFs.
- typst: a fresh ONE-SHOT child per render (Typst imports in ~0.04 s).
- parse (plan 4.1): uploaded PDFs are inspected, their text extracted and
  pages rendered to JPEG by PDFium in a fresh one-shot child too (PDFium is
  not thread-safe, and the input is untrusted); the server process never
  imports pypdfium2.
- Before a one-shot child starts, the idle warm x2p child is stopped: the
  machine-wide bound is one heavy child at its address-space cap, next to
  the server's own baseline.
- Every job takes the process-wide heavy slot (graph/heavy_slot.py, shared
  with image normalization) with a bounded wait: past QUEUE_WAIT_SECONDS the
  tool returns "busy" instead of queueing towards the proxy's idle timeout.
- A job that takes longer than RENDER_TIMEOUT_SECONDS wall clock is killed
  with its whole process group and reaped; the next job respawns lazily.
- The child gets a scrubbed environment (no AWS_*, DATABASE_URL or API keys)
  and runs as `nobody` when the server runs as root; its stderr goes to
  /dev/null and only structured status/kind is ever logged here.

The callable `render_pdf(job)` is injected into ToolContext.runtime by the
tool executor; generate_pdf awaits it.
"""
import asyncio
import json
import logging
import os
import shutil
import signal
import struct
import sys
import tempfile
import time

from graph import heavy_slot

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


QUEUE_WAIT_SECONDS = _env_int("PDF_QUEUE_WAIT_SECONDS", 30)
RENDER_TIMEOUT_SECONDS = _env_int("PDF_RENDER_TIMEOUT_SECONDS", 120)
RECYCLE_RENDERS = _env_int("PDF_WORKER_RECYCLE_RENDERS", 25)
RECYCLE_RSS_MB = _env_int("PDF_WORKER_RECYCLE_RSS_MB", 300)
IDLE_SECONDS = _env_int("PDF_WORKER_IDLE_SECONDS", 600)
# Address-space caps per renderer (calibrate on the Fly dev app).
X2P_RLIMIT_MB = _env_int("PDF_RENDER_RLIMIT_MB", 400)
TYPST_RLIMIT_MB = _env_int("PDF_TYPST_RLIMIT_MB", 512)
PARSE_RLIMIT_MB = _env_int("PDF_PARSE_RLIMIT_MB", 512)
PARSE_TIMEOUT_SECONDS = _env_int("PDF_PARSE_TIMEOUT_SECONDS", 60)
MAX_CPU_SECONDS = _env_int("PDF_RENDER_CPU_SECONDS", 115)
# The uid/gid the child runs as when the server runs as root (nobody).
CHILD_UID = _env_int("PDF_CHILD_UID", 65534)
# Bounds on what a child may send back (an exploited child must not fill
# the server's memory through the pipe).
_MAX_HEADER = 1 * 1024 * 1024
_MAX_PDF = 256 * 1024 * 1024

_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ENV_PASSTHROUGH = ("PATH", "LANG")


def _child_env(tmpdir: str) -> dict:
    env = {k: os.environ[k] for k in _ENV_PASSTHROUGH if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.update({
        "LC_ALL": "C.UTF-8",
        "TMPDIR": tmpdir,
        "HOME": tmpdir,
        "OMP_NUM_THREADS": "1",
        "RAYON_NUM_THREADS": "1",
        # glibc reserves a 64 MB arena per thread: Typst's worker threads
        # would push a 2,000-row table past the address-space cap.
        "MALLOC_ARENA_MAX": "2",
    })
    for key, value in os.environ.items():
        if key.startswith("PDF_"):
            env[key] = value
    return env


def _child_identity() -> dict:
    if not hasattr(os, "geteuid") or os.geteuid() != 0 or CHILD_UID == 0:
        return {}
    return {"user": CHILD_UID, "group": CHILD_UID, "extra_groups": []}


class _Child:
    """One running child process and its private temp dir."""

    def __init__(self, renderer: str, proc: asyncio.subprocess.Process, tmpdir: str):
        self.renderer = renderer
        self.proc = proc
        self.tmpdir = tmpdir
        self.renders = 0
        self.spawned_at = time.monotonic()

    @property
    def alive(self) -> bool:
        return self.proc.returncode is None

    async def kill(self) -> None:
        if self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    self.proc.kill()
                except ProcessLookupError:
                    pass
        try:
            await asyncio.wait_for(self.proc.wait(), 10)
        except asyncio.TimeoutError:  # pragma: no cover - kernel trouble
            logger.error("pdf worker child %s did not exit after SIGKILL", self.proc.pid)
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class PdfWorker:
    """Renders jobs in child processes; one at a time per process."""

    def __init__(self):
        self._warm: _Child | None = None

    async def _spawn(self, renderer: str, oneshot: bool) -> _Child:
        tmpdir = tempfile.mkdtemp(prefix="pdf-child-")
        identity = _child_identity()
        if identity:
            os.chown(tmpdir, identity["user"], identity["group"])
        rlimit_mb = {"typst": TYPST_RLIMIT_MB, "parse": PARSE_RLIMIT_MB}.get(renderer, X2P_RLIMIT_MB)
        params = {
            "renderer": renderer,
            "max_address_space": rlimit_mb * 1024 * 1024,
            "max_cpu_seconds": MAX_CPU_SECONDS,
            "idle_seconds": IDLE_SECONDS,
        }
        argv = [sys.executable, "-E", "-s", "-m", "graph.pdf_render_child", json.dumps(params)]
        if oneshot:
            argv.append("--oneshot")
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=_APP_DIR,
            env=_child_env(tmpdir),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            limit=_MAX_HEADER,
            **identity,
        )
        return _Child(renderer, proc, tmpdir)

    async def _exchange(self, child: _Child, request: dict, data: bytes = b"") -> tuple[dict, bytes]:
        if data:
            request = dict(request, data_len=len(data))
        body = json.dumps(request, separators=(",", ":")).encode("utf-8")
        assert child.proc.stdin is not None and child.proc.stdout is not None
        child.proc.stdin.write(struct.pack(">I", len(body)) + body + data)
        await child.proc.stdin.drain()
        (length,) = struct.unpack(">I", await child.proc.stdout.readexactly(4))
        if length > _MAX_HEADER:
            raise ValueError("oversized response header")
        header = json.loads((await child.proc.stdout.readexactly(length)).decode("utf-8"))
        payload_len = int(header.get("pdf_len") or header.get("payload_len") or 0)
        if payload_len > _MAX_PDF:
            raise ValueError("oversized payload")
        payload = await child.proc.stdout.readexactly(payload_len) if payload_len else b""
        return header, payload

    async def render(self, job: dict) -> dict:
        """Render one generate_pdf job. Returns render_job's result shape plus
        queue_wait_seconds; never raises for a render failure."""
        renderer = job.get("renderer") or "x2p_v1"
        waited_from = time.monotonic()
        if not await heavy_slot.acquire_async(heavy_slot.HEAVY_LOCK, QUEUE_WAIT_SECONDS):
            return {"status": "error", "kind": "busy", "renderer": renderer,
                    "queue_wait_seconds": round(time.monotonic() - waited_from, 3)}
        queue_wait = round(time.monotonic() - waited_from, 3)
        try:
            result = await self._render_locked(renderer, job)
        finally:
            heavy_slot.HEAVY_LOCK.release()
        result["queue_wait_seconds"] = queue_wait
        result.setdefault("renderer", renderer)
        return result

    async def _render_locked(self, renderer: str, job: dict) -> dict:
        oneshot = renderer != "x2p_v1"
        child = None
        try:
            if oneshot:
                await self._stop_warm()
                child = await self._spawn(renderer, oneshot=True)
            else:
                if self._warm is None or not self._warm.alive:
                    if self._warm is not None:
                        await self._warm.kill()
                    self._warm = await self._spawn(renderer, oneshot=False)
                child = self._warm
        except OSError as e:
            logger.error("pdf worker: child could not be started (%s)", type(e).__name__)
            return {"status": "error", "kind": "error"}

        try:
            header, pdf = await asyncio.wait_for(
                self._exchange(child, {"op": "render", "job": job}), RENDER_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            logger.warning("pdf render timed out after %ss; killing the child", RENDER_TIMEOUT_SECONDS)
            await self._discard(child)
            return {"status": "error", "kind": "timeout"}
        except (asyncio.IncompleteReadError, BrokenPipeError, ConnectionResetError, ValueError) as e:
            # The child died mid-job: SIGKILL (kernel OOM killer) or a crash,
            # SIGXCPU (its CPU allowance), or garbage on the pipe.
            await self._discard(child)
            code = child.proc.returncode
            # SIGKILL: the kernel OOM killer; SIGABRT: Typst aborts when an
            # allocation fails under the address-space cap.
            kind = "oom" if code in (-signal.SIGKILL, -signal.SIGABRT) else (
                "timeout" if code == -signal.SIGXCPU else "error")
            logger.warning("pdf render child failed (rc=%s, %s) -> %s", code, type(e).__name__, kind)
            return {"status": "error", "kind": kind}

        child.renders += 1
        failed = header.get("status") != "ok"
        if oneshot:
            await child.kill()
        else:
            rss_mb = int(header.get("rss_after_bytes") or 0) / (1024 * 1024)
            # After a failure (an out-of-memory error in particular) the
            # child's heap is suspect: start fresh next time.
            if failed or child.renders >= RECYCLE_RENDERS or rss_mb > RECYCLE_RSS_MB:
                await self._discard(child)
        result = {k: v for k, v in header.items() if k != "pdf_len"}
        if "peak_rss_bytes" in result:
            result["child_peak_rss_bytes"] = result.pop("peak_rss_bytes")
        if failed:
            logger.warning("pdf render failed: status=%s kind=%s", header.get("status"), header.get("kind"))
            return result
        result["pdf"] = pdf
        return result

    async def _discard(self, child: _Child) -> None:
        await child.kill()
        if child is self._warm:
            self._warm = None

    async def _stop_warm(self) -> None:
        if self._warm is not None:
            await self._discard(self._warm)

    async def parse(self, op: str, data: bytes, params: dict | None = None) -> tuple[dict, bytes]:
        """Run a PDF parse op ("inspect_extract" or "render_pages") on an
        uploaded PDF in a one-shot child. Returns (header, payload); a failure
        is a header with status "error" and kind busy | timeout | oom |
        encrypted | unreadable | error, never an exception."""
        waited_from = time.monotonic()
        if not await heavy_slot.acquire_async(heavy_slot.HEAVY_LOCK, QUEUE_WAIT_SECONDS):
            return {"status": "error", "kind": "busy",
                    "queue_wait_seconds": round(time.monotonic() - waited_from, 3)}, b""
        queue_wait = round(time.monotonic() - waited_from, 3)
        try:
            header, payload = await self._parse_locked(op, data, params or {})
        finally:
            heavy_slot.HEAVY_LOCK.release()
        header["queue_wait_seconds"] = queue_wait
        return header, payload

    async def _parse_locked(self, op: str, data: bytes, params: dict) -> tuple[dict, bytes]:
        await self._stop_warm()
        try:
            child = await self._spawn("parse", oneshot=True)
        except OSError as e:
            logger.error("pdf worker: parse child could not be started (%s)", type(e).__name__)
            return {"status": "error", "kind": "error"}, b""
        try:
            header, payload = await asyncio.wait_for(
                self._exchange(child, {"op": op, "params": params}, data), PARSE_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            logger.warning("pdf parse timed out after %ss; killing the child", PARSE_TIMEOUT_SECONDS)
            return {"status": "error", "kind": "timeout"}, b""
        except (asyncio.IncompleteReadError, BrokenPipeError, ConnectionResetError, ValueError) as e:
            await child.kill()
            code = child.proc.returncode
            kind = "oom" if code == -signal.SIGKILL else (
                "timeout" if code == -signal.SIGXCPU else "error")
            logger.warning("pdf parse child failed (rc=%s, %s) -> %s", code, type(e).__name__, kind)
            return {"status": "error", "kind": kind}, b""
        finally:
            await child.kill()
        if "peak_rss_bytes" in header:
            header["child_peak_rss_bytes"] = header.pop("peak_rss_bytes")
        header.pop("payload_len", None)
        return header, payload if header.get("status") == "ok" else b""

    async def close(self) -> None:
        if self._warm is not None:
            await self._discard(self._warm)


_worker: PdfWorker | None = None


def get_worker() -> PdfWorker:
    global _worker
    if _worker is None:
        _worker = PdfWorker()
    return _worker


async def render_pdf(job: dict) -> dict:
    """The runtime['render_pdf'] callable."""
    return await get_worker().render(job)


async def parse_pdf(op: str, data: bytes, params: dict | None = None) -> tuple[dict, bytes]:
    """Inspect / extract / render pages of an uploaded PDF (plan 4.1)."""
    return await get_worker().parse(op, data, params)


async def shutdown() -> None:
    if _worker is not None:
        await _worker.close()
