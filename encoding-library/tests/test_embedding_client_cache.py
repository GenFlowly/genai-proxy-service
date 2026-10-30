"""Hosted embedding clients must be reused per (model, credential hashes) —
constructing a fresh voyageai client per call pins a ~31MB HF tokenizer in a
class-level lru_cache (see
documents/Incidents/RetrievalServerMemoryLeakIncidentOct2026.md) — while a
changed credential must always produce a fresh client, never another
customer's."""
import pytest

import tokenizers

from encoding_library.utils import embedding_utils, vendor_keys
from encoding_library.utils.embedding_utils import (
    EmbeddingKeyMissing,
    VoyageContextualizedEmbeddings,
    get_embedding_model,
    get_embedding_model_for_customer,
)

VOYAGE_MODEL = "voyage-3.5"
CONTEXT_MODEL = "voyage-context-3"
OPENAI_MODEL = "text-embedding-3-small"


class FakeTokenizer:
    def no_truncation(self):
        pass


@pytest.fixture(autouse=True)
def clear_client_cache():
    embedding_utils._client_cache.clear()
    yield
    embedding_utils._client_cache.clear()


@pytest.fixture
def fake_tokenizer_loads(monkeypatch):
    calls = []

    def fake_from_pretrained(identifier, **kwargs):
        calls.append((identifier, kwargs))
        return FakeTokenizer()

    monkeypatch.setattr(
        tokenizers.Tokenizer, "from_pretrained", staticmethod(fake_from_pretrained)
    )
    return calls


def test_same_credentials_return_same_voyage_instance(fake_tokenizer_loads):
    first = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1")
    second = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1")
    assert first is second
    assert len(fake_tokenizer_loads) == 1


def test_same_credentials_return_same_openai_instance():
    first = get_embedding_model("openai", OPENAI_MODEL, api_key="sk-key-1")
    second = get_embedding_model("openai", OPENAI_MODEL, api_key="sk-key-1")
    assert first is second


def test_rotated_key_builds_new_instance(fake_tokenizer_loads):
    first = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1")
    second = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-2")
    assert first is not second


def test_different_customers_keys_never_share_a_client(fake_tokenizer_loads):
    a = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-customer-a")
    b = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-customer-b")
    assert a is not b
    assert a.voyage_api_key.get_secret_value() == "pa-customer-a"
    assert b.voyage_api_key.get_secret_value() == "pa-customer-b"


def test_hf_token_change_builds_new_instance(fake_tokenizer_loads):
    without = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1")
    with_token = get_embedding_model(
        "voyage", VOYAGE_MODEL, api_key="pa-key-1", hf_token="hf-tok"
    )
    assert without is not with_token


def test_lru_bound_holds(fake_tokenizer_loads):
    for i in range(embedding_utils._CLIENT_CACHE_MAX + 8):
        get_embedding_model("voyage", VOYAGE_MODEL, api_key=f"pa-key-{i}")
    assert len(embedding_utils._client_cache) == embedding_utils._CLIENT_CACHE_MAX


def test_evicted_entry_is_rebuilt(fake_tokenizer_loads):
    first = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-0")
    for i in range(1, embedding_utils._CLIENT_CACHE_MAX + 1):
        get_embedding_model("voyage", VOYAGE_MODEL, api_key=f"pa-key-{i}")
    rebuilt = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-0")
    assert rebuilt is not first


def test_tokenizer_pinned_on_both_clients(fake_tokenizer_loads):
    client = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1")
    assert isinstance(client._client.tokenizer(VOYAGE_MODEL), FakeTokenizer)
    assert isinstance(client._aclient.tokenizer(VOYAGE_MODEL), FakeTokenizer)
    # Pinned on the instances, not the class: the class-level lru_cache must
    # never see these clients.
    assert "tokenizer" in client._client.__dict__
    assert "tokenizer" in client._aclient.__dict__


def test_hf_token_passed_to_hub_download(fake_tokenizer_loads):
    get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1", hf_token="hf-secret")
    identifier, kwargs = fake_tokenizer_loads[0]
    assert identifier == f"voyageai/{VOYAGE_MODEL}"
    assert kwargs.get("token") == "hf-secret"


def test_anonymous_download_omits_token_kwarg(fake_tokenizer_loads):
    get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1")
    _, kwargs = fake_tokenizer_loads[0]
    assert "token" not in kwargs


def test_tokenizer_preload_failure_degrades_to_lazy_load(monkeypatch):
    def boom(identifier, **kwargs):
        raise RuntimeError("hub down")

    monkeypatch.setattr(tokenizers.Tokenizer, "from_pretrained", staticmethod(boom))
    client = get_embedding_model("voyage", VOYAGE_MODEL, api_key="pa-key-1")
    assert "tokenizer" not in client._client.__dict__


def test_contextualized_model_cached_without_tokenizer(fake_tokenizer_loads):
    first = get_embedding_model("voyage", CONTEXT_MODEL, api_key="pa-key-1")
    second = get_embedding_model("voyage", CONTEXT_MODEL, api_key="pa-key-1")
    assert isinstance(first, VoyageContextualizedEmbeddings)
    assert first is second
    assert fake_tokenizer_loads == []


def test_missing_key_still_raises():
    with pytest.raises(EmbeddingKeyMissing):
        get_embedding_model("voyage", VOYAGE_MODEL, api_key=None)


def test_for_customer_fetches_hf_token_for_standard_voyage(monkeypatch, fake_tokenizer_loads):
    hf_calls = []
    monkeypatch.setattr(
        vendor_keys, "get_customer_embedding_key", lambda cid, mt: "pa-key-1"
    )
    monkeypatch.setattr(
        vendor_keys,
        "get_customer_hf_token",
        lambda cid: hf_calls.append(cid) or "hf-tok",
    )
    get_embedding_model_for_customer("CU1", "voyage", VOYAGE_MODEL)
    assert hf_calls == ["CU1"]
    assert fake_tokenizer_loads[0][1].get("token") == "hf-tok"


def test_for_customer_skips_hf_token_for_openai(monkeypatch):
    monkeypatch.setattr(
        vendor_keys, "get_customer_embedding_key", lambda cid, mt: "sk-key-1"
    )

    def fail(cid):
        raise AssertionError("hf token fetched for a non-voyage model")

    monkeypatch.setattr(vendor_keys, "get_customer_hf_token", fail)
    get_embedding_model_for_customer("CU1", "openai", OPENAI_MODEL)
