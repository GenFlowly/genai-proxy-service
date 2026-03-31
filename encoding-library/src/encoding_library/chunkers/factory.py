from typing import Any, Union
from .base_chunker import BaseChunker
from .recursive_chunker import RecursiveChunker
from .enums import ChunkingType, RecursiveTechnique

class ChunkerFactory:
    """
    Factory to create configured Chunkers.
    """
    
    @staticmethod
    def get_chunker(chunking_type: Union[str, ChunkingType] = ChunkingType.RECURSIVE, 
                    technique: Union[str, RecursiveTechnique] = None, 
                    **kwargs) -> BaseChunker:
        """
        Get a chunker instance based on type and technique.
        kwargs are passed to the specific strategy or chunker constructor.
        """
        # Pop encoder early to avoid passing it into splitters that don't expect it
        encoder = kwargs.pop('encoder', None)

        # Normalize input to Enum
        if isinstance(chunking_type, str):
            try:
                chunking_type = ChunkingType(chunking_type)
            except ValueError:
                raise ValueError(f"Unknown chunking type: {chunking_type}")

        from .recursive_chunker import RecursiveChunker
        if chunking_type == ChunkingType.RECURSIVE:
            # recursive types: character (default), token
            if isinstance(technique, str):
                try:
                    technique = RecursiveTechnique(technique)
                except ValueError:
                    # Fallback or allow arbitrary string if convenient? No, strict is better for now.
                    pass
            
            return RecursiveChunker(technique=technique, **kwargs)

        elif chunking_type == ChunkingType.SEMANTIC:
            # semantic types: percentile (default), std_dev, interquartile, gradient
            # Langchain naturally expects a string for the semantic breakpoint threshold
            if not isinstance(technique, str):
                technique = "percentile"

            # Encoder must be passed
            if not encoder:
                raise ValueError("Encoder instance required for semantic chunking")

            from .semantic_chunker import SemanticChunker
            return SemanticChunker(technique=technique, encoder=encoder, **kwargs)

        else:
            raise ValueError(f"Unknown chunking type: {chunking_type}")
