"""Structured JSON logging shared by the encoding lambdas and retrieval-server.

One JSON object per line: queryable in CloudWatch Logs Insights and
Grafana/Loki without regex scraping. A contextvar-based request id ties all
lines of one request together (safe across asyncio tasks and Lambda invokes).
"""
from __future__ import annotations

import contextvars
import json
import logging
import time
import uuid

request_id_var = contextvars.ContextVar("request_id", default=None)

# logging.LogRecord attributes — anything else on the record came from
# `extra=` and is included in the JSON output as a structured field.
_RECORD_FIELDS = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "taskName", "message", "asctime",
}


def set_request_id(value: str | None = None) -> str:
    """Set (or generate) the request id for the current context."""
    rid = value or uuid.uuid4().hex[:16]
    request_id_var.set(rid)
    return rid


def request_id_from_lambda_event(event) -> str | None:
    """X-Request-Id from an API Gateway lambda event (case-insensitive)."""
    try:
        headers = event.get("headers") or {}
        for key, value in headers.items():
            if key.lower() == "x-request-id":
                return value
    except Exception:
        pass
    return None


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self._service = service

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "timestamp": time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)
            ) + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "service": self._service,
            "message": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid:
            entry["request_id"] = rid
        for key, value in record.__dict__.items():
            if key not in _RECORD_FIELDS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exc_info"] = self.formatException(record.exc_info)
        try:
            return json.dumps(entry, default=str)
        except (TypeError, ValueError):
            return json.dumps({
                "level": record.levelname,
                "logger": record.name,
                "service": self._service,
                "message": record.getMessage(),
            })


def setup_logging(service: str, level: int = logging.INFO) -> None:
    """Route root logging through the JSON formatter.

    Reuses existing root handlers when present (the Lambda runtime pre-installs
    one that must keep being used), otherwise installs a stream handler.
    """
    root = logging.getLogger()
    root.setLevel(level)
    formatter = JsonFormatter(service)
    if root.handlers:
        for handler in root.handlers:
            handler.setFormatter(formatter)
    else:
        handler = logging.StreamHandler()
        handler.setFormatter(formatter)
        root.addHandler(handler)
