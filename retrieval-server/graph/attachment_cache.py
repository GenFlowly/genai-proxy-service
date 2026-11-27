"""Prepared attachment payloads (images, PDF forms), shared by every request
that needs them.

A turn sent to several vendors runs one graph per vendor, and each of them
needs the same attachments within the same second. A payload is prepared
once: a request for a key that is already being prepared waits for that
preparation instead of starting its own, and every caller gets the same
string object, so N vendors hold one copy rather than N.

Entries are bounded by their total size (LRU). An entry may also expire after
being idle, for payloads only one turn wants: a PDF goes out with its own turn
and is never replayed with the history. One object stored under several keys
is charged once.
"""
import asyncio
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import Executor, Future
from typing import Any, Callable, Hashable, Optional, TypeVar

from encoding_library.observability import count

T = TypeVar("T")


class AttachmentCache:
    def __init__(self, max_bytes: int):
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        # key -> (value, idle_ttl_s or None, expires_at or None); order = LRU order
        self._entries: OrderedDict[Hashable, tuple[Any, Optional[float], Optional[float]]] = OrderedDict()
        # id(value) -> [cost, number of keys holding it]. A value is alive while
        # it is charged (the entries hold it), so its id cannot be reused.
        self._charges: dict[int, list[int]] = {}
        self._bytes = 0
        self._inflight: dict[Hashable, Future] = {}

    @property
    def size_bytes(self) -> int:
        with self._lock:
            return self._bytes

    def get(self, key: Hashable, default: Any = None) -> Any:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return default
            value, ttl, expires_at = entry
            if expires_at is not None and now >= expires_at:
                self._drop(key)
                return default
            if ttl is not None:
                self._entries[key] = (value, ttl, now + ttl)
            self._entries.move_to_end(key)
            return value

    def put(self, key: Hashable, value: Any, cost: int, idle_ttl_s: Optional[float] = None) -> None:
        if cost > self._max_bytes:
            return
        now = time.monotonic()
        with self._lock:
            if key in self._entries:
                self._drop(key)
            charge = self._charges.get(id(value))
            if charge is None:
                self._charges[id(value)] = [cost, 1]
                self._bytes += cost
            else:
                charge[1] += 1
            self._entries[key] = (value, idle_ttl_s, None if idle_ttl_s is None else now + idle_ttl_s)
            self._purge_expired(now)
            while self._bytes > self._max_bytes:
                self._drop(next(iter(self._entries)))

    def purge_expired(self) -> int:
        """Drop expired entries; returns how many."""
        with self._lock:
            return self._purge_expired(time.monotonic())

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._charges.clear()
            self._bytes = 0

    async def get_or_prepare(self, key: Hashable, prepare: Callable[[], T], executor: Executor, *,
                             cost: Callable[[T], int], data_type: str,
                             idle_ttl_s: Optional[float] = None) -> T:
        """The cached value for `key`, else prepare() run on `executor` and
        cached. Concurrent callers for one key share a single preparation and
        get the same object; a failure reaches all of them and is not cached."""
        value = self.get(key)
        if value is not None:
            count("attachment_cache_total", data_type=data_type, status="hit")
            return value
        with self._lock:
            future = self._inflight.get(key)
            joined = future is not None
            if future is None:
                future = executor.submit(self._prepare, key, prepare, cost, idle_ttl_s)
                self._inflight[key] = future
        count("attachment_cache_total", data_type=data_type, status="joined" if joined else "prepared")
        waiter = asyncio.wrap_future(future)
        # A cancelled caller (the user's Stop) must not cancel the preparation
        # other callers are waiting on; its own wrapper still settles quietly.
        waiter.add_done_callback(lambda f: f.cancelled() or f.exception())
        return await asyncio.shield(waiter)

    def _prepare(self, key, prepare, cost, idle_ttl_s):
        try:
            value = self.get(key)
            if value is None:
                value = prepare()
                self.put(key, value, cost(value), idle_ttl_s)
            return value
        finally:
            with self._lock:
                self._inflight.pop(key, None)

    def _drop(self, key: Hashable) -> None:
        value = self._entries.pop(key)[0]
        charge = self._charges[id(value)]
        charge[1] -= 1
        if charge[1] == 0:
            del self._charges[id(value)]
            self._bytes -= charge[0]

    def _purge_expired(self, now: float) -> int:
        expired = [k for k, (_, _, expires_at) in self._entries.items() if expires_at is not None and now >= expires_at]
        for key in expired:
            self._drop(key)
        return len(expired)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# 64 MiB of base64 holds a dozen full-budget images or ~40 at the tiers long
# threads get, plus a turn's PDF; sized against the 1 GB VM.
CACHE = AttachmentCache(_env_int("ATTACHMENT_CACHE_BYTES", 64 * 1024 * 1024))
