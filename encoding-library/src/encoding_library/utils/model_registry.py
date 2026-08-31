"""
Registry of embedding models known to the platform.

Maps (model_type, model_name) -> vector dimension, and provides helpers to
serialize/parse the model metadata stored on each Milvus collection (in the
collection description). Consumers (e.g. retrieval) should resolve a
collection's embedding model from this metadata rather than from naming
conventions or request parameters.
"""
import json
import logging
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

DEFAULT_MODEL_TYPE = "sentence-transformer"
DEFAULT_MODEL_NAME = "all-MiniLM-L6-v2"

# Version of the metadata document stored in the collection description.
METADATA_VERSION = 1

EMBEDDING_MODEL_DIMENSIONS: Dict[Tuple[str, str], int] = {
    ("sentence-transformer", "all-MiniLM-L6-v2"): 384,
    ("sentence-transformer", "all-mpnet-base-v2"): 768,
    ("sentence-transformer", "BAAI/bge-small-en-v1.5"): 384,
    ("sentence-transformer", "BAAI/bge-base-en-v1.5"): 768,
    ("sentence-transformer", "BAAI/bge-large-en-v1.5"): 1024,
    ("openai", "text-embedding-3-small"): 1536,
    ("openai", "text-embedding-3-large"): 3072,
    ("openai", "text-embedding-ada-002"): 1536,
    ("voyage", "voyage-4-large"): 1024,
    ("voyage", "voyage-4"): 1024,
    # Contextualized chunk embedding model: one vector per chunk, computed
    # with visibility over the whole document (all chunks sent in one call).
    # voyage-context-4 is the platform's contextualized model of choice.
    ("voyage", "voyage-context-4"): 1024,
}

# Fallback chunking parameters (tokens) when a model has no row in the
# EmbeddingModelRegistry DynamoDB table and the request carries no override.
DEFAULT_CHUNK_SIZE = 1000
DEFAULT_CHUNK_OVERLAP = 200

# Per-model chunking config table: PK=modelType, SK=modelName,
# attrs chunkSize (N), chunkOverlap (N). Managed out-of-band (seed script /
# admin tooling) so chunking can be tuned without a code deploy.
MODEL_REGISTRY_TABLE_ENV = "EMBEDDING_MODEL_REGISTRY_TABLE"
DEFAULT_MODEL_REGISTRY_TABLE = "EmbeddingModelRegistry"

_chunking_params_cache: Dict[Tuple[str, str], Tuple[int, int]] = {}


def get_chunking_params(
    model_type: Optional[str] = None,
    model_name: Optional[str] = None,
    chunk_size: Optional[int] = None,
    chunk_overlap: Optional[int] = None,
) -> Tuple[int, int]:
    """
    Resolve (chunk_size, chunk_overlap) in tokens for an embedding model.

    Order: explicit request overrides -> per-model row in the
    EmbeddingModelRegistry DynamoDB table (cached per process) -> code
    defaults. Registry lookup failures degrade to defaults, never raise —
    chunking must not depend on the config table's availability.
    """
    if chunk_size is not None and chunk_overlap is not None:
        return int(chunk_size), int(chunk_overlap)

    key = resolve_model(model_type, model_name)
    if key not in _chunking_params_cache:
        size, overlap = DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP
        try:
            import os
            import boto3
            table_name = os.environ.get(MODEL_REGISTRY_TABLE_ENV, DEFAULT_MODEL_REGISTRY_TABLE)
            client = boto3.client("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
            item = client.get_item(
                TableName=table_name,
                Key={"modelType": {"S": key[0]}, "modelName": {"S": key[1]}},
            ).get("Item")
            if item:
                size = int(item.get("chunkSize", {}).get("N", size))
                overlap = int(item.get("chunkOverlap", {}).get("N", overlap))
        except Exception as e:
            logger.warning(f"Model registry lookup failed for {key}; using default chunking params: {e}")
        _chunking_params_cache[key] = (size, overlap)

    registry_size, registry_overlap = _chunking_params_cache[key]
    # Partial overrides: whichever value the request supplies wins per-field
    return (
        int(chunk_size) if chunk_size is not None else registry_size,
        int(chunk_overlap) if chunk_overlap is not None else registry_overlap,
    )


def is_contextualized_model(model_name: Optional[str]) -> bool:
    """
    True for Voyage contextualized chunk embedding models (voyage-context-*).
    These use the /contextualizedembeddings endpoint with document-grouped
    inputs instead of the flat /embeddings endpoint.
    """
    return bool(model_name) and model_name.startswith("voyage-context")


def resolve_model(model_type: Optional[str] = None, model_name: Optional[str] = None) -> Tuple[str, str]:
    """Normalize possibly-missing model identifiers to the platform defaults."""
    return (model_type or DEFAULT_MODEL_TYPE, model_name or DEFAULT_MODEL_NAME)


def get_embedding_dimension(
    model_type: Optional[str] = None,
    model_name: Optional[str] = None,
    explicit_dimension: Optional[int] = None,
) -> int:
    """
    Resolve the vector dimension for an embedding model.

    Order: explicit override -> registry lookup -> probe (embed one string and
    measure). Probing works for API-backed models anywhere; HuggingFace models
    can only be probed where sentence-transformers is installed (the [ml] images).
    """
    if explicit_dimension:
        return int(explicit_dimension)

    key = resolve_model(model_type, model_name)
    if key in EMBEDDING_MODEL_DIMENSIONS:
        return EMBEDDING_MODEL_DIMENSIONS[key]

    try:
        from encoding_library.utils.embedding_utils import get_embedding_model
        encoder = get_embedding_model(key[0], key[1])
        dim = len(encoder.embed_query("dimension probe"))
        logger.info(f"Probed dimension for {key}: {dim}")
        return dim
    except Exception as e:
        raise ValueError(
            f"Cannot determine embedding dimension for {key}: not in "
            f"EMBEDDING_MODEL_DIMENSIONS and probing failed ({e}). Add the model "
            f"to the registry or pass an explicit 'dimension' in the request."
        )


def build_collection_description(
    model_type: Optional[str], model_name: Optional[str], dim: int
) -> str:
    """JSON metadata stored as the Milvus collection description at creation time."""
    mt, mn = resolve_model(model_type, model_name)
    return json.dumps({
        "v": METADATA_VERSION,
        "model_type": mt,
        "model_name": mn,
        "dim": dim,
    })


def parse_collection_description(description: Optional[str]) -> Optional[Dict[str, Any]]:
    """
    Parse collection-description metadata written by build_collection_description.
    Returns None for legacy collections whose description is empty or not ours.
    """
    if not description:
        return None
    try:
        meta = json.loads(description)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(meta, dict) or "model_name" not in meta:
        return None
    return meta
