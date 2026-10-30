"""Bounded in-process cache shared by the module-level loader caches.

Those caches used to be plain dicts that refreshed entries in place but never
evicted, so a process accumulated an entry for every customer/graph/instruction
ever touched since boot (RetrievalServerMemoryLeakIncidentOct2026 §8.3). This
mapping bounds them: LRU eviction past max_size, and — when a TTL is set —
expired entries are deleted on access and insert rather than lingering as
stale values.
"""
import threading
import time
from collections import OrderedDict
from typing import Any, Hashable, Optional


class BoundedCache:
    """Lock-guarded dict-like mapping with LRU bounding and optional TTL.

    get() returns `default` for a missing OR expired key — callers that cache
    None values pass a sentinel default to tell the two apart. Without a TTL,
    entries live until pop/clear or LRU eviction, so callers that do their own
    staleness checks (e.g. to serve stale data when a reload fails) keep access
    to old entries.
    """

    def __init__(self, max_size: int, ttl_seconds: Optional[float] = None):
        if max_size <= 0:
            raise ValueError("max_size must be positive")
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        # key -> (stored_at_monotonic, value); insertion/access order = LRU order.
        self._entries: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()

    def _expired(self, stored_at: float, now: float) -> bool:
        return self._ttl is not None and now - stored_at >= self._ttl

    def _purge_expired(self, now: float) -> None:
        if self._ttl is None:
            return
        expired = [k for k, (stored_at, _) in self._entries.items() if self._expired(stored_at, now)]
        for key in expired:
            del self._entries[key]

    def get(self, key: Hashable, default: Any = None) -> Any:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return default
            if self._expired(entry[0], now):
                del self._entries[key]
                return default
            self._entries.move_to_end(key)
            return entry[1]

    def set(self, key: Hashable, value: Any) -> None:
        now = time.monotonic()
        with self._lock:
            self._purge_expired(now)
            self._entries[key] = (now, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_size:
                self._entries.popitem(last=False)

    def pop(self, key: Hashable, default: Any = None) -> Any:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.pop(key, None)
            if entry is None or self._expired(entry[0], now):
                return default
            return entry[1]

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            self._purge_expired(time.monotonic())
            return len(self._entries)

    def __contains__(self, key: Hashable) -> bool:
        sentinel = object()
        return self.get(key, sentinel) is not sentinel
