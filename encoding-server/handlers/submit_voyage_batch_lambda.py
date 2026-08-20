import os
import json
import logging
import datetime
from typing import Dict, Any

import boto3

from encoding_library.utils.model_registry import resolve_model
from encoding_library.utils.voyage_batch import (
    build_embeddings_jsonl,
    upload_batch_file,
    create_batch,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

DOCUMENTS_BUCKET = os.environ.get("DOCUMENTS_BUCKET")
STAGING_PREFIX = os.environ.get("STAGING_PREFIX", "_staging/")
VOYAGE_BATCH_TABLE = os.environ.get("VOYAGE_BATCH_TABLE", "VoyageBatchJobs")

s3 = None
dynamodb = None


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Batch-mode branch (Option A): submit all chunks as one Voyage Batch API job,
    persist the pending payload to S3, and record a tracking row in DynamoDB.
    The Step Functions execution ENDS here — a separate scheduled poller
    (poll_voyage_batches_lambda) reconciles the job when it completes.
    """
    global s3, dynamodb
    try:
        batches = event.get("batches", [])
        total_chunks = sum(len(b.get("data_chunks") or []) for b in batches)
        logger.info(f"Submitting Voyage batch for {len(batches)} batch(es), {total_chunks} chunk(s).")

        if total_chunks == 0:
            logger.warning("No chunks to embed; nothing to submit.")
            return {"voyage_batch_id": None, "submitted": False}

        model_type, model_name = resolve_model(
            batches[0].get("model_type"), batches[0].get("model_name")
        )
        if model_type != "voyage":
            raise ValueError(f"processing_mode=batch requires model_type=voyage, got '{model_type}'")

        if not DOCUMENTS_BUCKET:
            raise ValueError("DOCUMENTS_BUCKET environment variable is not set")

        region = os.environ.get("AWS_REGION", "us-east-1")
        if s3 is None:
            s3 = boto3.client("s3", region_name=region)
        if dynamodb is None:
            dynamodb = boto3.client("dynamodb", region_name=region)

        # 1. Create the batch job at Voyage
        jsonl = build_embeddings_jsonl(batches)
        file_id = upload_batch_file(jsonl)
        batch = create_batch(file_id, model_name)
        batch_id = batch["id"]

        # 2. Persist the pending payload (chunks + metadata needed to store later)
        #    under the transient _staging/ prefix (lifecycle-expired). DynamoDB
        #    item limits make S3 the safe home for arbitrary size.
        s3_key = f"{STAGING_PREFIX}{batch_id}.json"
        s3.put_object(
            Bucket=DOCUMENTS_BUCKET,
            Key=s3_key,
            Body=json.dumps({"batches": batches}).encode("utf-8"),
            ContentType="application/json",
        )

        # 3. Record a tracking row; the poller queries these by status.
        now = datetime.datetime.utcnow().isoformat() + "Z"
        customer_id = str(batches[0].get("customer_id") or "")
        dynamodb.put_item(
            TableName=VOYAGE_BATCH_TABLE,
            Item={
                "batch_id": {"S": batch_id},
                "status": {"S": "in_progress"},
                "customer_id": {"S": customer_id},
                "payload_s3_key": {"S": s3_key},
                "model_name": {"S": model_name},
                "chunk_count": {"N": str(total_chunks)},
                "created_at": {"S": now},
                "updated_at": {"S": now},
            },
        )

        logger.info(f"Submitted Voyage batch {batch_id}; tracked in {VOYAGE_BATCH_TABLE}.")
        return {"voyage_batch_id": batch_id, "submitted": True}

    except Exception as e:
        logger.error(f"Error in submit_voyage_batch_lambda: {str(e)}", exc_info=True)
        raise
