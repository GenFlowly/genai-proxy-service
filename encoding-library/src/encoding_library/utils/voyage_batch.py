"""
Client for the Voyage AI Batch API (asynchronous embeddings at discounted rates).

Workflow: upload a JSONL file of requests -> create a batch job -> poll status
-> download the output file once completed.
Docs: https://docs.voyageai.com/docs/batch-inference
"""
import json
import os
import logging
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

VOYAGE_API_BASE = "https://api.voyageai.com/v1"

# Terminal batch statuses
BATCH_STATUS_COMPLETED = "completed"
BATCH_STATUS_FAILED = {"failed", "cancelled", "expired"}


def _headers() -> Dict[str, str]:
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        raise ValueError("VOYAGE_API_KEY environment variable is not set")
    return {"Authorization": f"Bearer {api_key}"}


def build_embeddings_jsonl(batches: List[Dict[str, Any]]) -> str:
    """
    Build the JSONL input file content for an embeddings batch job.
    One request line per chunk; custom_id encodes (batch index, chunk index)
    so results (returned unordered) can be mapped back.
    """
    lines = []
    for bi, batch in enumerate(batches):
        for ci, chunk in enumerate(batch.get("data_chunks") or []):
            lines.append(json.dumps({
                "custom_id": f"b{bi}c{ci}",
                "body": {"input": [chunk]},
            }))
    return "\n".join(lines)


def upload_batch_file(jsonl_content: str) -> str:
    """Upload the JSONL input file; returns the file id."""
    response = requests.post(
        f"{VOYAGE_API_BASE}/files",
        headers=_headers(),
        files={"file": ("batch_input.jsonl", jsonl_content.encode("utf-8"), "application/jsonl")},
        data={"purpose": "batch"},
        timeout=120,
    )
    response.raise_for_status()
    file_id = response.json().get("id")
    if not file_id:
        raise ValueError(f"Voyage file upload returned no id: {response.text[:500]}")
    return file_id


def create_batch(input_file_id: str, model_name: str,
                 request_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Create an embeddings batch job; returns the batch object (incl. 'id')."""
    params = {"model": model_name, "input_type": "document"}
    if request_params:
        params.update(request_params)
    response = requests.post(
        f"{VOYAGE_API_BASE}/batches",
        headers={**_headers(), "Content-Type": "application/json"},
        json={
            "endpoint": "/v1/embeddings",
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


def get_batch(batch_id: str) -> Dict[str, Any]:
    """Fetch batch job status/details."""
    response = requests.get(f"{VOYAGE_API_BASE}/batches/{batch_id}", headers=_headers(), timeout=60)
    response.raise_for_status()
    return response.json()


def download_file_content(file_id: str) -> str:
    """Download a (result) file's content as text."""
    response = requests.get(f"{VOYAGE_API_BASE}/files/{file_id}/content", headers=_headers(), timeout=300)
    response.raise_for_status()
    return response.text


def parse_batch_results(jsonl_content: str) -> Dict[str, List[float]]:
    """
    Parse the output JSONL into {custom_id: embedding vector}.
    Lines with a non-200 response or an error are skipped (and logged).
    """
    vectors: Dict[str, List[float]] = {}
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
        data = (response.get("body") or {}).get("data") or []
        if custom_id and data:
            vectors[custom_id] = data[0].get("embedding")
    return vectors
