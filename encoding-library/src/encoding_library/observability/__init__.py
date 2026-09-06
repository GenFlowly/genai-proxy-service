"""Shared observability util: metrics (EMF / Prometheus) + JSON logging.

Usage (see the "Observability" section of genai-proxy-server/development.md
for naming and dimension conventions):

    from encoding_library.observability import (
        configure_observability, setup_logging, track, count, observe,
        set_request_id,
    )

    configure_observability(service="retrieval-server", backend="prometheus")
    setup_logging("retrieval-server")

    @track("vector_store", data_type="note")
    def store(...): ...

    count("vector_store_chunks_total", len(chunks), data_type="note")
    observe("llm_request_duration_seconds", elapsed, vendor="anthropic")
"""
from .decorators import track
from .logging_util import (
    JsonFormatter,
    request_id_from_lambda_event,
    request_id_var,
    set_request_id,
    setup_logging,
)
from .metrics import ALLOWED_DIMENSIONS, configure_observability, count, observe

__all__ = [
    "ALLOWED_DIMENSIONS",
    "JsonFormatter",
    "configure_observability",
    "count",
    "observe",
    "request_id_from_lambda_event",
    "request_id_var",
    "set_request_id",
    "setup_logging",
    "track",
]
