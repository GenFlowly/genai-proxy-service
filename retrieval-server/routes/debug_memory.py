"""Env-gated memory debugging endpoint.

Off by default and 404s when disabled, so the surface doesn't exist in normal
operation. During an investigation window, enable with
`fly secrets set MEMORY_DEBUG_ENDPOINT=1` (the restart starts tracemalloc at
boot) and remove the secret afterwards — tracemalloc costs CPU and memory and
must never stay on. The app is internal-only behind the Kotlin proxy; the
payload contains allocation sites (file:line), never request or customer data.
"""
import gc
import os
import tracemalloc

from fastapi import APIRouter, HTTPException

router = APIRouter()

_TRACE_FRAMES = 25


def _enabled() -> bool:
    return os.environ.get("MEMORY_DEBUG_ENDPOINT") == "1"


if _enabled():
    tracemalloc.start(_TRACE_FRAMES)


def _rss_bytes():
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        return None
    return None


@router.get("/debug/memory")
async def memory_snapshot(top: int = 20):
    if not _enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    if not tracemalloc.is_tracing():
        # Enabled after boot (first call pays the start; sites accumulate from
        # here, so the second call onward is the useful one).
        tracemalloc.start(_TRACE_FRAMES)

    payload = {
        "rss_bytes": _rss_bytes(),
        "gc": {
            "counts": gc.get_count(),
            "uncollectable": len(gc.garbage),
        },
    }
    current, peak = tracemalloc.get_traced_memory()
    payload["traced"] = {"current_bytes": current, "peak_bytes": peak}
    stats = tracemalloc.take_snapshot().statistics("lineno")[: max(1, min(top, 100))]
    payload["top_allocations"] = [
        {"site": str(stat.traceback[0]), "size_bytes": stat.size, "count": stat.count}
        for stat in stats
    ]
    return payload
