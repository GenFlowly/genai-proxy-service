from typing import List
from .base_chunker import BaseChunker
from .recursive.splitters import TextSplitter, CharacterSplitter

class RecursiveChunker(BaseChunker):
    """
    Chunker that splits text recursively using a specific splitter strategy.
    """
    
    def __init__(self, splitter: TextSplitter = None):
        # Default to character splitter if none provided
        self.splitter = splitter or CharacterSplitter()
        
    def chunk(self, text: str) -> List[str]:
        """
        Chunk the text using the configured splitter strategy.
        """
        return self.splitter.split_text(text)
