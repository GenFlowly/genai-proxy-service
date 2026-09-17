import logging
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

os.environ["MPLCONFIGDIR"] = "/tmp/matplotlib"
os.environ["NUMBA_CACHE_DIR"] = "/tmp/numba_cache"
os.environ["JOBLIB_TEMP_FOLDER"] = "/tmp/joblib_tmp"

from fastapi import FastAPI, Request
from prometheus_fastapi_instrumentator import Instrumentator

from encoding_library.observability import configure_observability, set_request_id, setup_logging

from routes.model_metadata import router as model_metadata_router
from routes.models import router as models_router
from routes.notes import router as notes_router
from routes.retrieve import router as retrieve_router
from routes.search import router as search_router
from routes.validate_key import router as validate_key_router
from routes.voice import router as voice_router

configure_observability(service="retrieval-server", backend="prometheus")
setup_logging("retrieval-server")
logger = logging.getLogger(__name__)


# Embedding is API-backed (Voyage/OpenAI); encoders are lightweight clients
# instantiated lazily per model in graph.nodes.retrieval — nothing to preload.
app = FastAPI()

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

