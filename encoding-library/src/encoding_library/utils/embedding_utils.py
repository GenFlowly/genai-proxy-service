import math
from typing import Dict, Any, List

def get_embedding_model(model_type_str: str, model_name_str: str) -> Any:
    """
    Instantiates and returns the appropriate Langchain embedding model.
    """
    if model_type_str == "sentence-transformer":
        from langchain_huggingface import HuggingFaceEmbeddings
        return HuggingFaceEmbeddings(model_name=model_name_str)
    elif model_type_str == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(model=model_name_str)
    else:
        raise ValueError(f"Unknown language model type specified: {model_type_str}")

def create_chunks(data: Dict[str, Any], text_to_encode: str, encoder: Any) -> List[str]:
    """
    Creates chunks for the given text based on configurations found in the data dictionary.
    """
    from encoding_library.chunkers.factory import ChunkerFactory
    from encoding_library.chunkers.enums import ChunkingType, RecursiveTechnique
    
    chunking_type_str = data.get('chunking_type', ChunkingType.RECURSIVE.value)
    chunking_technique_str = data.get('chunking_technique', RecursiveTechnique.TOKEN.value)
    
    chunker = ChunkerFactory.get_chunker(
        chunking_type=chunking_type_str,
        technique=chunking_technique_str,
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
