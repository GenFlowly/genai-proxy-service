import math
from typing import Any, Dict, List, Optional


class VoyageContextualizedEmbeddings:
    """
    Encoder for Voyage contextualized chunk embedding models (voyage-context-*),
    exposing the same embed_documents/embed_query interface as the Langchain
    encoders so it is a drop-in for create_embeddings and retrieval.

    embed_documents treats the given texts as the chunks of ONE document and
    embeds them in a single API call, so each chunk's vector captures the whole
    document's context. Callers must not mix chunks of different documents in
    one call. Limits per call: 32K tokens / document, 1000 inputs, 120K tokens.
    """

    ENDPOINT = "https://api.voyageai.com/v1/contextualizedembeddings"

    def __init__(self, model: str):
        self.model = model

    def _call(self, inputs: List[List[str]], input_type: str) -> List[List[List[float]]]:
        import os
        import requests
        from encoding_library.utils.retry import is_transient_http_error, retry_call
        api_key = os.environ.get("VOYAGE_API_KEY")
        if not api_key:
            raise ValueError("VOYAGE_API_KEY environment variable is not set")
        def _post():
            # raise_for_status inside the retried call so 429/5xx retry too,
            # not just connection errors.
            r = requests.post(
                self.ENDPOINT,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": self.model, "inputs": inputs, "input_type": input_type},
                timeout=300,
            )
            r.raise_for_status()
            return r

        response = retry_call(_post, operation="voyage", retry_if=is_transient_http_error)
        docs = sorted(response.json()["data"], key=lambda d: d["index"])
        return [
            [c["embedding"] for c in sorted(doc["data"], key=lambda c: c["index"])]
            for doc in docs
        ]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        return self._call([texts], input_type="document")[0]

    def embed_query(self, text: str) -> List[float]:
        return self._call([[text]], input_type="query")[0][0]


def get_embedding_model(model_type_str: Optional[str] = None, model_name_str: Optional[str] = None) -> Any:
    """
    Instantiates and returns the appropriate Langchain embedding model.
    Defaults to sentence-transformer / all-MiniLM-L6-v2 if not specified.
    """
    from encoding_library.utils.model_registry import resolve_model, is_contextualized_model
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
        if is_contextualized_model(model_name):
            return VoyageContextualizedEmbeddings(model=model_name)
        from langchain_voyageai import VoyageAIEmbeddings
        return VoyageAIEmbeddings(model=model_name)
    else:
        raise ValueError(f"Unknown language model type specified: {model_type}")

def create_chunks(
    text_to_encode: str,
    encoder: Any,
    chunking_type: Optional[str] = None,
    chunking_technique: Optional[str] = None,
    chunk_size: Optional[int] = None,
    chunk_overlap: Optional[int] = None,
) -> List[str]:
    """
    Creates chunks for the given text using the specified chunking strategy.
    chunk_size/chunk_overlap (tokens) apply to recursive chunking only;
    semantic chunking derives boundaries from the embeddings instead.
    """
    from encoding_library.chunkers.factory import ChunkerFactory
    from encoding_library.chunkers.enums import ChunkingType, RecursiveTechnique

    resolved_type = chunking_type or ChunkingType.RECURSIVE.value
    size_kwargs = {}
    if resolved_type == ChunkingType.RECURSIVE.value:
        if chunk_size is not None:
            size_kwargs["chunk_size"] = int(chunk_size)
        if chunk_overlap is not None:
            size_kwargs["chunk_overlap"] = int(chunk_overlap)

    chunker = ChunkerFactory.get_chunker(
        chunking_type=resolved_type,
        technique=chunking_technique or RecursiveTechnique.TOKEN.value,
        encoder=encoder,
        **size_kwargs
    )

    return chunker.chunk(text_to_encode)

def create_embeddings(chunks: List[str], encoder: Any) -> List[Dict[str, Any]]:
    """
    Creates embeddings for the provided chunks using the specified encoder.
    Returns a list of chunks (dicts with vector, text, index).
    """
    if not chunks:
        return []

    # Encode chunks using native Langchain API implementation format.
    # Retried with backoff: hosted encoders (Voyage/OpenAI) are 3rd-party API
    # calls; for local models a retry is a cheap no-op-on-success.
    from encoding_library.utils.retry import retry_call
    embeddings = retry_call(encoder.embed_documents, chunks, operation="embedding")
         
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
