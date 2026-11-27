"""Returns memory the process has finished with to the OS.

Two things keep finished-with memory counted in RSS on this server:

* Reference cycles hold large buffers until Python's next full collection.
  Every LLM call leaves its whole request body (every image it sent) in a
  cycle among the httpx/httpcore request, response and stream objects, and in
  a process this size full collections run about once an hour.
* glibc keeps freed blocks below the top of its heaps mapped until
  malloc_trim() is called.

release() runs a full collection, then malloc_trim(0). It runs shortly after
each agent run ends (once for all the runs of a turn, which end together), and
once a minute when other requests came in or expired attachments were dropped.
A full collection pauses the event loop (0.1-0.5 s measured on one shared
CPU), which is why it is neither done per request nor while idle.
"""
import asyncio
import ctypes
import gc
import logging
import os
import time
from typing import Callable, Optional

from encoding_library.observability import count, observe

logger = logging.getLogger(__name__)

try:
    _malloc_trim = ctypes.CDLL("libc.so.6").malloc_trim
except (OSError, AttributeError):
    _malloc_trim = None  # not glibc (macOS dev machines)

RUN_END_DELAY_SEC = 2.0
PERIODIC_SEC = float(os.getenv("MEMORY_RELEASE_INTERVAL_SEC", "60"))

_PAGE_SIZE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
_pending: Optional[tuple[asyncio.AbstractEventLoop, asyncio.TimerHandle]] = None
_activity = False


def note_activity() -> None:
    """A request came in: the next periodic release has something to free."""
    global _activity
    _activity = True


def _rss_bytes() -> Optional[int]:
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * _PAGE_SIZE
    except (OSError, ValueError, IndexError):
        return None


def release(operation: str) -> int:
    """Full garbage collection, then malloc_trim(0). Returns the RSS it gave
    back to the OS, in bytes (0 where RSS isn't readable)."""
    global _activity
    _activity = False
    started = time.perf_counter()
    before = _rss_bytes()
    gc.collect()
    if _malloc_trim is not None:
        _malloc_trim(0)
    after = _rss_bytes()
    released = max(0, before - after) if before is not None and after is not None else 0
    observe("memory_release_duration_seconds", time.perf_counter() - started, operation=operation)
    count("memory_released_bytes_total", released, operation=operation)
    return released


def release_soon() -> None:
    """release() RUN_END_DELAY_SEC from now, unless one is already scheduled:
    the vendors of one turn finish within seconds of each other."""
    global _pending
    loop = asyncio.get_running_loop()
    if _pending is not None and _pending[0] is loop and not _pending[1].cancelled():
        return
    _pending = (loop, loop.call_later(RUN_END_DELAY_SEC, _release_pending))


def _release_pending() -> None:
    global _pending
    _pending = None
    release("run_end")


async def release_periodically(before_release: Optional[Callable[[], int]] = None) -> None:
    """Every PERIODIC_SEC: `before_release` (returns how many things it
    dropped), then release() if that dropped something or requests came in."""
    while True:
        await asyncio.sleep(PERIODIC_SEC)
        try:
            dropped = before_release() if before_release is not None else 0
            if _activity or dropped:
                release("periodic")
        except Exception:
            logger.exception("Periodic memory release failed")
