"""
Client for the Voyage AI Batch API (asynchronous embeddings at discounted rates).

Workflow: upload a JSONL file of requests -> create a batch job -> poll status
-> download the output file once completed.
Docs: https://docs.voyageai.com/docs/batch-inference

Every call takes the api_key explicitly — the customer's own Voyage key,
never a platform-wide environment variable.
"""
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

VOYAGE_API_BASE = "https://api.voyageai.com/v1"

# Terminal batch statuses
BATCH_STATUS_COMPLETED = "completed"
BATCH_STATUS_FAILED = {"failed", "cancelled", "expired"}


def _headers(api_key: str) -> Dict[str, str]:
    if not api_key:
        from encoding_library.utils.embedding_utils import EmbeddingKeyMissing
        raise EmbeddingKeyMissing("voyage")
    return {"Authorization": f"Bearer {api_key}"}


def build_embeddings_jsonl(batches: List[Dict[str, Any]], model_name: Optional[str] = None) -> str:
    """
    Build the JSONL input file content for an embeddings batch job.

    Standard models: one request line per chunk; custom_id "b{bi}c{ci}" encodes
    (batch index, chunk index) so results (returned unordered) map back.

    Contextualized models (voyage-context-*): one request line per batch —
    each batch's chunks are sent together as one document (nested "inputs")
    so every chunk vector captures the whole document's context. custom_id is
    "b{bi}"; parse_batch_results expands results back to "b{bi}c{ci}" keys.
    """
    from encoding_library.utils.model_registry import is_contextualized_model
    lines = []
    if is_contextualized_model(model_name):
        for bi, batch in enumerate(batches):
            chunks = batch.get("data_chunks") or []
            if chunks:
                lines.append(json.dumps({
                    "custom_id": f"b{bi}",
                    "body": {"inputs": [chunks]},
                }))
    else:
        for bi, batch in enumerate(batches):
            for ci, chunk in enumerate(batch.get("data_chunks") or []):
                lines.append(json.dumps({
                    "custom_id": f"b{bi}c{ci}",
                    "body": {"input": [chunk]},
                }))
    return "\n".join(lines)


def upload_batch_file(jsonl_content: str, api_key: str) -> str:
    """Upload the JSONL input file; returns the file id."""
    response = requests.post(
        f"{VOYAGE_API_BASE}/files",
        headers=_headers(api_key),
        files={"file": ("batch_input.jsonl", jsonl_content.encode("utf-8"), "application/jsonl")},
        data={"purpose": "batch"},
        timeout=120,
    )
    response.raise_for_status()
    file_id = response.json().get("id")
    if not file_id:
        raise ValueError(f"Voyage file upload returned no id: {response.text[:500]}")
    return file_id


def create_batch(input_file_id: str, model_name: str, api_key: str,
                 request_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Create an embeddings batch job; returns the batch object (incl. 'id')."""
    from encoding_library.utils.model_registry import is_contextualized_model
    endpoint = (
        "/v1/contextualizedembeddings" if is_contextualized_model(model_name)
        else "/v1/embeddings"
    )
    params = {"model": model_name, "input_type": "document"}
    if request_params:
        params.update(request_params)
    response = requests.post(
        f"{VOYAGE_API_BASE}/batches",
        headers={**_headers(api_key), "Content-Type": "application/json"},
        json={
            "endpoint": endpoint,
            "completion_window": "12h",
            "input_file_id": input_file_id,
            "request_params": params,
        },
        timeout=60,
    )
    response.raise_for_status()
    batch = response.json()
    if not batch.get("id"):
        raise ValueError(f"Voyage batch creation returned no id: {response.text[:500]}")
    logger.info(f"Created Voyage batch {batch['id']} (model={model_name})")
    return batch


def get_batch(batch_id: str, api_key: str) -> Dict[str, Any]:
    """Fetch batch job status/details."""
    response = requests.get(f"{VOYAGE_API_BASE}/batches/{batch_id}", headers=_headers(api_key), timeout=60)
    response.raise_for_status()
    return response.json()


def download_file_content(file_id: str, api_key: str) -> str:
    """Download a (result) file's content as text."""
    response = requests.get(f"{VOYAGE_API_BASE}/files/{file_id}/content", headers=_headers(api_key), timeout=300)
    response.raise_for_status()
    return response.text


def parse_batch_results(jsonl_content: str) -> Tuple[Dict[str, List[float]], Optional[int]]:
    """
    Parse the output JSONL into ({"b{bi}c{ci}": embedding vector}, total_tokens).

    total_tokens sums each line's response.body.usage.total_tokens — the same
    field the (non-batch) voyageai SDK reads off a live embeddings/
    contextualized-embeddings response, since a batch line's body is that same
    per-request API response shape. Not verified against a live batch
    response at the time this was written: if a line's body has no "usage"
    field, it's simply not counted (total_tokens may end up None if NO line
    carries one) rather than raising — a missing token count must never
    break result parsing.

    Lines with a non-200 response or an error are skipped (and logged).

    Handles both result shapes:
    - standard embeddings: custom_id "b{bi}c{ci}", flat data[0].embedding
    - contextualized embeddings: custom_id "b{bi}", data[0] is a per-document
      list whose nested data holds one embedding per chunk — expanded here to
      "b{bi}c{ci}" keys so downstream mapping is identical for both.
    """
    vectors: Dict[str, List[float]] = {}
    total_tokens = 0
    saw_tokens = False
    for line in jsonl_content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            logger.warning(f"Skipping unparseable batch result line: {line[:200]}")
            continue
        custom_id = record.get("custom_id")
        response = record.get("response") or {}
        if record.get("error") or response.get("status_code") != 200:
            logger.warning(f"Batch request {custom_id} failed: {record.get('error') or response.get('status_code')}")
            continue
        body = response.get("body") or {}
        data = body.get("data") or []
        line_tokens = (body.get("usage") or {}).get("total_tokens")
        if line_tokens is not None:
            total_tokens += line_tokens
            saw_tokens = True
        if not custom_id or not data:
            continue
        first = data[0]
        if isinstance(first, dict) and "data" in first:
            # Contextualized: one document per request line, nested chunk list
            chunk_items = sorted(first.get("data") or [], key=lambda c: c.get("index", 0))
            for ci, item in enumerate(chunk_items):
                vectors[f"{custom_id}c{ci}"] = item.get("embedding")
        else:
            vectors[custom_id] = first.get("embedding")
    return vectors, (total_tokens if saw_tokens else None)
