import logging
import os
import sys
from contextlib import asynccontextmanager

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Model cache persisted via Docker volume at /app/model_cache
os.environ["HF_HOME"] = "/app/model_cache"
os.environ["HF_HUB_DISABLE_XET"] = "1"   # force regular HTTPS download, XetHub hangs in Docker
os.environ["MPLCONFIGDIR"] = "/tmp/matplotlib"
os.environ["NUMBA_CACHE_DIR"] = "/tmp/numba_cache"
os.environ["JOBLIB_TEMP_FOLDER"] = "/tmp/joblib_tmp"

from fastapi import FastAPI

from routes.conversations import router as conversations_router
from routes.model_metadata import router as model_metadata_router
from routes.models import router as models_router
from routes.notes import router as notes_router
from routes.retrieve import router as retrieve_router
from routes.validate_key import router as validate_key_router
from routes.voice import router as voice_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from graph.nodes.retrieval import _get_cached_embedding_model

    logger.info("Pre-loading default embedding model at startup")
    _get_cached_embedding_model(None, None)
    logger.info("Embedding model ready — dynamic graph engine loaded (RETRIEVAL + make_llm_node)")

    yield


app = FastAPI(lifespan=lifespan)
app.include_router(retrieve_router)
app.include_router(models_router)
app.include_router(model_metadata_router)
app.include_router(notes_router)
app.include_router(conversations_router)
app.include_router(voice_router)
app.include_router(validate_key_router)


@app.get("/health")
async def health():
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 5001))
    uvicorn.run(app, host="::", port=port)

