from abc import ABC, abstractmethod
from typing import Dict, Any, Tuple, List, Callable
from models.payload import Payload

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
    def to_sqs_message(self, payload: Payload) -> Tuple[str, Dict[str, Any]]:
        """
        Convert payload to SQS message format.
        Returns a tuple of (MessageBody, MessageAttributes).
        """
        pass

    @abstractmethod
    def prepare_for_vector_db(self, data: Dict[str, Any], embedding: list) -> Dict[str, Any]:
        """
        Prepare data for insertion into Vector DB.
        Returns a dictionary representing the record to be inserted.
        """
        pass

    @abstractmethod
    def create_embeddings(self, data: Dict[str, Any], encode_text: Callable[[str], List[float]]) -> List[float]:
        """
        Create embeddings for the data.
        Returns a list of floats representing the embedding.
        """
        pass
