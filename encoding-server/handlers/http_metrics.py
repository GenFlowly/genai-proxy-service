"""HTTP-status metric for API-facing lambda handlers.

`@track` only reports status=error when a handler *throws* — a handler that
catches its errors and returns a 400 still counts as ok, which is how a 100%
validation-failure outage looked healthy on the dashboard. This decorator
reads the statusCode of the returned API Gateway response and emits
`http_response_total{operation, status="<code>"}` so the real HTTP outcome
is graphable. Stack it under @track (exceptions stay @track's job).
"""
import logging
from functools import wraps

from encoding_library.observability import count

logger = logging.getLogger(__name__)


def track_http_status(operation: str):
    def decorator(fn):
        @wraps(fn)
        def wrapper(event, context):
            response = fn(event, context)
            try:
                code = response.get("statusCode") if isinstance(response, dict) else None
                count("http_response_total", operation=operation, status=str(code or "none"))
            except Exception:
                logger.debug("http_response_total emission failed", exc_info=True)
            return response
        return wrapper
    return decorator
