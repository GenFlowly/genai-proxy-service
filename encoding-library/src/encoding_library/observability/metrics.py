"""Backend-agnostic metric emission.

One API (`count` / `observe`), two backends chosen once per process:

- ``emf``        — AWS Lambda: prints CloudWatch Embedded Metric Format JSON
                   lines to stdout; CloudWatch converts them to metrics with
                   no API calls and no extra IAM.
- ``prometheus`` — long-running services (retrieval-server): registers
                   counters/histograms in the default prometheus_client
                   registry, scraped via the app's /metrics endpoint.
- ``noop``       — neither available; metric calls do nothing.

Emission must never break the caller: every backend error is swallowed and
logged at DEBUG.

Dimension policy (see development.md "Observability" section): only the keys
in ALLOWED_DIMENSIONS are emitted. ``customer_id`` is deliberately excluded —
per-customer label values explode Prometheus cardinality and CloudWatch
metric count; customer context belongs in logs.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

ALLOWED_DIMENSIONS = {
    "operation", "status", "vendor", "model", "data_type",
    "tool", "direction", "source",
}

_DEFAULT_NAMESPACE = "GenFlowly"

_lock = threading.Lock()
_emitter = None
_service = "unknown"


def configure_observability(service: str, backend: str | None = None,
                            namespace: str = _DEFAULT_NAMESPACE) -> None:
    """Choose the metric backend for this process.

    Optional — the first metric call auto-detects (Lambda env → emf,
    prometheus_client importable → prometheus, else noop) — but explicit
    configuration also sets the service name used as a dimension.
    """
    global _emitter, _service
    with _lock:
        _service = service
        _emitter = _build_emitter(backend, namespace)


def count(name: str, value: int | float = 1, **dims) -> None:
    """Increment a monotonic counter. Name convention: ``*_total``."""
    _get_emitter().emit(name, value, _clean(dims), kind="count")


def observe(name: str, value: float, **dims) -> None:
    """Record a distribution sample (durations, sizes).

    Name convention: ``*_duration_seconds`` for timings.
    """
    _get_emitter().emit(name, value, _clean(dims), kind="observe")


def _clean(dims: dict) -> dict:
    cleaned = {}
    for k, v in dims.items():
        if k not in ALLOWED_DIMENSIONS:
            logger.debug("Dropping disallowed metric dimension %r", k)
            continue
        cleaned[k] = str(v) if v is not None else ""
    cleaned["service"] = _service
    return cleaned


def _get_emitter():
    global _emitter
    if _emitter is None:
        with _lock:
            if _emitter is None:
                _emitter = _build_emitter(None, _DEFAULT_NAMESPACE)
    return _emitter


def _build_emitter(backend: str | None, namespace: str):
    backend = backend or os.environ.get("OBS_METRICS_BACKEND")
    if backend is None:
        if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
            backend = "emf"
        else:
            try:
                import prometheus_client  # noqa: F401
                backend = "prometheus"
            except ImportError:
                backend = "noop"
    if backend == "emf":
        return _EmfEmitter(namespace)
    if backend == "prometheus":
        try:
            return _PrometheusEmitter()
        except ImportError:
            logger.warning("prometheus backend requested but prometheus_client "
                           "is not installed — metrics disabled")
            return _NoopEmitter()
    return _NoopEmitter()


class _NoopEmitter:
    def emit(self, name, value, dims, kind):
        pass


class _EmfEmitter:
    """One CloudWatch EMF JSON line per emit, written to stdout."""

    def __init__(self, namespace: str):
        self._namespace = namespace

    def emit(self, name, value, dims, kind):
        try:
            unit = "Seconds" if name.endswith("_seconds") else "Count"
            blob = {
                "_aws": {
                    "Timestamp": int(time.time() * 1000),
                    "CloudWatchMetrics": [{
                        "Namespace": self._namespace,
                        "Dimensions": [sorted(dims.keys())],
                        "Metrics": [{"Name": name, "Unit": unit}],
                    }],
                },
                name: value,
                **dims,
            }
            print(json.dumps(blob), flush=True)
        except Exception as e:
            logger.debug("EMF metric emission failed for %s: %s", name, e)


class _PrometheusEmitter:
    """Lazily registered prometheus_client Counters/Histograms.

    A metric's label set is fixed by its first emission; later calls are
    coerced to it (missing labels become "", extras are dropped) because
    prometheus_client rejects inconsistent label sets.
    """

    def __init__(self):
        import prometheus_client
        self._prometheus_client = prometheus_client
        self._instruments = {}
        self._lock = threading.Lock()

    def emit(self, name, value, dims, kind):
        try:
            instrument, labelnames = self._get(name, dims, kind)
            if labelnames:
                labels = {ln: dims.get(ln, "") for ln in labelnames}
                instrument = instrument.labels(**labels)
            if kind == "count":
                instrument.inc(value)
            else:
                instrument.observe(value)
        except Exception as e:
            logger.debug("Prometheus metric emission failed for %s: %s", name, e)

    def _get(self, name, dims, kind):
        with self._lock:
            entry = self._instruments.get(name)
            if entry is None:
                labelnames = sorted(dims.keys())
                cls = (self._prometheus_client.Counter if kind == "count"
                       else self._prometheus_client.Histogram)
                entry = (cls(name.removesuffix("_total") if kind == "count" else name,
                             f"{name} (auto-registered by encoding_library.observability)",
                             labelnames), labelnames)
                self._instruments[name] = entry
            return entry
