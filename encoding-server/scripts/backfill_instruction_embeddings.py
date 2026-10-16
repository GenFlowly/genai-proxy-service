#!/usr/bin/env python3
"""
Backfill the vector index for existing instructions.

Scans the Instructions table, picks the LATEST version of every instruction,
and pushes it into the embedding pipeline by sending a MemoryRequestInternalState
message straight to the ingestion SQS queue (the same queue /encode-instructions
feeds). Sending directly avoids needing a per-creator bearer token — the
pipeline stamps each row with its creator's customer_id (the partition key of
the shared instructions collection).

Skipped rows:
  - creators SYSTEM / PUBLIC (no shared collection in v1)
  - latest versions already stamped is_synced_with_milvus=true (re-runnable)

Usage:
    python scripts/backfill_instruction_embeddings.py \
        --queue-url https://sqs.us-east-1.amazonaws.com/<acct>/<ingestion-queue> \
        [--table Instructions] [--region us-east-1] [--dry-run]
"""
import argparse
import json

import boto3
from boto3.dynamodb.types import TypeDeserializer

SKIPPED_CREATORS = {"SYSTEM", "PUBLIC"}

MODEL_TYPE = "voyage"
MODEL_NAME = "voyage-4-large"


def scan_latest_instructions(client, table_name: str) -> dict[str, dict]:
    """Full scan → {instructionId: highest-version row (deserialized)}."""
    deserializer = TypeDeserializer()
    latest: dict[str, dict] = {}
    kwargs = {"TableName": table_name}
    while True:
        page = client.scan(**kwargs)
        for raw in page.get("Items", []):
            item = {k: deserializer.deserialize(v) for k, v in raw.items()}
            iid = item.get("instructionId")
            if not iid:
                continue
            version = int(item.get("version", 0))
            if iid not in latest or version > int(latest[iid].get("version", 0)):
                latest[iid] = item
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return latest


def to_pipeline_message(item: dict) -> dict:
    return {
        "data_type": "INSTRUCTION",
        "customer_id": item["creator"],
        "client": "backfill",
        "raw_data": {
            "instruction_id": item["instructionId"],
            "version": int(item["version"]),
            "name": item.get("name", ""),
            "instructions": item.get("instructions", ""),
            "category": item.get("category"),
            "tags": list(item["tags"]) if item.get("tags") else None,
            "created_at": item.get("createdAt", ""),
        },
        "model_type": MODEL_TYPE,
        "model_name": MODEL_NAME,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue-url", required=True)
    parser.add_argument("--table", default="Instructions")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dynamodb = boto3.client("dynamodb", region_name=args.region)
    sqs = boto3.client("sqs", region_name=args.region)

    latest = scan_latest_instructions(dynamodb, args.table)
    sent = skipped_creator = skipped_synced = skipped_empty = 0

    for iid, item in sorted(latest.items()):
        creator = item.get("creator", "")
        if creator in SKIPPED_CREATORS or not creator:
            skipped_creator += 1
            continue
        if item.get("is_synced_with_milvus"):
            skipped_synced += 1
            continue
        if not item.get("instructions"):
            skipped_empty += 1
            continue

        message = to_pipeline_message(item)
        if args.dry_run:
            print(f"DRY RUN would send {iid} v{message['raw_data']['version']} (creator={creator})")
        else:
            sqs.send_message(
                QueueUrl=args.queue_url,
                MessageBody=json.dumps(message),
                MessageAttributes={
                    "customerId": {"StringValue": creator, "DataType": "String"}
                },
            )
            print(f"Sent {iid} v{message['raw_data']['version']} (creator={creator})")
        sent += 1

    print(
        f"\nDone: {sent} sent, {skipped_synced} already synced, "
        f"{skipped_creator} system/public skipped, {skipped_empty} empty skipped "
        f"({len(latest)} instructions total)"
    )


if __name__ == "__main__":
    main()
