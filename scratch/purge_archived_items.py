#!/usr/bin/env python3
"""
One-time cleanup: permanently delete what was archived before archive became delete.

Archiving a conversation only set archivedAt, and deleting a note only set
is_delete; both rows (and the conversation's messages, files and vectors)
stayed. Delete is permanent now, so this queues a deletion job for every
such conversation and note. The proxy server's deletion sweep
(PurgeJobWorker, every minute, 25 jobs a sweep) then deletes each one
everywhere, exactly as a delete from the app does.

It reads only keys and the archived/deleted flags, never content.

DO NOT RUN until the proxy server with ContentDeletionService is deployed to
that stage: its sweep is what deletes the queued items.

Usage:
  python scratch/purge_archived_items.py            # dry-run (default): count what would be queued
  python scratch/purge_archived_items.py --apply    # queue the deletion jobs
  AWS_PROFILE=production python scratch/purge_archived_items.py [--apply]

Re-running is safe: a job already queued for an item is left alone.
"""

import argparse
import os
import re
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

CONVERSATION_TABLE = "Conversation"
NOTES_TABLE = "CustomerNotes"
PURGE_JOBS_TABLE = "PurgeJobs"
# Ids we generate; anything else could widen the deletion's file prefixes.
CUSTOMER_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
RESERVED_IDS = {"system", "public"}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def scan(table, filter_expression, projection, names):
    items, kwargs = [], {
        "FilterExpression": filter_expression,
        "ProjectionExpression": projection,
        "ExpressionAttributeNames": names,
    }
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def deletable(customer_id) -> bool:
    return bool(customer_id) and bool(CUSTOMER_ID.match(customer_id)) and customer_id.lower() not in RESERVED_IDS


def queue(jobs_table, job_type, customer_id, item_id, parent_id, now) -> bool:
    item = {
        "jobKey": f"{job_type}#{customer_id}#{item_id}",
        "type": job_type,
        "customerId": customer_id,
        "itemId": item_id,
        "requestedAt": now,
        "stage": 0,
        "attempts": 0,
        "pendingShard": "PENDING",
        "dueAt": now,
    }
    if parent_id:
        item["parentId"] = parent_id
    try:
        jobs_table.put_item(Item=item, ConditionExpression="attribute_not_exists(jobKey)")
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="queue the deletion jobs (default: dry-run)")
    args = parser.parse_args()

    db = boto3.resource("dynamodb", region_name=os.getenv("AWS_REGION", "us-east-1"))
    conversations = scan(
        db.Table(CONVERSATION_TABLE), Attr("archivedAt").exists(),
        "#c, #id, #p", {"#c": "customerId", "#id": "conversationId", "#p": "parentConversationId"},
    )
    notes = scan(
        db.Table(NOTES_TABLE), Attr("is_delete").eq(True),
        "#c, #k", {"#c": "customerId", "#k": "noteKey"},
    )
    skipped = [i for i in conversations + notes if not deletable(i.get("customerId"))]
    conversations = [c for c in conversations if deletable(c.get("customerId"))]
    notes = [n for n in notes if deletable(n.get("customerId"))]
    customers = {i["customerId"] for i in conversations + notes}

    print(f"Archived conversations: {len(conversations)}")
    print(f"Deleted (soft) notes:   {len(notes)}")
    print(f"Customers affected:     {len(customers)}")
    if skipped:
        print(f"Skipped (unexpected customer id): {len(skipped)}")

    if not args.apply:
        print("\nDry-run: nothing queued. Re-run with --apply to queue the deletions.")
        return

    jobs = db.Table(PURGE_JOBS_TABLE)
    now = iso_now()
    queued = sum(
        queue(jobs, "CONVERSATION", c["customerId"], c["conversationId"], c.get("parentConversationId"), now)
        for c in conversations
    ) + sum(queue(jobs, "NOTE", n["customerId"], n["noteKey"], None, now) for n in notes)
    print(f"\nQueued {queued} deletion job(s); {len(conversations) + len(notes) - queued} were already queued.")
    print("The proxy server's deletion sweep processes 25 a minute.")


if __name__ == "__main__":
    main()
