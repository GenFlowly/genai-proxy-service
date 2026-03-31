from abc import ABC, abstractmethod
from typing import Dict, Any, Tuple, List
from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState


class DataProcessor(ABC):
    """
    Abstract base class for data processors.
    All methods operate on a typed MemoryRequestInternalState rather than raw dicts.
    """

    @abstractmethod
    def validate(self, state: MemoryRequestInternalState) -> bool:
        """
        Validate the input state.
        Raises ValueError if invalid.
        Returns True if valid.
        """
        pass

    @abstractmethod
    def to_sqs_message(self, state: MemoryRequestInternalState) -> Tuple[str, Dict[str, Any]]:
        """
        Convert to SQS message format.
        Returns:
            Tuple of (MessageBody, MessageAttributes)
        """
        pass

    @abstractmethod
    def prepare_for_vector_db(self, state: MemoryRequestInternalState, embeddings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Prepare data for insertion into Vector DB.
        Returns a LIST of dicts, one record per chunk.
        """
        pass

    @abstractmethod
    def get_text_to_encode(self, state: MemoryRequestInternalState) -> str:
        """
        Extract the raw text string that should be embedded for this data type.
        """
        pass

    @abstractmethod
    def get_collection_name(self, state: MemoryRequestInternalState) -> str:
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
