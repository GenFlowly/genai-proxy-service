import hashlib
import logging
import math
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class EmbeddingKeyMissing(Exception):
    """A hosted embedding model was requested without an API key for its
    provider. Hosted embeddings run exclusively on the customer's own key
    (CustomerVendorApiKeys) — there is no platform-wide fallback."""

    def __init__(self, provider: str):
        self.provider = provider
        super().__init__(
            f"No API key available for embedding provider '{provider}' — "
            "the customer has not stored one."
        )


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

    def __init__(self, model: str, api_key: str):
        if not api_key:
            raise EmbeddingKeyMissing("voyage")
        self.model = model
        self.api_key = api_key

    def _call_with_usage(
        self, inputs: List[List[str]], input_type: str
    ) -> Tuple[List[List[List[float]]], Optional[int]]:
        import requests
        from encoding_library.utils.retry import is_transient_http_error, retry_call
        api_key = self.api_key
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
        body = response.json()
        docs = sorted(body["data"], key=lambda d: d["index"])
        vectors = [
            [c["embedding"] for c in sorted(doc["data"], key=lambda c: c["index"])]
            for doc in docs
        ]
        # Not verified against a live response at the time this was written —
        # the voyageai SDK's own ContextualizedEmbeddingsObject reads this same
        # field off the equivalent SDK-wrapped call (response.usage.total_tokens),
        # so it should mirror here since this hits the identical REST endpoint;
        # degrades to None (no usage recorded) rather than raising if absent.
        total_tokens = (body.get("usage") or {}).get("total_tokens")
        return vectors, total_tokens

    def _call(self, inputs: List[List[str]], input_type: str) -> List[List[List[float]]]:
        vectors, _ = self._call_with_usage(inputs, input_type)
        return vectors

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        return self._call([texts], input_type="document")[0]

    def embed_query(self, text: str) -> List[float]:
        return self._call([[text]], input_type="query")[0][0]


# Hosted embedding clients are cached per (model, credential hashes). A fresh
# voyageai client per call is NOT a cheap wrapper: voyageai's
# BaseClient.tokenizer is functools.lru_cache on an instance method, so the
# class-level cache pins every (client, model) pair's ~31MB HF tokenizer for
# the process lifetime (see
# documents/Incidents/RetrievalServerMemoryLeakIncidentOct2026.md). Cache keys
# hold sha256 hashes, never plaintext; a rotated key is a new entry, and two
# customers share a client only when their stored credentials are
# byte-identical — the same isolation the api_key contract guarantees.
_CLIENT_CACHE_MAX = 32
_client_cache: "OrderedDict[tuple, Any]" = OrderedDict()
_client_cache_lock = threading.Lock()


def _sha256(value: Optional[str]) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _cached_client(cache_key: tuple, build) -> Any:
    with _client_cache_lock:
        client = _client_cache.get(cache_key)
        if client is not None:
            _client_cache.move_to_end(cache_key)
            return client
    # Built outside the lock: construction may fetch a tokenizer over the
    # network. A concurrent duplicate loses the race below and is discarded.
    client = build()
    with _client_cache_lock:
        existing = _client_cache.get(cache_key)
        if existing is not None:
            return existing
        _client_cache[cache_key] = client
        while len(_client_cache) > _CLIENT_CACHE_MAX:
            _client_cache.popitem(last=False)
    return client


def _attach_voyage_tokenizer(embeddings: Any, model: str, hf_token: Optional[str]) -> None:
    """Pin the model's HF tokenizer to this client instance, shadowing
    voyageai's class-level lru_cache (BaseClient.tokenizer) so nothing is
    retained beyond the client's own lifetime. The pinned loader ignores the
    model argument because each cached client embeds exactly one model.
    hf_token (the customer's own, optional) authenticates the Hub download;
    it is passed per call and never exported into the process environment —
    this process serves many customers. Preload failure degrades to the SDK's
    lazy anonymous load."""
    try:
        from tokenizers import Tokenizer
        kwargs = {"token": hf_token} if hf_token else {}
        try:
            tokenizer = Tokenizer.from_pretrained(f"voyageai/{model}", **kwargs)
        except TypeError:
            # tokenizers < 0.20 spells the kwarg auth_token.
            tokenizer = Tokenizer.from_pretrained(f"voyageai/{model}", auth_token=hf_token)
        tokenizer.no_truncation()
    except Exception as e:
        logger.warning(
            "Voyage tokenizer preload failed for %s (SDK lazy load will apply): %s", model, e
        )
        return

    def _pinned(_model: str) -> Any:
        return tokenizer

    embeddings._client.tokenizer = _pinned
    embeddings._aclient.tokenizer = _pinned


