"""The process-wide slot for heavy jobs.

Production runs ONE machine of the smallest Fly size (1 GB, shared CPU) for
every tenant. Two heavy jobs at once can exhaust it, so image decode/encode
(graph/image_normalize.py, including its camera-RAW child), PDF rendering
(graph/pdf_worker.py: Typst render children) and PDF parsing all take
this one slot: at most one heavy child or heavy in-process job runs at a time.

A plain threading.Lock: image work holds it from worker threads, the PDF
worker acquires it from the event loop through `acquire_async`, which bounds
the wait and never leaks the lock when the waiting coroutine is cancelled.
"""
import asyncio
import threading

HEAVY_LOCK = threading.Lock()


async def acquire_async(lock: threading.Lock = HEAVY_LOCK, timeout: float = 30.0) -> bool:
    """Acquire `lock` without blocking the event loop. Returns False when it
    could not be acquired within `timeout` seconds.

    If the awaiting task is cancelled while the executor thread is still
    waiting, the lock is released as soon as that thread gets it, so a
    cancelled request can never hold the slot forever."""
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(None, lock.acquire, True, timeout)
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        def _release_if_acquired(f: asyncio.Future) -> None:
            if not f.cancelled() and f.exception() is None and f.result():
                lock.release()

        fut.add_done_callback(_release_if_acquired)
        raise
