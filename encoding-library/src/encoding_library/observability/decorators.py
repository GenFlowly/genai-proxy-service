"""@track — status/duration instrumentation for any callable shape.

Emits, per call:
    {operation}_total{status=ok|error, ...dims}
    {operation}_duration_seconds{status=..., ...dims}

Supports plain functions, coroutine functions, generator functions and async
generator functions. Generators are timed to exhaustion (not to first yield),
so a streaming response that dies mid-stream still records status=error.

The wrapped function's behavior is never altered: exceptions re-raise
unchanged and metric emission failures are swallowed inside the emitter.
"""
import functools
import inspect
import time

from .metrics import count, observe


def track(operation: str, **static_dims):
    def decorator(fn):
        if inspect.isasyncgenfunction(fn):
            @functools.wraps(fn)
            async def async_gen_wrapper(*args, **kwargs):
                start = time.perf_counter()
                status = "ok"
                try:
                    async for item in fn(*args, **kwargs):
                        yield item
                except BaseException:
                    status = "error"
                    raise
                finally:
                    _emit(operation, status, start, static_dims)
            return async_gen_wrapper

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args, **kwargs):
                start = time.perf_counter()
                status = "ok"
                try:
                    return await fn(*args, **kwargs)
                except BaseException:
                    status = "error"
                    raise
                finally:
                    _emit(operation, status, start, static_dims)
            return async_wrapper

        if inspect.isgeneratorfunction(fn):
            @functools.wraps(fn)
            def gen_wrapper(*args, **kwargs):
                start = time.perf_counter()
                status = "ok"
                try:
                    yield from fn(*args, **kwargs)
                except BaseException:
                    status = "error"
                    raise
                finally:
                    _emit(operation, status, start, static_dims)
            return gen_wrapper

        @functools.wraps(fn)
        def sync_wrapper(*args, **kwargs):
            start = time.perf_counter()
            status = "ok"
            try:
                return fn(*args, **kwargs)
            except BaseException:
                status = "error"
                raise
            finally:
                _emit(operation, status, start, static_dims)
        return sync_wrapper

    return decorator


def _emit(operation: str, status: str, start: float, static_dims: dict) -> None:
    elapsed = time.perf_counter() - start
    count(f"{operation}_total", status=status, **static_dims)
    observe(f"{operation}_duration_seconds", elapsed, status=status, **static_dims)