def get_embedding_model(
    model_type_str: Optional[str] = None,
    model_name_str: Optional[str] = None,
    api_key: Optional[str] = None,
    hf_token: Optional[str] = None,
) -> Any:
    """
    Returns the appropriate Langchain embedding model, cached per
    (model, credential hashes) for hosted providers. Defaults to
    sentence-transformer / all-MiniLM-L6-v2 if not specified.

    Hosted providers (voyage/openai) embed on the given api_key — the
    customer's own, never an environment variable; raises EmbeddingKeyMissing
    without one. hf_token (optional, also the customer's own) authenticates
    Voyage tokenizer downloads from the HF Hub. Local sentence-transformer
    models ignore both and are not cached here — consumers cache those per
    model, they are keyless so cross-customer reuse is safe.
    """
    from encoding_library.utils.model_registry import resolve_model, is_contextualized_model
    model_type, model_name = resolve_model(model_type_str, model_name_str)

    if model_type == "sentence-transformer":
        from langchain_huggingface import HuggingFaceEmbeddings
        return HuggingFaceEmbeddings(model_name=model_name)
    if model_type not in ("openai", "voyage"):
        raise ValueError(f"Unknown language model type specified: {model_type}")
    if not api_key:
        raise EmbeddingKeyMissing(model_type)

    cache_key = (model_type, model_name, _sha256(api_key), _sha256(hf_token))

    if model_type == "openai":
        from langchain_openai import OpenAIEmbeddings
        return _cached_client(
            cache_key, lambda: OpenAIEmbeddings(model=model_name, api_key=api_key)
        )
    if is_contextualized_model(model_name):
        return _cached_client(
            cache_key, lambda: VoyageContextualizedEmbeddings(model=model_name, api_key=api_key)
        )
    from langchain_voyageai import VoyageAIEmbeddings

    def _build_voyage() -> Any:
        client = VoyageAIEmbeddings(model=model_name, api_key=api_key)
        _attach_voyage_tokenizer(client, model_name, hf_token)
        return client

    return _cached_client(cache_key, _build_voyage)


def get_embedding_model_for_customer(
    customer_id: str,
    model_type_str: Optional[str] = None,
    model_name_str: Optional[str] = None,
) -> Any:
    """
    get_embedding_model with credentials resolved per call from the customer's
    stored rows (CustomerVendorApiKeys, KMS-decrypted): the provider api_key,
    plus the optional Hugging Face token for standard Voyage models (the only
    path that downloads a tokenizer). Per-call resolution keeps rotation
    immediate — a changed key simply misses the client cache. Raises
    EmbeddingKeyMissing when a hosted model is requested and the customer has
    no key for its provider.
    """
    from encoding_library.utils.model_registry import is_contextualized_model, resolve_model
    from encoding_library.utils.vendor_keys import get_customer_embedding_key, get_customer_hf_token

    model_type, model_name = resolve_model(model_type_str, model_name_str)
    api_key = get_customer_embedding_key(customer_id, model_type)
    hf_token = None
    if model_type == "voyage" and not is_contextualized_model(model_name):
        hf_token = get_customer_hf_token(customer_id)
    return get_embedding_model(model_type, model_name, api_key=api_key, hf_token=hf_token)

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

