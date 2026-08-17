import math
from typing import Any, Dict, List, Optional

def get_embedding_model(model_type_str: Optional[str] = None, model_name_str: Optional[str] = None) -> Any:
    """
    Instantiates and returns the appropriate Langchain embedding model.
    Defaults to sentence-transformer / all-MiniLM-L6-v2 if not specified.
    """
    from encoding_library.utils.model_registry import resolve_model
    model_type, model_name = resolve_model(model_type_str, model_name_str)

    if model_type == "sentence-transformer":
        from langchain_huggingface import HuggingFaceEmbeddings
        return HuggingFaceEmbeddings(model_name=model_name)
    elif model_type == "openai":
        # Requires OPENAI_API_KEY in the environment
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(model=model_name)
    elif model_type == "voyage":
        # Requires VOYAGE_API_KEY in the environment
        from langchain_voyageai import VoyageAIEmbeddings
        return VoyageAIEmbeddings(model=model_name)
    else:
        raise ValueError(f"Unknown language model type specified: {model_type}")

def create_chunks(text_to_encode: str, encoder: Any, chunking_type: Optional[str] = None, chunking_technique: Optional[str] = None) -> List[str]:
    """
    Creates chunks for the given text using the specified chunking strategy.
    """
    from encoding_library.chunkers.factory import ChunkerFactory
    from encoding_library.chunkers.enums import ChunkingType, RecursiveTechnique

    chunker = ChunkerFactory.get_chunker(
        chunking_type=chunking_type or ChunkingType.RECURSIVE.value,
        technique=chunking_technique or RecursiveTechnique.TOKEN.value,
        encoder=encoder
    )

    return chunker.chunk(text_to_encode)

def create_embeddings(chunks: List[str], encoder: Any) -> List[Dict[str, Any]]:
    """
    Creates embeddings for the provided chunks using the specified encoder.
    Returns a list of chunks (dicts with vector, text, index).
    """
    if not chunks:
        return []
        
    # Encode chunks using native Langchain API implementation format
    embeddings = encoder.embed_documents(chunks)
         
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
