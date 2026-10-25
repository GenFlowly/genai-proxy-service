import os
import json
import logging
import datetime
from typing import Dict, Any, List, Tuple

import boto3
from botocore.exceptions import ClientError

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.utils.embedding_utils import create_chunks
from encoding_library.utils.model_registry import resolve_model, get_chunking_params
from encoding_library.utils.vendor_keys import get_customer_embedding_key
from encoding_library.utils.voyage_batch import (
    build_embeddings_jsonl,
    upload_batch_file,
    create_batch,
)

from encoding_library.observability import count, setup_logging, track

from services.content_logging import default_log_level

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()

CUSTOMER_NOTES_TABLE = os.environ.get("CUSTOMER_NOTES_TABLE", "CustomerNotes")
NOTES_STATUS_INDEX = os.environ.get("NOTES_EMBEDDING_STATUS_INDEX", "embedding-status-index")
DOCUMENTS_BUCKET = os.environ.get("DOCUMENTS_BUCKET")
VOYAGE_BATCH_TABLE = os.environ.get("VOYAGE_BATCH_TABLE", "VoyageBatchJobs")
# Cap notes per run; leftovers are picked up on the next tick. Keeps us under
# Voyage's per-job limits (100K inputs / 1GB) with margin.
MAX_NOTES_PER_RUN = int(os.environ.get("MAX_NOTES_PER_RUN", 2000))

s3 = None
dynamodb = None


def _now() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


def _query_pending(limit: int) -> List[Dict[str, Any]]:
    """Sparse-GSI query for notes whose embedding_status == 'pending'."""
    items: List[Dict[str, Any]] = []
    kwargs = {
        "TableName": CUSTOMER_NOTES_TABLE,
        "IndexName": NOTES_STATUS_INDEX,
        "KeyConditionExpression": "#es = :p",
        "ExpressionAttributeNames": {"#es": "embedding_status"},
        "ExpressionAttributeValues": {":p": {"S": "pending"}},
    }
    while len(items) < limit:
        resp = dynamodb.query(**kwargs)
        items.extend(resp.get("Items", []))
        lek = resp.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    return items[:limit]


