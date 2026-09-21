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

from routes.model_metadata import router as model_metadata_router
from routes.models import router as models_router
from routes.notes import router as notes_router
from routes.providers import router as providers_router
from routes.retrieve import router as retrieve_router
from routes.search import router as search_router
from routes.validate_key import router as validate_key_router
from routes.voice import router as voice_router

# Durable-runs bootstrap. Importing this constructs the DBOS singleton IF
# DATABASE_URL is set, so the durable /runs router below can register its
# workflow. It is fully inert (and import-safe) when DATABASE_URL is absent.
import durable_runtime

configure_observability(service="retrieval-server", backend="prometheus")
setup_logging("retrieval-server")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail-safe: startup() never raises — durable runs disable themselves on any
    # error and the server keeps serving /retrieve.
    await durable_runtime.startup()
    yield
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
app.include_router(models_router)
app.include_router(providers_router)
app.include_router(model_metadata_router)
app.include_router(notes_router)
app.include_router(search_router)
app.include_router(voice_router)
app.include_router(validate_key_router)


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
    uvicorn.run(app, fd=sock.fileno())

