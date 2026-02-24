from abc import ABC, abstractmethod
from typing import List

class TextSplitter(ABC):
    """
    Strategy interface for splitting text into smaller units.
    """
    @abstractmethod
    def split_text(self, text: str) -> List[str]:
        """Split text based on specific logic."""
        pass

class CharacterSplitter(TextSplitter):
    """
    Splits text based on character count and separators.
    """
    def __init__(self, chunk_size: int = 1000, chunk_overlap: int = 200, separators: List[str] = None):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separators = separators or ["\n\n", "\n", " ", ""]

    def split_text(self, text: str) -> List[str]:
        # Simple implementation for now, recursive split logic would go here
        # For MVP we can just use the provided text_preprocessor logic or robust implementation
        # Implementing a simple recursive splitter
        final_chunks = []
        separator = self.separators[-1]
        
        # Determine strict separator
        for sep in self.separators:
            if sep == "":
                separator = ""
                break
            if sep in text:
                separator = sep
                break
                
        # Split
        if separator:
            splits = text.split(separator)
        else:
            splits = list(text) # Split by character if separator is empty string
            
        # Merge splits into chunks
        current_chunk = []
        current_length = 0
        
        for split in splits:
            if current_length + len(split) + len(separator) > self.chunk_size:
                if current_chunk:
                    doc = separator.join(current_chunk)
                    final_chunks.append(doc)
                    
                    # Handle overlap (simplified)
                    # Ideally we keep last N chars/items that fit in overlap
                    # For now, just start new chunk
                    current_chunk = []
                    current_length = 0
                    
            current_chunk.append(split)
            current_length += len(split) + len(separator)
            
        if current_chunk:
            final_chunks.append(separator.join(current_chunk))
            
        return final_chunks

# Placeholder for TokenSplitter requiring tiktoken
class TokenSplitter(TextSplitter):
    """
    Splits text based on token count.
    """
    def __init__(self, model_name: str = "gpt-3.5-turbo", chunk_size: int = 500, chunk_overlap: int = 50):
        self.model_name = model_name
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def split_text(self, text: str) -> List[str]:
        # Would implement tiktoken logic here
        # raise NotImplementedError("TokenSplitter requires tiktoken dependency")
        # Fallback to character split for now if tiktoken missing
        return [text]