def _claim_note(customer_id: str, note_key: str, batch_marker: str) -> bool:
    """
    Atomically move a note pending -> submitted so overlapping accumulator runs
    don't pack the same note into two jobs. Returns False if already claimed.
    """
    try:
        dynamodb.update_item(
            TableName=CUSTOMER_NOTES_TABLE,
            Key={"customerId": {"S": customer_id}, "noteKey": {"S": note_key}},
            UpdateExpression="SET #es = :submitted, embedding_batch_id = :b, embedding_updated_at = :now",
            ConditionExpression="#es = :pending",
            ExpressionAttributeNames={"#es": "embedding_status"},
            ExpressionAttributeValues={
                ":submitted": {"S": "submitted"},
                ":pending": {"S": "pending"},
                ":b": {"S": batch_marker},
                ":now": {"S": _now()},
            },
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def _reset_note(customer_id: str, note_key: str) -> None:
    """Roll a note back to pending (used if job submission fails after claiming)."""
    try:
        dynamodb.update_item(
            TableName=CUSTOMER_NOTES_TABLE,
            Key={"customerId": {"S": customer_id}, "noteKey": {"S": note_key}},
            UpdateExpression="SET #es = :pending, embedding_updated_at = :now REMOVE embedding_batch_id",
            ExpressionAttributeNames={"#es": "embedding_status"},
            ExpressionAttributeValues={":pending": {"S": "pending"}, ":now": {"S": _now()}},
        )
    except Exception as e:
        logger.error(f"Failed to reset note {note_key} to pending: {e}")


def _note_doc_key(customer_id: str, note_key: str) -> str:
    """Durable per-note document key: {customerId}/notes/{noteKey}.json."""
    return f"{customer_id}/notes/{note_key}.json"


def _note_to_state(item: Dict[str, Any]) -> Tuple[str, str, MemoryRequestInternalState]:
    customer_id = item["customerId"]["S"]
    note_key = item["noteKey"]["S"]
    raw_data = {
        "note_key": note_key,
        "note_value": item.get("noteValue", {}).get("S", ""),
        "title": item.get("title", {}).get("S"),
        # noteCreatedAt is client-supplied; fall back to DDB createdAt
        "created_at": item.get("noteCreatedAt", {}).get("S") or item.get("createdAt", {}).get("S", ""),
    }
    model_type, model_name = resolve_model(
        item.get("embedding_model_type", {}).get("S"),
        item.get("embedding_model", {}).get("S"),
    )
    state = MemoryRequestInternalState(
        data_type="NOTE",
        customer_id=customer_id,
        client="notes",
        raw_data=raw_data,  # kept for storage (metadata + note_key); no SFN size limit here
        model_type=model_type,
        model_name=model_name,
        chunking_type="recursive",
        chunking_technique="token",
    )
    return customer_id, note_key, state


def _submit_group(
    customer_id: str, model_name: str, api_key: str,
    states: List[Dict[str, Any]], refs: List[Dict[str, str]],
) -> str:
    """
    Submit one Voyage batch job for a same-customer, same-model group; returns
    batch_id. A job runs on exactly one Voyage API key, so it can never mix
    customers. Per-note documents are already staged in S3 (see handler); the
    job row stores the ordered ref list ({customer_id, note_key, s3_key}) so
    the poller can download them in JSONL order and map results by custom_id
    b{i}c{j}.
    """
    jsonl = build_embeddings_jsonl(states, model_name)
    file_id = upload_batch_file(jsonl, api_key)
    batch = create_batch(file_id, model_name, api_key)
    batch_id = batch["id"]

    now = _now()
    dynamodb.put_item(
        TableName=VOYAGE_BATCH_TABLE,
        Item={
            "batch_id": {"S": batch_id},
            "status": {"S": "in_progress"},
            "source": {"S": "notes-accumulator"},
            "customer_id": {"S": customer_id},
            "note_refs_json": {"S": json.dumps(refs)},
            "model_name": {"S": model_name},
            "note_count": {"N": str(len(refs))},
            "created_at": {"S": now},
            "updated_at": {"S": now},
        },
    )
    return batch_id


@track("voyage_batch_accumulate")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Table-driven bulk accumulator. Sweeps CustomerNotes for notes marked
    embedding_status='pending' (batch-mode customers), packs them into one Voyage
    batch job per model, stages the payload, and records a tracking row. The
    scheduled poller reconciles the job and stores results when it completes.
    """
    global s3, dynamodb
    if not DOCUMENTS_BUCKET:
        raise ValueError("DOCUMENTS_BUCKET environment variable is not set")

    region = os.environ.get("AWS_REGION", "us-east-1")
    if s3 is None:
        s3 = boto3.client("s3", region_name=region)
    if dynamodb is None:
        dynamodb = boto3.client("dynamodb", region_name=region)

    pending = _query_pending(MAX_NOTES_PER_RUN)
    logger.info(f"Accumulator: {len(pending)} pending note(s) (cap {MAX_NOTES_PER_RUN}).")
    if not pending:
        return {"pending": 0, "submitted_jobs": 0, "notes_submitted": 0}

    # Claim + chunk, grouping by (customer, model) — a Voyage batch job runs on
    # exactly one API key, so customers can never share a job.
    groups: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    customer_keys: Dict[str, Any] = {}
    batch_marker = "pending-submit"
    for item in pending:
        if item.get("is_delete", {}).get("BOOL"):
            continue
        customer_id, note_key, state = _note_to_state(item)
        if (state.model_type or "") != "voyage":
            logger.warning(f"Note {note_key} has non-voyage model '{state.model_type}'; skipping.")
            continue

        if customer_id not in customer_keys:
            try:
                customer_keys[customer_id] = get_customer_embedding_key(customer_id, "voyage")
            except Exception as e:
                logger.error(f"Failed to resolve voyage key for customer {customer_id}: {e}")
                customer_keys[customer_id] = None
        api_key = customer_keys[customer_id]
        if not api_key:
            # Leave unclaimed (still 'pending') — picked up again once the
            # customer stores a key, rather than claimed into a job that can
            # never submit.
            count("voyage_batch_no_customer_key_total")
            logger.warning(f"Customer {customer_id} has no Voyage key; leaving note {note_key} pending.")
            continue

        if not _claim_note(customer_id, note_key, batch_marker):
            continue  # grabbed by a concurrent run

        processor = ProcessorFactory.get_processor(state)
        text = processor.get_text_to_encode(state)
        # Per-model chunking params from the EmbeddingModelRegistry table
        # (cached per process; falls back to code defaults)
        chunk_size, chunk_overlap = get_chunking_params(state.model_type, state.model_name)
        chunks = create_chunks(
            text, None, chunking_type="recursive", chunking_technique="token",
            chunk_size=chunk_size, chunk_overlap=chunk_overlap,
        )
        if not chunks:
            _reset_note(customer_id, note_key)
            continue
        state.data_chunks = chunks

        # Stage the durable per-note document at {customerId}/notes/{noteKey}.json
        s3_key = _note_doc_key(customer_id, note_key)
        s3.put_object(
            Bucket=DOCUMENTS_BUCKET,
            Key=s3_key,
            Body=json.dumps(state.to_dict()).encode("utf-8"),
            ContentType="application/json",
        )

        key = (customer_id, state.model_type, state.model_name)
        g = groups.setdefault(key, {"states": [], "refs": []})
        g["states"].append(state.to_dict())
        g["refs"].append({"customer_id": customer_id, "note_key": note_key, "s3_key": s3_key})

    submitted_jobs = 0
    notes_submitted = 0
    for (customer_id, model_type, model_name), g in groups.items():
        if not g["states"]:
            continue
        try:
            batch_id = _submit_group(customer_id, model_name, customer_keys[customer_id], g["states"], g["refs"])
            # Stamp batch_id + the note's document key onto each claimed note (O(1) lookup)
            for ref in g["refs"]:
                dynamodb.update_item(
                    TableName=CUSTOMER_NOTES_TABLE,
                    Key={"customerId": {"S": ref["customer_id"]}, "noteKey": {"S": ref["note_key"]}},
                    UpdateExpression="SET embedding_batch_id = :b, embedding_s3_key = :k, embedding_updated_at = :now",
                    ExpressionAttributeValues={
                        ":b": {"S": batch_id},
                        ":k": {"S": ref["s3_key"]},
                        ":now": {"S": _now()},
                    },
                )
            submitted_jobs += 1
            notes_submitted += len(g["refs"])
            logger.info(f"Submitted batch {batch_id}: {len(g['refs'])} note(s), model={model_name}.")
        except Exception as e:
            logger.error(f"Submit failed for model {model_name}; rolling back {len(g['refs'])} note(s): {e}", exc_info=True)
            for ref in g["refs"]:
                _reset_note(ref["customer_id"], ref["note_key"])

    result = {"pending": len(pending), "submitted_jobs": submitted_jobs, "notes_submitted": notes_submitted}
    logger.info(f"Accumulator done: {result}")
    return result
