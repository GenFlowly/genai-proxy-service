import re
from typing import List

def split_into_sentences(text: str) -> List[str]:
    """
    Split text into sentences to handle long documents better.
    Simple regex split on punctuation followed by whitespace.
    """
    sentences = re.split(r'(?<=[.!?])\s+', text)
    sentences = [s.strip() for s in sentences if s.strip()]
    
    if not sentences:
        # Fallback for text without punctuation or empty
        sentences = [text]
        
    return sentences
