import math
from typing import Dict, Any, List

from processors.processor_factory import ProcessorFactory
from encoders.factory import EncoderFactory
from encoders.enums import ModelType, ModelName

def create_embeddings(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Creates embeddings for the provided data dictionary using the appropriate processor and encoder.
    Returns a list of chunks (dicts with vector, text, index).
    """
    # Get appropriate processor
    processor = ProcessorFactory.get_processor(data)

    # Get appropriate encoder (default to sentence-transformer/all-MiniLM-L6-v2)
    model_type_str = data.get('model_type', ModelType.SENTENCE_TRANSFORMER.value)
    model_name_str = data.get('model_name', ModelName.ALL_MINILM_L6_V2.value) 
    
    encoder = EncoderFactory.get_encoder(model_type_str, model_name_str)
    
    # Create embedding (processor handles type-specific logic)
    embeddings = processor.create_embeddings(data, encoder)
    return embeddings

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
