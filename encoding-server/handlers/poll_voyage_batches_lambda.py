import os
import json
import logging
import datetime
from typing import Dict, Any, List

import boto3
from botocore.exceptions import ClientError

from encoding_library.utils.vendor_keys import get_customer_embedding_key
from encoding_library.utils.voyage_batch import (
    get_batch,
    download_file_content,
    parse_batch_results,
)
from encoding_library.utils.embedding_pricing import get_embedding_cost_per_mtok
from encoding_library.utils.usage_tracking import record_embedding_usage
from handlers.voyage_batch_store import store_batch_results

from encoding_library.observability import setup_logging, track

from services.content_logging import default_log_level

setup_logging("encoding-server", level=default_log_level())
logger = logging.getLogger()

DOCUMENTS_BUCKET = os.environ.get("DOCUMENTS_BUCKET")
VOYAGE_BATCH_TABLE = os.environ.get("VOYAGE_BATCH_TABLE", "VoyageBatchJobs")
STATUS_INDEX = os.environ.get("VOYAGE_BATCH_STATUS_INDEX", "status-index")
CUSTOMER_NOTES_TABLE = os.environ.get("CUSTOMER_NOTES_TABLE", "CustomerNotes")

TERMINAL_FAILED = {"failed", "cancelled", "expired"}

s3 = None
dynamodb = None


def _now() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


def _query_in_progress() -> List[Dict[str, Any]]:
    """Return all tracking rows whose status is 'in_progress' (paginated)."""
    items: List[Dict[str, Any]] = []
    kwargs = {
        "TableName": VOYAGE_BATCH_TABLE,
        "IndexName": STATUS_INDEX,
        "KeyConditionExpression": "#s = :v",
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": {":v": {"S": "in_progress"}},
    }
    while True:
        resp = dynamodb.query(**kwargs)
        items.extend(resp.get("Items", []))
        lek = resp.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    return items


