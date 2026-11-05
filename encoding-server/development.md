# Encoding Server (Lambdas) — Development Guide

## Observability: metrics & logging

Metric naming, allowed dimensions and the canonical metric list are pinned in the repo-wide conventions doc — see the "Observability" section of `genai-proxy-server/development.md`. This page covers how to emit them from the lambdas.

Use the shared util from `encoding_library.observability`. In Lambda the metric backend auto-detects to **EMF** (CloudWatch Embedded Metric Format JSON lines on stdout — no API calls, no extra IAM), so there is no `configure_observability` call to make.

Checklist for every lambda handler in this service:

```python
from encoding_library.observability import count, set_request_id, setup_logging, track
from services.content_logging import default_log_level

setup_logging("encoding-server", level=default_log_level())   # module level: JSON log lines
logger = logging.getLogger()

@track("my_operation")                    # -> my_operation_total{status} + _duration_seconds
def handler(event, context):
    # First thing: bind the correlation id for this invocation's logs.
    # API Gateway handlers:  set_request_id(request_id_from_lambda_event(event))
    # Pipeline lambdas:      set_request_id(state.request_id)
    ...
    count("vector_store_chunks_total", n, data_type=state.data_type)   # value metrics
```

**Request-id propagation**: the id originates from the proxy's `X-Request-Id` header. Ingest lambdas stamp it into `MemoryRequestInternalState.request_id`, which rides the SQS message and Step Functions payloads to every downstream lambda. When adding a new lambda or constructing a new state object, **preserve `request_id`** and call `set_request_id` first thing in the handler — otherwise the correlation chain breaks at your step.

**Swallowed failures must still count.** If you catch-and-continue (e.g. the DDB write-back after a successful Milvus insert), emit a counter in the except block — see `vector_store_ddb_writeback_failure_total` in `store_embeddings_lambda.py`. A failure that only produces a log line is invisible to alarms.

**Logging**: emit structured context via `extra={...}` (rendered as JSON fields) for anything a CloudWatch Logs Insights query might filter on. Never rely on log-message wording for alarms — that's what the counters are for.

**Production logs problems only — and never user content.** Repo-wide policy: `genai-proxy-server/development.md` → "Logging policy". The lambda wiring lives in `services/content_logging.py`, driven by `APP_ENV` (stamped on every lambda by the CDK stacks from the deploy `STAGE`; unset — a local run — means development): `default_log_level()` gives WARNING in production / INFO elsewhere (explicit `LOG_LEVEL` env overrides), `LOG_USER_CONTENT` gates content dumps, `mask_sub()` masks auth subs in WARN/ERROR lines. **Never log the raw `event`** of an API-Gateway handler outside a `LOG_USER_CONTENT` guard — it carries the user's note/email content *and* the `Authorization` header. Caveat for the selectively-copied images (`Dockerfile.create_and_store`, `.parse_and_chunk`, `.store_embeddings`): they `COPY services/content_logging.py` (and the first two `services/content_source.py`) explicitly — a new handler dependency on another `services/` module needs its own COPY line.

**Pipeline payloads carry ids, never text.** SQS messages, Step Functions input and state, and the dead-letter queue (which receives the execution input) hold record keys only; AWS keeps Step Functions execution history for 90 days whatever the log settings, so text must never enter it. `services/content_source.py` enforces this: `to_pointer_state()` cuts `raw_data` down to the per-type allowlist in `_POINTER_FIELDS` (ingest and trigger both apply it), and `load_raw_data()` reloads the text from the source table with a consistent read, checking it belongs to the message's customer. `parse_and_chunk` returns chunk plans, not chunks; `create_and_store` reloads, verifies the plan's `content_sha256` and re-chunks. A new indexed data type needs a `_POINTER_FIELDS` entry, a loader with its ownership check, the table's env var and a `GetItem` grant on both pipeline lambdas (`encoding-server-cdk/lib/lambda-stack.ts`), and a case in `tests/test_content_source.py`. Production state-machine logging is `ERROR` without execution data; dev keeps `ALL` with data. One `cdk deploy` updates every lambda, in parallel unless told otherwise, so a change to a payload's shape needs either consumers that read both shapes or an update order: `lambda-stack.ts` pins create-and-store → parse-and-chunk → ingest-notes with `addDependency` for this reason.

## Third-party calls: retry with exponential backoff

Every outbound call to a third-party API MUST go through `encoding_library.utils.retry`. Each retry emits `retry_attempt_total{operation}`; giving up emits `retry_exhausted_total{operation}`.

- **Milvus/Zilliz**: `get_milvus_client()` already returns a retry-wrapped client — use it, never construct `MilvusClient` directly.
- **Embeddings**: `create_embeddings()` retries internally (covers the realtime and batch paths); the Voyage HTTP call retries transient failures.
- **HTTP calls**: pass `retry_if=is_transient_http_error` so only connection errors, 429 and 5xx retry. Call `raise_for_status()` *inside* the retried function, or 429/5xx responses won't trigger a retry.
- **boto3 (SQS/DynamoDB/S3/Step Functions)** has its own built-in backoff — don't double-wrap.

Note: these are call-level retries. The Step Functions tasks themselves have no `addRetry`/`addCatch` yet (`encoding-server-cdk/lib/stepfunctions-v2-stack.ts`) — a crashed invocation (timeout/OOM) is not re-driven.
