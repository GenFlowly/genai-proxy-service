#!/usr/bin/env python3
"""
One-time cleanup: delete the legacy per-customer seeded default graphs.

Before the System-published default graph existed, onboarding seeded every
customer a private copy of the default RAG graph. Those copies shadow the
System graph fallback, so they must be removed for "admin updates reach all
customers" to hold. After this runs, any customer-owned default graph is by
definition an intentional fork (created via fork-on-edit).

DO NOT RUN until:
  1. the proxy-server + retrieval-server System-graph fallback is deployed, and
  2. the admin panel has published the System default graph, and
  3. a customer without an own graph verifiably resolves to it.

Usage:
  python delete_legacy_default_graphs.py            # dry-run (default): print what would be deleted
  python delete_legacy_default_graphs.py --apply    # actually delete
  python delete_legacy_default_graphs.py --hard     # with --apply: hard-delete rows (incl. history)
                                                    # (default is soft-delete: set deletedAt on v=0)

Deletes, for every customer EXCEPT the "System" owner:
  - every CustomerGraphs row where isDefault=true (v=0 soft-deleted; --hard removes all versions)
  - every CustomerGraphNodes row referenced by those graphs' nodeIds (same rules)
Non-default customer-created agents are untouched.
"""

import argparse
import os
import sys
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr

SYSTEM_GRAPH_OWNER = "System"
GRAPHS_TABLE = "CustomerGraphs"
NODES_TABLE = "CustomerGraphNodes"


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def scan_legacy_default_graphs(db):
    """All live (v=0) non-System default graphs, via table scan (one-time script)."""
    table = db.Table(GRAPHS_TABLE)
    graphs = []
    kwargs = {
        "FilterExpression": (
            Attr("version").eq(0)
            & Attr("isDefault").eq(True)
            & Attr("deletedAt").not_exists()
            & Attr("customerId").exists()
            & Attr("customerId").ne(SYSTEM_GRAPH_OWNER)
        )
    }
    while True:
        response = table.scan(**kwargs)
        graphs.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    return graphs


def all_versions(table, key_name: str, key_value: str):
    from boto3.dynamodb.conditions import Key
    response = table.query(KeyConditionExpression=Key(key_name).eq(key_value))
    return response.get("Items", [])


def soft_delete(table, key: dict, now: str):
    table.update_item(
        Key=key,
        UpdateExpression="SET deletedAt = :now",
        ExpressionAttributeValues={":now": now},
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually delete (default: dry-run)")
    parser.add_argument("--hard", action="store_true", help="hard-delete all versions instead of soft-deleting v=0")
    args = parser.parse_args()

    region = os.getenv("AWS_REGION", "us-east-1")
    db = boto3.resource("dynamodb", region_name=region)
    graphs_table = db.Table(GRAPHS_TABLE)
    nodes_table = db.Table(NODES_TABLE)

    graphs = scan_legacy_default_graphs(db)
    if not graphs:
        print("No legacy per-customer default graphs found. Nothing to do.")
        return

    mode = ("HARD DELETE" if args.hard else "soft-delete") if args.apply else "DRY-RUN"
    print(f"[{mode}] {len(graphs)} legacy default graph(s) found:\n")

    now = iso_now()
    total_nodes = 0
    for g in graphs:
        graph_id = g["graphId"]
        customer_id = g.get("customerId", "?")
        node_ids = list(g.get("nodeIds", []))
        total_nodes += len(node_ids)
        print(f"  customer={customer_id}  graph={graph_id}  name={g.get('name', '')!r}  nodes={len(node_ids)}")
        for nid in node_ids:
            print(f"      node={nid}")

        if not args.apply:
            continue

        if args.hard:
            for nid in node_ids:
                for item in all_versions(nodes_table, "nodeId", nid):
                    nodes_table.delete_item(Key={"nodeId": nid, "version": item["version"]})
            for item in all_versions(graphs_table, "graphId", graph_id):
                graphs_table.delete_item(Key={"graphId": graph_id, "version": item["version"]})
        else:
            for nid in node_ids:
                soft_delete(nodes_table, {"nodeId": nid, "version": 0}, now)
            soft_delete(graphs_table, {"graphId": graph_id, "version": 0}, now)
        print("      ...deleted")

    print(f"\nTotal: {len(graphs)} graph(s), {total_nodes} node(s) " + ("deleted." if args.apply else "would be deleted."))
    if not args.apply:
        print("Dry-run only. Re-run with --apply to delete.")


if __name__ == "__main__":
    sys.exit(main())
