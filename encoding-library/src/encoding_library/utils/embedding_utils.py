import math
from typing import Dict, Any, List

from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.encoders.factory import EncoderFactory
from encoding_library.encoders.enums import ModelType, ModelName

def create_embeddings(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Creates embeddings for the provided data dictionary using the appropriate processor and encoder.
    Returns a list of chunks (dicts with vector, text, index).
    """
    # Get appropriate processor
    processor = ProcessorFactory.get_processor(data)
    
    # Extract raw text to encode
    text_to_encode = processor.get_text_to_encode(data)

    # Get appropriate encoder (default to sentence-transformer/all-MiniLM-L6-v2)
    model_type_str = data.get('model_type', ModelType.SENTENCE_TRANSFORMER.value)
    model_name_str = data.get('model_name', ModelName.ALL_MINILM_L6_V2.value) 
    
    encoder = EncoderFactory.get_encoder(model_type_str, model_name_str)
    
    # Get chunking config
    from encoding_library.chunkers.factory import ChunkerFactory
    from encoding_library.chunkers.enums import ChunkingType, RecursiveTechnique
    
    chunking_type_str = data.get('chunking_type', ChunkingType.RECURSIVE.value)
    chunking_technique_str = data.get('chunking_technique', RecursiveTechnique.CHARACTER.value)
    
    chunker = ChunkerFactory.get_chunker(
        chunking_type=chunking_type_str,
        technique=chunking_technique_str,
        encoder=encoder
    )
    
    # Chunk text
    chunks = chunker.chunk(text_to_encode)
    
    if not chunks:
        return []
        
    # Encode chunks
    embeddings = encoder.encode_documents(chunks)
         
    # Format result
    result = []
    for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        vector = embedding
        if hasattr(vector, 'tolist'):
            vector = vector.tolist()
        else:
            vector = list(vector)
            
        result.append({
            'text': chunk_text,
            'vector': vector,
            'index': i
        })
        
    return result

def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """
    Computes the cosine similarity between two vectors.
    """
    dot_product = sum(a * b for a, b in zip(vec1, vec2))
    norm_a = math.sqrt(sum(a * a for a in vec1))
    norm_b = math.sqrt(sum(b * b for b in vec2))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot_product / (norm_a * norm_b)
