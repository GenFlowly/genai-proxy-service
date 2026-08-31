from typing import Dict, Any, Optional, List


class MemoryRequestInternalState:
    """
    Standardized internal state structure for passing parsed API requests
    between Lambdas (ingestion -> chunking -> embed -> storage via SQS / Step Functions).
    """
    def __init__(
        self,
        data_type: str,
        customer_id: str,
        client: str,
        raw_data: Dict[str, Any],
        model_type: Optional[str] = None,
        model_name: Optional[str] = None,
        chunking_type: Optional[str] = None,
        chunking_technique: Optional[str] = None,
        chunk_size: Optional[int] = None,
        chunk_overlap: Optional[int] = None,
        data_chunks: Optional[List[str]] = None,
        vectors: Optional[List[Any]] = None,
    ):
        self.data_type = data_type
        self.customer_id = customer_id
        self.client = client
        self.raw_data = raw_data
        self.model_type = model_type
        self.model_name = model_name
        self.chunking_type = chunking_type
        self.chunking_technique = chunking_technique
        # Per-request chunking overrides (tokens); when unset, the per-model
        # values from the EmbeddingModelRegistry table (or code defaults) apply
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.data_chunks = data_chunks
        self.vectors = vectors

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "data_type": self.data_type,
            "customer_id": self.customer_id,
            "client": self.client,
            "raw_data": self.raw_data,
            "model_type": self.model_type,
            "model_name": self.model_name,
            "chunking_type": self.chunking_type,
            "chunking_technique": self.chunking_technique,
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "data_chunks": self.data_chunks,
            "vectors": self.vectors,
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'MemoryRequestInternalState':
        """Create MemoryRequestInternalState from dictionary."""
        return MemoryRequestInternalState(
            data_type=data.get('data_type', ''),
            customer_id=data.get('customer_id', ''),
            client=data.get('client', ''),
            raw_data=data.get('raw_data', {}),
            model_type=data.get('model_type'),
            model_name=data.get('model_name'),
            chunking_type=data.get('chunking_type'),
            chunking_technique=data.get('chunking_technique'),
            chunk_size=data.get('chunk_size'),
            chunk_overlap=data.get('chunk_overlap'),
            data_chunks=data.get('data_chunks'),
            vectors=data.get('vectors'),
        )
