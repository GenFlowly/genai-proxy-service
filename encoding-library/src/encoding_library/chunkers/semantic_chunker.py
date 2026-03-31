from typing import List, Literal
from langchain_experimental.text_splitter import \
    SemanticChunker as LangchainSemanticChunker, BreakpointThresholdType
from langchain_core.embeddings import Embeddings
from .base_chunker import BaseChunker

class SemanticChunker(BaseChunker):
    """
    Chunker that splits text based on semantic similarity using Langchain experimental APIs.
    """
    
    def __init__(self, technique: Literal["percentile", "standard_deviation", "interquartile", "gradient"] = "percentile", encoder: Embeddings = None, **kwargs):
        if not encoder:
            raise ValueError("Encoder (Embeddings) instance required for semantic chunking")
            
        self.splitter = LangchainSemanticChunker(
            encoder,
            breakpoint_threshold_type=technique,
            **kwargs
        )
        
    def chunk(self, text: str) -> List[str]:
        """
        Chunk text semantically.
        """
        return self.splitter.split_text(text)
