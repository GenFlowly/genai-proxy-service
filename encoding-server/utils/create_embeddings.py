import os
import logging
from typing import List
from pymilvus.model.dense import SentenceTransformerEmbeddingFunction

logger = logging.getLogger()

# Initialize encoder model (loaded once per container)
embedding_fn = None

def get_encoder():
    """Lazy load the embedding function."""
    global embedding_fn
    if embedding_fn is None:
        logger.info("Loading embedding model...")
        logger.info(f"Cache directory: {os.environ.get('TRANSFORMERS_CACHE')}")
        
        # Create cache directories if they don't exist
        os.makedirs('/tmp/transformers_cache', exist_ok=True)
        os.makedirs('/tmp/huggingface', exist_ok=True)
        
        embedding_fn = SentenceTransformerEmbeddingFunction(
            model_name='all-MiniLM-L6-v2',
            device='cpu'
        )
        logger.info(f"Model loaded successfully. Dimension: {embedding_fn.dim}")
    return embedding_fn

def encode_text(text: str) -> List[float]:
    """Encode text to vector embedding."""
    encoder = get_encoder()
    # SentenceTransformerEmbeddingFunction expects a list of documents
    embeddings = encoder.encode_documents([text])
    # The return type is a list of embeddings (which are lists of floats)
    # direct access is simpler with this class
    return embeddings[0]