def _claim(batch_id: str) -> bool:
    """
    Atomically move in_progress -> processing so overlapping poller runs don't
    both store the same completed batch. Returns False if already claimed.
    """
    try:
        dynamodb.update_item(
            TableName=VOYAGE_BATCH_TABLE,
            Key={"batch_id": {"S": batch_id}},
            UpdateExpression="SET #s = :processing, updated_at = :now",
            ConditionExpression="#s = :in_progress",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":processing": {"S": "processing"},
                ":in_progress": {"S": "in_progress"},
                ":now": {"S": _now()},
            },
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def _set_status(batch_id: str, status: str, extra: Dict[str, Any] = None) -> None:
    names = {"#s": "status"}
    values = {":s": {"S": status}, ":now": {"S": _now()}}
    set_parts = ["#s = :s", "updated_at = :now"]
    for i, (k, v) in enumerate((extra or {}).items()):
        names[f"#k{i}"] = k
        values[f":k{i}"] = v
        set_parts.append(f"#k{i} = :k{i}")
    dynamodb.update_item(
        TableName=VOYAGE_BATCH_TABLE,
        Key={"batch_id": {"S": batch_id}},
        UpdateExpression="SET " + ", ".join(set_parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _get_doc(s3_key: str) -> Dict[str, Any]:
    obj = s3.get_object(Bucket=DOCUMENTS_BUCKET, Key=s3_key)
    return json.loads(obj["Body"].read())


def _load_batches(job: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Reconstruct the ordered per-item states for a job.
    - notes-accumulator jobs: `note_refs_json` lists {customer_id, note_key, s3_key};
      each per-note document is downloaded in order (custom_id b{i} maps to ref i).
    - legacy per-doc submit jobs: `payload_s3_key` points at a single staged blob
      of the form {"batches": [...]}.
    """
    refs_json = job.get("note_refs_json", {}).get("S")
    if refs_json:
        refs = json.loads(refs_json)
        return [_get_doc(ref["s3_key"]) for ref in refs]
    s3_key = job.get("payload_s3_key", {}).get("S")
    if s3_key:
        obj = s3.get_object(Bucket=DOCUMENTS_BUCKET, Key=s3_key)
        return json.loads(obj["Body"].read())["batches"]
    return []


def _reset_notes_to_pending(batches: List[Dict[str, Any]]) -> None:
    """
    On job failure, roll each note in the payload back to embedding_status=pending
    so the accumulator retries it. Only touches note-typed items that carry a
    note_key (per-document Option A items have raw_data={} and are skipped).
    """
    for state in batches or []:
        raw = state.get("raw_data") or {}
        note_key = raw.get("note_key") or raw.get("noteKey")
        customer_id = state.get("customer_id")
        if not (note_key and customer_id):
            continue
        try:
            dynamodb.update_item(
                TableName=CUSTOMER_NOTES_TABLE,
                Key={"customerId": {"S": customer_id}, "noteKey": {"S": note_key}},
                UpdateExpression="SET embedding_status = :p, embedding_updated_at = :now REMOVE embedding_batch_id",
                ExpressionAttributeValues={":p": {"S": "pending"}, ":now": {"S": _now()}},
            )
        except Exception as e:
            logger.error(f"Failed to reset note {note_key} to pending: {e}")


@track("voyage_batch_poll")
def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Scheduled reconciliation poller (Option A). Runs on an EventBridge schedule.
    Polls every in-flight Voyage batch once; stores results for completed jobs;
    marks failed jobs. One poller run reconciles ALL open jobs, so polling cost
    is flat regardless of how many documents are in flight.
    """
    global s3, dynamodb
    region = os.environ.get("AWS_REGION", "us-east-1")
    if s3 is None:
        s3 = boto3.client("s3", region_name=region)
    if dynamodb is None:
        dynamodb = boto3.client("dynamodb", region_name=region)

    open_jobs = _query_in_progress()
    logger.info(f"Poller: {len(open_jobs)} in-progress batch job(s).")

    completed = 0
    failed = 0
    still_running = 0

    for job in open_jobs:
        batch_id = job["batch_id"]["S"]
        # Legacy single-blob staging key (per-doc submit path); notes-accumulator
        # jobs carry note_refs_json instead and leave this None.
        staging_key = job.get("payload_s3_key", {}).get("S")
        customer_id = job.get("customer_id", {}).get("S")
        model_name = job.get("model_name", {}).get("S")
        try:
            api_key = get_customer_embedding_key(customer_id, "voyage") if customer_id else None
            if not api_key:
                # The customer's key was removed after the job was submitted —
                # leave it in_progress; nothing to poll until a key exists again.
                logger.warning(f"Batch {batch_id}: customer {customer_id} has no Voyage key; skipping.")
                still_running += 1
                continue

            batch = get_batch(batch_id, api_key)
            status = batch.get("status", "unknown")

            if status == "completed":
                if not _claim(batch_id):
                    logger.info(f"Batch {batch_id} already claimed by another run; skipping.")
                    continue

                output_file_id = batch.get("output_file_id")
                if not output_file_id:
                    _reset_notes_to_pending(_load_batches(job))
                    _set_status(batch_id, "failed", {"error": {"S": "completed but no output_file_id"}})
                    failed += 1
                    continue

                vectors_by_id, total_tokens = parse_batch_results(download_file_content(output_file_id, api_key))
                batches = _load_batches(job)
                stored, missing = store_batch_results(batches, vectors_by_id, context)

                if customer_id and model_name and total_tokens:
                    try:
                        realtime_rate = get_embedding_cost_per_mtok("VOYAGE", model_name)
                        # Voyage Batch API runs at ~50% of the realtime per-token
                        # rate — see project notes on the accumulator/poller pair.
                        cost_usd = (
                            (total_tokens / 1_000_000) * realtime_rate * 0.5
                            if realtime_rate is not None else None
                        )
                        record_embedding_usage(customer_id, "VOYAGE", model_name, total_tokens, cost_usd)
                    except Exception:
                        logger.warning(f"Failed to record batch embedding usage for {batch_id}", exc_info=True)

                _set_status(batch_id, "done", {
                    "output_file_id": {"S": output_file_id},
                    "stored_batches": {"N": str(stored)},
                    "missing_chunks": {"N": str(missing)},
                })
                # Clean up only the transient staging blob; per-note documents
                # ({customerId}/notes/...) are durable and kept for re-embedding.
                if staging_key:
                    try:
                        s3.delete_object(Bucket=DOCUMENTS_BUCKET, Key=staging_key)
                    except Exception as ce:
                        logger.warning(f"Could not delete staged payload {staging_key}: {ce}")

                logger.info(f"Batch {batch_id}: stored {stored} batch(es), {missing} missing.")
                completed += 1

            elif status in TERMINAL_FAILED:
                try:
                    _reset_notes_to_pending(_load_batches(job))
                except Exception as re:
                    logger.error(f"Could not reset notes for failed batch {batch_id}: {re}")
                _set_status(batch_id, "failed", {"error": {"S": status}})
                logger.warning(f"Batch {batch_id} ended as '{status}'.")
                failed += 1

            else:
                # validating / in_progress / finalizing -> leave for next tick
                still_running += 1

        except Exception as e:
            # Leave the row as-is (in_progress/processing); retried next tick.
            logger.error(f"Poller error on batch {batch_id}: {str(e)}", exc_info=True)

    result = {
        "open": len(open_jobs),
        "completed": completed,
        "failed": failed,
        "still_running": still_running,
    }
    logger.info(f"Poller done: {result}")
    return result
