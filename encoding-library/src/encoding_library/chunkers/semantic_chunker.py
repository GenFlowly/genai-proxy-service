import numpy as np
from typing import List, Any
from .base_chunker import BaseChunker
from .semantic.thresholds import ThresholdStrategy, PercentileThreshold
from encoding_library.encoders.encoder import Encoder 

from encoding_library.utils.text_preprocessor import split_into_sentences

class SemanticChunker(BaseChunker):
    """
    Chunker that splits text based on semantic similarity changes.
    """
    
    def __init__(self, encoder: Encoder, threshold_strategy: ThresholdStrategy = None):
        self.encoder = encoder
        self.threshold_strategy = threshold_strategy or PercentileThreshold()
        
    def _calculate_cosine_distances(self, embeddings: List[Any]) -> List[float]:
        """
        Calculate cosine distance (1 - similarity) between adjacent embeddings.
        """
        distances = []
        for i in range(len(embeddings) - 1):
            # Use numpy for vector math
            e1 = np.array(embeddings[i])
            e2 = np.array(embeddings[i+1])
            
            # OpenAI/SentenceTransformer embeddings are usually normalized
            # If not, we should normalize them. Assuming normalized for now.
            similarity = np.dot(e1, e2)
            distance = 1 - similarity
            distances.append(distance)
            
        return distances
        
    def chunk(self, text: str) -> List[str]:
        """
        Chunk text semantically.
        """
        # 1. Split into atomic units (sentences)
        sentences = split_into_sentences(text)
        if not sentences:
            return []
        if len(sentences) == 1:
            return sentences
            
        # 2. Encode sentences using the injected encoder
        # We can rely on Encoder's encode_documents method since that's its sole responsibility.
        embeddings = self.encoder.encode_documents(sentences)

        # 3. Calculate distances
        distances = self._calculate_cosine_distances(embeddings)
        
        # 4. Determine breakpoints using strategy
        breakpoints = self.threshold_strategy.calculate_breakpoints(distances)
        
        # 5. Group sentences
        final_chunks = []
        current_chunk = []
        
        start_idx = 0
        
        # Breakpoints are indices in the sentences list (actually distances list is len-1)
        # distances[i] corresponds to gap between sentence[i] and sentence[i+1]
        
        for i, sentence in enumerate(sentences):
            current_chunk.append(sentence)
            # If i is in breakpoints, we close the chunk AFTER this sentence
            if i in breakpoints:
                final_chunks.append(" ".join(current_chunk))
                current_chunk = []
                
        if current_chunk:
            final_chunks.append(" ".join(current_chunk))
            
        return final_chunks
