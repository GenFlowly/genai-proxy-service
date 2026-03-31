from typing import Dict, Any, Optional, List

class MemoryRequestInternalState:
    """
    Standardized internal state structure for passing parsed API requests 
    between Lambdas (from ingestion -> chunking -> encode -> storage via SQS).
    """
    def __init__(self, data_type: str, customer_id: str, client: str, raw_data: Dict[str, Any], data_embeddings: Optional[Any] = None, data_chunks: Optional[List[str]] = None):
        self.data_type = data_type
        self.customer_id = customer_id
        self.client = client
        self.raw_data = raw_data
        self.data_embeddings = data_embeddings
        self.data_chunks = data_chunks

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "data_type": self.data_type,
            "customer_id": self.customer_id,
            "client": self.client,
            "raw_data": self.raw_data,
            "data_embeddings": self.data_embeddings,
            "data_chunks": self.data_chunks
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> 'MemoryRequestInternalState':
        """Create MemoryRequestInternalState from dictionary."""
        return MemoryRequestInternalState(
            data_type=data.get('data_type', ''),
            customer_id=data.get('customer_id', ''),
            client=data.get('client', ''),
            raw_data=data.get('raw_data', {}),
            data_embeddings=data.get('data_embeddings'),
            data_chunks=data.get('data_chunks')
        )
