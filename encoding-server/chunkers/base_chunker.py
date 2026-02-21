from abc import ABC, abstractmethod
from typing import List

class BaseChunker(ABC):
    """
    Abstract base class for all chunkers.
    """
    
    @abstractmethod
    def chunk(self, text: str) -> List[str]:
        """
        Split text into a list of string chunks.
        """
        pass
