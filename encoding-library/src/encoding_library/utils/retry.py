"""Retry with exponential backoff for third-party API calls.

Every outbound call to a third-party service (Zilliz/Milvus, Voyage/OpenAI
embeddings, Tavily, ...) goes through this module — see the "Observability"
section of genai-proxy-server/development.md. LLM chat calls are the one
exception: they retry inside the vendor SDKs (``max_retries`` in
llm_factory), because re-issuing a generation from our layer can double-bill
when the original request actually succeeded.

Backoff: delay = min(max_delay, base_delay * backoff_rate**attempt), with
equal jitter (uniform in [delay/2, delay]) so synchronized callers fan out.

Each retry emits ``retry_attempt_total{operation}`` and exhaustion emits
``retry_exhausted_total{operation}`` (see encoding_library.observability),
so "we only succeeded on the 3rd try" is visible on dashboards before it
becomes an outage.

Usage:

    @retry("tavily", retry_if=is_transient_http_error)
    async def call_tavily(...): ...

    result = retry_call(client.insert, ..., operation="milvus")

    client = RetryingProxy(MilvusClient(...), operation="milvus")
"""
from __future__ import annotations

import asyncio
import functools
import inspect
import logging
import random
import time
from typing import Any, Callable, Optional, Tuple, Type

from encoding_library.observability import count

logger = logging.getLogger(__name__)

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BASE_DELAY = 0.5
DEFAULT_BACKOFF_RATE = 2.0
DEFAULT_MAX_DELAY = 8.0


def is_transient_http_error(exc: BaseException) -> bool:
    """retry_if predicate for HTTP client errors (httpx and requests alike).

    Retries connection/timeout errors (no response attached) and 429/5xx
    responses; never retries other 4xx — a 401/404 won't heal with backoff.
    """
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        return True
    return status == 429 or status >= 500


def _delay_for(attempt: int, base_delay: float, backoff_rate: float, max_delay: float) -> float:
    delay = min(max_delay, base_delay * (backoff_rate ** attempt))
    return random.uniform(delay / 2, delay)


def _should_retry(exc: BaseException,
                  retry_on: Tuple[Type[BaseException], ...],
                  retry_if: Optional[Callable[[BaseException], bool]]) -> bool:
    if not isinstance(exc, retry_on):
        return False
    if retry_if is not None:
        try:
            return bool(retry_if(exc))
        except Exception:
            return True
    return True


def _on_retry(operation: str, attempt: int, max_attempts: int,
              exc: BaseException, delay: float) -> None:
    count("retry_attempt_total", operation=operation)
    logger.warning(
        "Retry %d/%d for %s in %.2fs after: %s",
        attempt + 1, max_attempts - 1, operation, delay, exc,
    )


def _on_exhausted(operation: str, max_attempts: int, exc: BaseException) -> None:
    count("retry_exhausted_total", operation=operation)
    logger.error("All %d attempts failed for %s: %s", max_attempts, operation, exc)


def retry(operation: str,
          max_attempts: int = DEFAULT_MAX_ATTEMPTS,
          base_delay: float = DEFAULT_BASE_DELAY,
          backoff_rate: float = DEFAULT_BACKOFF_RATE,
          max_delay: float = DEFAULT_MAX_DELAY,
          retry_on: Tuple[Type[BaseException], ...] = (Exception,),
          retry_if: Optional[Callable[[BaseException], bool]] = None):
    """Decorator: retry the wrapped sync or async callable with backoff.

    retry_on: exception types eligible for retry (others re-raise at once).
    retry_if: optional predicate refining retry_on, e.g. "HTTP 5xx/429 only".
    """
    def decorator(fn):
        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args, **kwargs):
                for attempt in range(max_attempts):
                    try:
                        return await fn(*args, **kwargs)
                    except BaseException as exc:
                        if attempt >= max_attempts - 1 or not _should_retry(exc, retry_on, retry_if):
                            if attempt >= max_attempts - 1 and _should_retry(exc, retry_on, retry_if):
                                _on_exhausted(operation, max_attempts, exc)
                            raise
                        delay = _delay_for(attempt, base_delay, backoff_rate, max_delay)
                        _on_retry(operation, attempt, max_attempts, exc, delay)
                        await asyncio.sleep(delay)
            return async_wrapper

        @functools.wraps(fn)
        def sync_wrapper(*args, **kwargs):
            for attempt in range(max_attempts):
                try:
                    return fn(*args, **kwargs)
                except BaseException as exc:
                    if attempt >= max_attempts - 1 or not _should_retry(exc, retry_on, retry_if):
                        if attempt >= max_attempts - 1 and _should_retry(exc, retry_on, retry_if):
                            _on_exhausted(operation, max_attempts, exc)
                        raise
                    delay = _delay_for(attempt, base_delay, backoff_rate, max_delay)
                    _on_retry(operation, attempt, max_attempts, exc, delay)
                    time.sleep(delay)
        return sync_wrapper

    return decorator


def retry_call(fn: Callable, *args,
               operation: str = "external_call",
               max_attempts: int = DEFAULT_MAX_ATTEMPTS,
               base_delay: float = DEFAULT_BASE_DELAY,
               backoff_rate: float = DEFAULT_BACKOFF_RATE,
               max_delay: float = DEFAULT_MAX_DELAY,
               retry_on: Tuple[Type[BaseException], ...] = (Exception,),
               retry_if: Optional[Callable[[BaseException], bool]] = None,
               **kwargs) -> Any:
    """Imperative form: call ``fn(*args, **kwargs)`` with retry/backoff."""
    wrapped = retry(operation, max_attempts=max_attempts, base_delay=base_delay,
                    backoff_rate=backoff_rate, max_delay=max_delay,
                    retry_on=retry_on, retry_if=retry_if)(fn)
    return wrapped(*args, **kwargs)


class RetryingProxy:
    """Wraps a client object so every public method call retries with backoff.

    Used for MilvusClient: all Zilliz traffic (search/insert/delete/...) gets
    the same retry policy without touching each call site. Non-callable
    attributes pass through untouched.

    Note on idempotency: retries fire only when the call RAISED. For Milvus
    insert, chunk ids are deterministic per source item, so a retry of a
    partially applied insert rewrites the same primary keys rather than
    growing the collection unboundedly.
    """

    def __init__(self, target: Any, operation: str = "external_call", **retry_kwargs):
        object.__setattr__(self, "_target", target)
        object.__setattr__(self, "_operation", operation)
        object.__setattr__(self, "_retry_kwargs", retry_kwargs)

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._target, name)
        if name.startswith("_") or not callable(attr):
            return attr
        return retry(f"{self._operation}.{name}", **self._retry_kwargs)(attr)

    def __repr__(self) -> str:
        return f"RetryingProxy({self._target!r})"
