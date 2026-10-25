import logging
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

os.environ["MPLCONFIGDIR"] = "/tmp/matplotlib"
os.environ["NUMBA_CACHE_DIR"] = "/tmp/numba_cache"
os.environ["JOBLIB_TEMP_FOLDER"] = "/tmp/joblib_tmp"

# Local dev only: load .env.local into the environment before anything reads it
# (e.g. DATABASE_URL for durable runs). No-op in deployed envs, where the file is
# absent and vars come from Fly secrets. setdefault so real env vars always win.
_env_local = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.local")
if os.path.exists(_env_local):
    with open(_env_local) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k, _v)

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from prometheus_fastapi_instrumentator import Instrumentator

from encoding_library.observability import configure_observability, set_request_id, setup_logging

from routes.connectors import router as connectors_router
from routes.embedding_providers import router as embedding_providers_router
from routes.model_metadata import router as model_metadata_router
from routes.models import router as models_router
from routes.notes import router as notes_router
from routes.probe_models import router as probe_models_router
from routes.providers import router as providers_router
from routes.retrieve import router as retrieve_router
from routes.search import router as search_router
from routes.tools import router as tools_router
from routes.call_control import router as call_control_router
from routes.realtime_secret import router as realtime_secret_router
from routes.validate_key import router as validate_key_router
from routes.voice import router as voice_router

# Durable-runs bootstrap. Importing this constructs the DBOS singleton IF
# DATABASE_URL is set, so the durable /runs router below can register its
# workflow. It is fully inert when DATABASE_URL is absent. The import itself is
# guarded so that even a missing/broken durable_runtime module can never crash
# the server — durable runs simply stay disabled and /retrieve serves as before.
try:
    import durable_runtime
except Exception:
    durable_runtime = None
    logging.getLogger(__name__).exception(
        "durable_runtime import failed — durable runs disabled"
    )

# The durable /runs router. Imported AFTER durable_runtime so the DBOS singleton
# exists when runs.py registers its @DBOS.workflow. Guarded: if it fails to
# import (or durable runs are off), the server still serves /retrieve — the
# /runs endpoints just return 503 (durable_runtime.is_ready() is False).
try:
    from routes.runs import router as runs_router
except Exception:
    runs_router = None
    logging.getLogger(__name__).exception(
        "runs router import failed — durable /runs endpoints disabled"
    )

configure_observability(service="retrieval-server", backend="prometheus")
# Production logs problems only (WARNING+); development logs the full INFO
# narrative. An explicit LOG_LEVEL env var overrides either — safe even as a
# temporary INFO window in production, because user content is independently
# gated by content_logging.py.
_IS_PRODUCTION = (os.getenv("APP_ENV") or "development").strip().lower() == "production"
LOG_LEVEL = getattr(
    logging,
    (os.getenv("LOG_LEVEL") or ("WARNING" if _IS_PRODUCTION else "INFO")).strip().upper(),
    logging.INFO,
)
setup_logging("retrieval-server", level=LOG_LEVEL)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail-safe: startup() never raises — durable runs disable themselves on any
    # error and the server keeps serving /retrieve. (durable_runtime is None only
    # if its import failed, in which case durable runs are already disabled.)
    if durable_runtime is not None:
        await durable_runtime.startup()
    yield
    if durable_runtime is not None:
        await durable_runtime.shutdown()


# Embedding is API-backed (Voyage/OpenAI); encoders are lightweight clients
# instantiated lazily per model in graph.nodes.retrieval — nothing to preload.
app = FastAPI(lifespan=lifespan)

# Per-endpoint request count / latency / status-code metrics + GET /metrics
Instrumentator(excluded_handlers=["/health", "/metrics"]).instrument(app).expose(app)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    # Adopt the proxy's X-Request-Id (or mint one) so all log lines of this
    # request — here and in the Kotlin proxy — share one correlation id.
    rid = set_request_id(request.headers.get("x-request-id"))
    response = await call_next(request)
    response.headers["X-Request-Id"] = rid
    return response

app.include_router(retrieve_router)
if runs_router is not None:
    app.include_router(runs_router)
app.include_router(models_router)
app.include_router(probe_models_router)
app.include_router(providers_router)
app.include_router(embedding_providers_router)
app.include_router(model_metadata_router)
app.include_router(notes_router)
app.include_router(search_router)
app.include_router(tools_router)
app.include_router(connectors_router)
app.include_router(voice_router)
app.include_router(validate_key_router)
app.include_router(realtime_secret_router)
app.include_router(call_control_router)


@app.get("/health")
async def health():
    return {"status": "healthy"}


if __name__ == "__main__":
    import socket

    import uvicorn

    port = int(os.environ.get("PORT", 5001))
    # Dual-stack listener: uvicorn's own `--host ::` binds IPv6-ONLY (asyncio
    # sets IPV6_V6ONLY), which made Fly's metrics scraper — which connects
    # over the machine's private IPv4 — get connection-refused on /metrics,
    # while proxy traffic (IPv6 via .internal) worked. One socket, both
    # families.
    sock = socket.create_server(("", port), family=socket.AF_INET6, dualstack_ipv6=True)
    # Same level for uvicorn's own loggers — silences per-request access lines
    # (incl. /health polling) in production.
    uvicorn.run(app, fd=sock.fileno(), log_level=LOG_LEVEL)

