#!/usr/bin/env python3
"""
Migrate legacy per-customer Milvus collections into the shared per-type ones.

Legacy layout: one collection per customer x type x model
('{customerId}_{type}_{model}') — customers x 5 types collections, which
exceeds Zilliz's per-DB collection quota. Shared layout: one collection per
type x model ('{type}_{model}') with tenancy in each row's customer_id
partition-key field.

For every legacy collection this script:
  1. reads ALL rows (vectors included) and writes them to a backup JSON file
     ({backup_dir}/{collection}.json) BEFORE touching anything,
  2. creates the shared target (schema from the type's processor, so it always
     matches what the services create),
  3. re-inserts the rows stamped with customer_id (email row ids get the
     'customerId:' prefix the new write path uses),
  4. verifies the target's customer-scoped row count equals the source count,
  5. with --drop, drops the verified source collection.

Collections whose name doesn't parse as '{CU...}_{type}_{model}' are reported
and left untouched.

Order strategies:
  default      create target -> copy -> verify (-> drop). Needs quota headroom
               for the new collections while the legacy ones still exist.
  --drop-first backup EVERYTHING, drop ALL legacy collections, then create
               targets and re-insert from the backups. For clusters already AT
               their collection quota (no headroom to create anything). Data
               exists only in the backup files between the drop and the
               re-insert — keep them safe.

Usage:
    python scripts/migrate_to_shared_collections.py \
        --env-file ../genai-proxy-server/.env \
        --backup-dir /tmp/zilliz-migration-backups \
        [--dry-run] [--drop] [--drop-first] [--force]

Credentials come from --env-file (reads ZILLIZ_ENDPOINT / ZILLIZ_TOKEN) or
from those environment variables directly. The token is never printed.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

# Run from the encoding-server directory; the library ships the processors the
# target schemas come from. Prefer a sibling source checkout when present so
# the script always matches the code being deployed.
_LIB_SRC = Path(__file__).resolve().parents[2] / "encoding-library" / "src"
if _LIB_SRC.is_dir():
    sys.path.insert(0, str(_LIB_SRC))

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState  # noqa: E402
from encoding_library.processors.processor_factory import ProcessorFactory  # noqa: E402
from encoding_library.utils.vector_db import customer_filter  # noqa: E402

LEGACY_NAME = re.compile(
    r"^(?P<cid>CU[0-9A-Fa-f]+)_(?P<type>email|notes|memory|conversation|instructions)_(?P<model>.+)$"
)

# type token in collection names -> MemoryRequestInternalState.data_type
DATA_TYPE_BY_TOKEN = {
    "email": "Email",
    "notes": "NOTE",
    "memory": "MEMORY",
    "conversation": "CONVERSATION",
    "instructions": "INSTRUCTION",
}

INSERT_BATCH = 250


def load_env_file(path: str) -> None:
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_client(endpoint: str, token: str):
    from pymilvus import MilvusClient

    endpoint = endpoint.rstrip("/")
    if endpoint.startswith("https://") and endpoint.count(":") == 1:
        endpoint = f"{endpoint}:443"
    return MilvusClient(uri=endpoint, token=token, timeout=30.0)


def read_all_rows(client, collection: str) -> list[dict]:
    """Every row of a collection, vectors included."""
    client.load_collection(collection)
    rows: list[dict] = []
    try:
        iterator = client.query_iterator(
            collection_name=collection, batch_size=1000, output_fields=["*"]
        )
        while True:
            batch = iterator.next()
            if not batch:
                iterator.close()
                break
            rows.extend(batch)
    except AttributeError:
        # Older pymilvus without query_iterator: offset pagination (Zilliz caps
        # offset+limit at 16384 — fine at legacy per-customer sizes).
        offset = 0
        while True:
            batch = client.query(
                collection_name=collection, filter='id != ""',
                output_fields=["*"], offset=offset, limit=1000,
            )
            if not batch:
                break
            rows.extend(batch)
            offset += len(batch)
    return [_plain(row) for row in rows]


def _plain(row: dict) -> dict:
    """JSON-serializable copy (vectors can come back as numpy arrays)."""
    out = {}
    for key, value in row.items():
        if hasattr(value, "tolist"):
            value = value.tolist()
        elif isinstance(value, list) and value and hasattr(value[0], "item"):
            value = [float(x) for x in value]
        out[key] = value
    return out


def transform_rows(rows: list[dict], customer_id: str, type_token: str) -> list[dict]:
    transformed = []
    for row in rows:
        row = dict(row)
        row["customer_id"] = customer_id
        if type_token == "email" and not str(row.get("id", "")).startswith(f"{customer_id}:"):
            # Message-IDs are externally sourced; the shared collection
            # customer-prefixes them (see EmailProcessor.prepare_for_vector_db).
            row["id"] = f"{customer_id}:{row['id']}"[:256]
        transformed.append(row)
    return transformed


def ensure_target(client, name: str, type_token: str, dim: int, description: str) -> bool:
    if client.has_collection(name):
        return False
    state = MemoryRequestInternalState(
        data_type=DATA_TYPE_BY_TOKEN[type_token],
        customer_id="migration",
        client="migration",
        raw_data={},
        model_type=None,
        model_name=None,
    )
    processor = ProcessorFactory.get_processor(state)
    schema, index_params = processor.get_collection_schema(dim=dim, description=description or "")
    client.create_collection(collection_name=name, schema=schema, index_params=index_params)
    return True


def count_for_customer(client, collection: str, customer_id: str) -> int:
    result = client.query(
        collection_name=collection,
        filter=customer_filter(customer_id),
        output_fields=["count(*)"],
    )
    return int(result[0]["count(*)"]) if result else 0


def insert_rows(client, collection: str, rows: list[dict]) -> None:
    for start in range(0, len(rows), INSERT_BATCH):
        client.insert(collection_name=collection, data=rows[start:start + INSERT_BATCH])
    client.flush(collection_name=collection)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env-file", help="dotenv file holding ZILLIZ_ENDPOINT / ZILLIZ_TOKEN")
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--dry-run", action="store_true", help="plan only; touch nothing")
    parser.add_argument("--drop", action="store_true", help="drop each source after its rows verify")
    parser.add_argument("--drop-first", action="store_true",
                        help="backup all, drop all legacy, then create+insert (for clusters at quota)")
    parser.add_argument("--force", action="store_true",
                        help="re-migrate customers that already have rows in the target (their target rows are deleted first)")
    args = parser.parse_args()

    if args.env_file:
        load_env_file(args.env_file)
    endpoint, token = os.environ.get("ZILLIZ_ENDPOINT"), os.environ.get("ZILLIZ_TOKEN")
    if not endpoint or not token:
        sys.exit("ZILLIZ_ENDPOINT / ZILLIZ_TOKEN not set (use --env-file or env vars)")

    backup_dir = Path(args.backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)

    client = get_client(endpoint, token)
    names = client.list_collections()

    legacy, unmatched, shared = [], [], []
    for name in sorted(names):
        match = LEGACY_NAME.match(name)
        if match:
            legacy.append((name, match["cid"], match["type"], match["model"]))
        elif name.split("_", 1)[0] in DATA_TYPE_BY_TOKEN:
            shared.append(name)
        else:
            unmatched.append(name)

    print(f"Cluster has {len(names)} collection(s): {len(legacy)} legacy per-customer, "
          f"{len(shared)} already shared, {len(unmatched)} unmatched")
    for name in unmatched:
        print(f"  UNMATCHED (left untouched): {name}")
    if not legacy:
        print("Nothing to migrate.")
        return

    # 1) Backup + plan
    plan = []  # (source, cid, type_token, target, rows)
    for name, cid, type_token, model in legacy:
        description = ""
        try:
            description = client.describe_collection(name).get("description") or ""
        except Exception as e:
            print(f"  warn: describe({name}) failed: {e}")
        rows = read_all_rows(client, name)
        backup_path = backup_dir / f"{name}.json"
        backup_path.write_text(json.dumps({"collection": name, "description": description, "rows": rows}))
        target = f"{type_token}_{model}"
        plan.append((name, cid, type_token, target, rows, description))
        print(f"  {name}: {len(rows)} row(s) -> {target}  (backed up to {backup_path})")

    if args.dry_run:
        print("\nDRY RUN — no collections created, modified or dropped.")
        return

    # 2) --drop-first: free quota before creating targets
    if args.drop_first:
        print("\nDropping ALL legacy collections first (data now lives in the backups)…")
        for name, *_ in plan:
            client.drop_collection(name)
            print(f"  dropped {name}")

    def drop_source(name: str) -> None:
        if args.drop and not args.drop_first:
            client.drop_collection(name)
            print(f"  dropped {name}")

    # 3) Create targets + copy + verify
    failures = []
    for name, cid, type_token, target, rows, description in plan:
        if not rows:
            print(f"  {name}: empty, nothing to copy")
            drop_source(name)
            continue
        dim = len(rows[0]["vector"])
        if ensure_target(client, target, type_token, dim, description):
            print(f"  created shared collection {target} (dim={dim})")

        existing = count_for_customer(client, target, cid)
        if existing:
            if existing == len(rows) and not args.force:
                print(f"  {name}: {existing} row(s) already in {target} for {cid} — skipping copy")
                drop_source(name)
                continue
            if not args.force:
                failures.append((name, f"{target} already holds {existing} row(s) for {cid} (!= {len(rows)}); rerun with --force"))
                continue
            client.delete(collection_name=target, filter=customer_filter(cid))
            client.flush(collection_name=target)
            print(f"  {name}: --force — cleared {existing} pre-existing row(s) in {target} for {cid}")

        insert_rows(client, target, transform_rows(rows, cid, type_token))
        copied = count_for_customer(client, target, cid)
        if copied != len(rows):
            failures.append((name, f"verify failed: {copied} row(s) in {target} for {cid}, expected {len(rows)}"))
            continue
        print(f"  {name}: {copied}/{len(rows)} row(s) verified in {target}")
        drop_source(name)

    print()
    if failures:
        for name, why in failures:
            print(f"FAILED {name}: {why}")
        sys.exit(1)
    remaining = client.list_collections()
    print(f"Migration complete. Cluster now has {len(remaining)} collection(s): {sorted(remaining)}")


if __name__ == "__main__":
    main()