def _embed_voyage_with_usage(encoder: Any, chunks: List[str]) -> Tuple[List[List[float]], Optional[int]]:
    """
    Embeds via the raw voyageai client instead of the langchain_voyageai
    wrapper's embed_documents(), which discards the vendor's token-usage
    field (voyageai.object.embeddings.EmbeddingsObject.total_tokens / the
    contextualized equivalent both carry it; the wrapper only keeps
    .embeddings). Reuses the wrapper's own _build_batches() so request-size
    batching behavior is identical to going through embed_documents() —
    this is NOT a from-scratch reimplementation of its batching, just a
    swap of which call extracts the result from each batch.
    """
    from encoding_library.utils.retry import retry_call

    vectors: List[List[float]] = []
    total_tokens = 0
    saw_tokens = False
    is_context_model = encoder._is_context_model()
    for batch, _ in encoder._build_batches(chunks):
        if is_context_model:
            kwargs: dict = dict(
                inputs=[batch],
                model=encoder.model,
                input_type="document",
                output_dimension=encoder.output_dimension,
                chunk_size=32_000,
                enable_auto_chunking=True,
            )
            response = retry_call(
                encoder._client.contextualized_embed, operation="embedding", **kwargs
            )
            vectors.extend(emb for result in response.results for emb in result.embeddings)
        else:
            response = retry_call(
                encoder._client.embed,
                batch,
                model=encoder.model,
                input_type="document",
                truncation=encoder.truncation,
                output_dimension=encoder.output_dimension,
                operation="embedding",
            )
            vectors.extend(response.embeddings)
        batch_tokens = getattr(response, "total_tokens", None)
        if batch_tokens is not None:
            total_tokens += batch_tokens
            saw_tokens = True
    return vectors, (total_tokens if saw_tokens else None)


def _record_embedding_usage_safe(
    customer_id: Optional[str], vendor: Optional[str], model: Optional[str], total_tokens: Optional[int]
) -> None:
    if not customer_id or not vendor or not model:
        return
    try:
        from encoding_library.utils.embedding_pricing import get_embedding_cost_per_mtok
        from encoding_library.utils.usage_tracking import record_embedding_usage
        cost_per_mtok = get_embedding_cost_per_mtok(vendor, model)
        cost_usd = (
            (total_tokens / 1_000_000) * cost_per_mtok
            if total_tokens is not None and cost_per_mtok is not None
            else None
        )
        record_embedding_usage(customer_id, vendor, model, total_tokens, cost_usd)
    except Exception:
        logger.warning("Failed to record embedding usage (customer=%s)", customer_id, exc_info=True)


def create_embeddings(
    chunks: List[str], encoder: Any, customer_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Creates embeddings for the provided chunks using the specified encoder.
    Returns a list of chunks (dicts with vector, text, index).

    customer_id, when given, enables Cost and Usage tracking: for hosted
    encoders (Voyage) the vendor's real token usage is captured by bypassing
    the langchain wrapper's embed_documents() (which discards it) in favor of
    calling the same underlying client directly. OpenAI embeddings are NOT
    instrumented yet — langchain_openai's wrapper does its own token-aware
    length-safe batching (_get_len_safe_embeddings) that would be risky to
    reimplement just for usage capture; a future pass could add tiktoken-based
    estimation instead of bypassing it. Local sentence-transformer models have
    no cost and are never instrumented.
    """
    if not chunks:
        return []

    from encoding_library.utils.retry import retry_call

    vendor: Optional[str] = None
    model: Optional[str] = None
    total_tokens: Optional[int] = None

    is_voyage_langchain = False
    try:
        from langchain_voyageai import VoyageAIEmbeddings
        is_voyage_langchain = isinstance(encoder, VoyageAIEmbeddings)
    except ImportError:
        pass

    if is_voyage_langchain:
        vendor, model = "VOYAGE", encoder.model
        embeddings, total_tokens = _embed_voyage_with_usage(encoder, chunks)
    elif isinstance(encoder, VoyageContextualizedEmbeddings):
        vendor, model = "VOYAGE", encoder.model
        embeddings, total_tokens = encoder._call_with_usage([chunks], input_type="document")
        embeddings = embeddings[0]
    else:
        # OpenAI hosted + local sentence-transformer path: native langchain
        # API, no usage capture (see docstring).
        embeddings = retry_call(encoder.embed_documents, chunks, operation="embedding")

    _record_embedding_usage_safe(customer_id, vendor, model, total_tokens)

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
