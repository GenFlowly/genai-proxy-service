import logging
from typing import List, Dict, Any
from .encoder import Encoder

logger = logging.getLogger()

class SentenceTransformerEncoder(Encoder):
    """
    Concrete implementation of Encoder using SentenceTransformer.
    """
    _instances = {}

    def __new__(cls, model_name: str = 'all-MiniLM-L6-v2', device: str = 'cpu'):
        # Singleton pattern per model_name to avoid reloading models (expensive)
        if model_name not in cls._instances:
            cls._instances[model_name] = super(SentenceTransformerEncoder, cls).__new__(cls)
        return cls._instances[model_name]

    def __init__(self, model_name: str = 'all-MiniLM-L6-v2', device: str = 'cpu'):
        # Only initialize once
        if not hasattr(self, 'initialized'):
            self.model_name = model_name
            self.device = device
            try:
                logger.info(f"Loading SentenceTransformer model: {model_name} on {device}")
                # Lazy import to prevent PyTorch loading during Lambda INIT phase
                from pymilvus.model.dense import SentenceTransformerEmbeddingFunction
                self.embedding_fn = SentenceTransformerEmbeddingFunction(
                    model_name=model_name,
                    device=device
                )
                self.initialized = True
                logger.info(f"Model loaded successfully. Dimension: {self.embedding_fn.dim}")
            except Exception as e:
                logger.error(f"Failed to load model {model_name}: {e}")
                raise e

    def get_dimension(self) -> int:
        return self.embedding_fn.dim

    def encode_documents(self, documents: List[str]) -> List[Any]:
        """
        Encode list of documents.
        """
        return self.embedding_fn.encode_documents(documents)


