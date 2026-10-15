"""Find (and optionally delete) phantom Conversation rows.

Before the pending-run writes required an existing row, removing a share
recipient's durable run issued an unconditional UpdateItem keyed by the
recipient, which DynamoDB answers by creating a row that holds only the key
(customerId = recipient, conversationId) and nothing else. Such a row sits
next to the owner's row in conversationIdIndex. The proxy now skips rows
without a `client` (ConversationRepository.getConversationById and the
pending-run condition), so they are harmless, but they are not real
conversations and are best removed.

A row counts as a phantom only when it has no `client` AND no attribute other
than customerId, conversationId and pendingRuns. Read-only by default:

    AWS_PROFILE=... python scripts/find_phantom_conversation_rows.py --region us-east-1

With --delete each phantom is removed under the condition that it still has
no `client`, so a real row is never deleted. Prints a JSON report.
"""
import argparse
import json
import sys

PHANTOM_ATTRIBUTES = {"customerId", "conversationId", "pendingRuns"}


def is_phantom(item: dict) -> bool:
    """A key-only row (optionally with a pendingRuns set), never a real one."""
    return "client" not in item and set(item) <= PHANTOM_ATTRIBUTES


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--region", required=True)
    parser.add_argument("--table", default="Conversation")
    parser.add_argument("--delete", action="store_true", help="delete the phantom rows found")
    args = parser.parse_args()

    import boto3
    from boto3.dynamodb.conditions import Attr

    table = boto3.resource("dynamodb", region_name=args.region).Table(args.table)
    scan = {"FilterExpression": Attr("client").not_exists()}
    phantoms, deleted = [], 0
    while True:
        page = table.scan(**scan)
        for item in page.get("Items", []):
            if not is_phantom(item):
                continue
            key = {"customerId": item["customerId"], "conversationId": item["conversationId"]}
            phantoms.append(key)
            if args.delete:
                try:
                    table.delete_item(Key=key, ConditionExpression=Attr("client").not_exists())
                    deleted += 1
                except table.meta.client.exceptions.ConditionalCheckFailedException:
                    pass  # it became a real row since the scan: keep it
        if "LastEvaluatedKey" not in page:
            break
        scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    print(json.dumps({"table": args.table, "phantoms": phantoms, "deleted": deleted}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
