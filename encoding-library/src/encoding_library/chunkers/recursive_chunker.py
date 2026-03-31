from typing import List
from langchain_text_splitters import RecursiveCharacterTextSplitter
from .base_chunker import BaseChunker
from .enums import RecursiveTechnique

class RecursiveChunker(BaseChunker):
    """
    Chunker that splits text recursively using LangChain's standard RecursiveCharacterTextSplitter.
    """
    
    def __init__(self, technique: RecursiveTechnique = RecursiveTechnique.TOKEN, chunk_size: int = 1000, chunk_overlap: int = 200, **kwargs):
        try:
            if technique == RecursiveTechnique.TOKEN:
                self.splitter = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                    **kwargs
                )
                return
        except ImportError:
            pass # Fallback to standard character splitter if tiktoken is missing
            
        self.splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            **kwargs
        )
        
    def chunk(self, text: str) -> List[str]:
        """
        Chunk the text using LangChain's text splitting strategy.
        """
        return self.splitter.split_text(text)
