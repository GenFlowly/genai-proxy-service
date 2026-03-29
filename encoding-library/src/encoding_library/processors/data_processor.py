from abc import ABC, abstractmethod
from typing import Dict, Any, Tuple, List, Callable
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.encoders.encoder import Encoder

class DataProcessor(ABC):
    """
    Abstract base class for data processors.
    """

    @abstractmethod
    def validate(self, data: Dict[str, Any]) -> bool:
        """
        Validate the input data.
        Raises ValueError if invalid.
        Returns True if valid.
        """
        pass

    @abstractmethod
    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert to SQS message format.
        Args:
            state: MemoryRequestInternalState object containing the data to format.
        Returns:
            Tuple of (MessageBody, MessageAttributes)
        """
        pass

    @abstractmethod
    def prepare_for_vector_db(self, data: Dict[str, Any], embeddings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Prepare data for insertion into Vector DB.
        Returns a LIST of dictionaries, where each dict is a record to be inserted.
        This allows for 1-to-many relationship (e.g. 1 Note -> Multiple Chunks).
        """
        pass

    @abstractmethod
    def create_embeddings(self, data: Dict[str, Any], encoder: Encoder) -> List[Dict[str, Any]]:
        """
        Create embeddings for the data.
        Returns a list of dictionaries, each containing 'text' and 'vector'.
        """
        pass

    @abstractmethod
    def get_collection_name(self, customer_id: str, data: Dict[str, Any]) -> str:
        """
        Get the name of the vector database collection for this data type.
        """
        pass
        
    @abstractmethod
    def get_collection_schema(self) -> Any:
        """
        Get the Milvus schema definition for this data type.
        Returns a tuple of (schema, index_params).
        """
        pass

