#!/usr/bin/env python3
"""
One-time migration: move globally mapped request agents to the "System" owner.

Request agents created before the ownership alignment live under the mapping
admin's customerId. System-owned is now the contract (visible to every
customer read-only, fork-on-edit) and the admin PUT endpoint transfers
ownership automatically on the next re-save — this script does the same for
every EXISTING SYSTEM-scope mapping in one pass.

Usage:
  python transfer_request_agents_to_system.py            # dry-run (default)
  python transfer_request_agents_to_system.py --apply    # actually transfer
"""

import argparse
import os
import sys

import boto3
from boto3.dynamodb.conditions import Key

SYSTEM_GRAPH_OWNER = "System"
SYSTEM_SCOPE = "SYSTEM"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually transfer (default: dry-run)")
    args = parser.parse_args()

    db = boto3.resource("dynamodb", region_name=os.getenv("AWS_REGION", "us-east-1"))
    map_table = db.Table("RequestAgentMap")
    graphs_table = db.Table("CustomerGraphs")
    nodes_table = db.Table("CustomerGraphNodes")

    entries = map_table.query(KeyConditionExpression=Key("scope").eq(SYSTEM_SCOPE)).get("Items", [])
    if not entries:
        print("No SYSTEM-scope request-agent mappings found. Nothing to do.")
        return

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] {len(entries)} SYSTEM mapping(s):\n")

    for entry in entries:
        graph_id = entry["graphId"]
        graph = graphs_table.get_item(Key={"graphId": graph_id, "version": 0}).get("Item")
        if not graph:
            print(f"  {entry['requestType']}: graph {graph_id} NOT FOUND — skipping")
            continue
        owner = graph.get("customerId")
        node_ids = list(graph.get("nodeIds", []))
        if owner == SYSTEM_GRAPH_OWNER:
            print(f"  {entry['requestType']}: graph {graph_id} already System-owned — ok")
            continue

        print(f"  {entry['requestType']}: graph {graph_id} owner {owner} -> {SYSTEM_GRAPH_OWNER} ({len(node_ids)} node(s))")
        if not args.apply:
            continue
        for nid in node_ids:
            nodes_table.update_item(
                Key={"nodeId": nid, "version": 0},
                UpdateExpression="SET customerId = :o",
                ExpressionAttributeValues={":o": SYSTEM_GRAPH_OWNER},
            )
        graphs_table.update_item(
            Key={"graphId": graph_id, "version": 0},
            UpdateExpression="SET customerId = :o",
            ExpressionAttributeValues={":o": SYSTEM_GRAPH_OWNER},
        )
        print("      ...transferred")

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to transfer.")


if __name__ == "__main__":
    sys.exit(main())
