from typing import Any, Union
from .base_chunker import BaseChunker
from .recursive_chunker import RecursiveChunker
from .recursive.splitters import CharacterSplitter, TokenSplitter
from .enums import ChunkingType, RecursiveTechnique, SemanticTechnique

class ChunkerFactory:
    """
    Factory to create configured Chunkers.
    """
    
    @staticmethod
    def get_chunker(chunking_type: Union[str, ChunkingType] = ChunkingType.RECURSIVE, 
                    technique: Union[str, RecursiveTechnique, SemanticTechnique] = None, 
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

        if chunking_type == ChunkingType.RECURSIVE:
            # recursive types: character (default), token
            if isinstance(technique, str):
                try:
                    technique = RecursiveTechnique(technique)
                except ValueError:
                    # Fallback or allow arbitrary string if convenient? No, strict is better for now.
                    # Or just treat unknown as None/Default?
                    # Let's try to convert, if fail, assume default or error.
                    pass
            
            if technique == RecursiveTechnique.TOKEN:
                splitter = TokenSplitter(**kwargs)
            else:
                # Default to character splitter
                splitter = CharacterSplitter(**kwargs)
                
            return RecursiveChunker(splitter=splitter)

        elif chunking_type == ChunkingType.SEMANTIC:
            # semantic types: percentile (default), std_dev
            if isinstance(technique, str):
                try:
                    technique = SemanticTechnique(technique)
                except ValueError:
                    pass

            # Encoder must be passed
            if not encoder:
                raise ValueError("Encoder instance required for semantic chunking")

            # Lazy import semantic chunkers to avoid hard dependency on numpy
            from .semantic_chunker import SemanticChunker
            from .semantic.thresholds import PercentileThreshold, StandardDeviationThreshold

            if technique == SemanticTechnique.STD_DEV:
                strategy = StandardDeviationThreshold(**kwargs)
            else:
                strategy = PercentileThreshold(**kwargs)
                
            return SemanticChunker(encoder=encoder, threshold_strategy=strategy)

        else:
            raise ValueError(f"Unknown chunking type: {chunking_type}")
