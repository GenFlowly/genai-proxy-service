#!/usr/bin/env python3
"""
One-time migration + cleanup for the agents de-duplication / Title Creator merge.

Run AFTER deploying the proxy-server build that ships the race-safe
RequestAgentSeeder, agent categories, and the {{content}} title variable
superset (the old published title templates keep rendering until step 1 of
this script swaps them; the new code keeps rendering after).

What it does (in order, each step previews before writing):

  1. TITLE MERGE — keeps the graph currently mapped to CONVERSATION_TITLE,
     renames it TitleCreatorDefaultAgent (category TITLE_CREATOR), switches its
     entry node's input_template to {{content}}, publishes a new version of its
     instruction with the merged title prompt, repoints the NOTE_TITLE SYSTEM
     map row at it (preserving enabled), sets both rows' mapKey to
     TitleCreatorDefault, and deletes the old note-title graph + nodes.
  2. ORPHAN SWEEP — deletes System-owned live graphs referenced by NO
     RequestAgentMap row (any scope), not isDefault, AND named like a seeded
     request agent (*DefaultAgent): the duplicate
     MemoryExtractionDefaultAgent/... copies left behind by the old seeder's
     lost races. Their now-unreferenced System instructions are removed too.
     Unmapped System graphs with other names (deliberately published shared
     templates, e.g. AgentLegacy) are listed but never deleted.
  3. "-personal" DUPLICATES — lists customer-owned live graphs whose name ends
     in "-personal" (stale pre-fork-flow copies); deletes them (and any map
     rows pointing at them) only with --delete-personal.
  4. DANGLING CUSTOMER MAP ROWS — deletes customer-scope RequestAgentMap rows
     whose graph is gone (resolution already falls back to SYSTEM). SYSTEM
     rows with dead graphs are never auto-deleted — reported loudly instead.
  5. CATEGORY BACKFILL — every live graph without a category attribute gets
     one: map-referenced graphs derive it from their request type
     (TITLE_CREATOR / MEMORY / INSTRUCTIONS), everything else CONVERSATION.
     Conditional write — a concurrent API write wins.

Seeder interplay: the SYSTEM rows for BOTH title types survive (repointed),
and the seeder never touches existing rows, so nothing gets re-seeded after
this runs. Only if an admin later DELETES a SYSTEM row does the seeder publish
a fresh TitleCreatorDefault graph (at its deterministic id) for that type.

Usage:
  python merge_title_agents_and_cleanup.py                       # dry-run against dev
  python merge_title_agents_and_cleanup.py --apply               # write to dev
  python merge_title_agents_and_cleanup.py --profile production  # dry-run against prod
  python merge_title_agents_and_cleanup.py --profile production --apply
  flags: --hard             hard-delete graph/node rows incl. history (default: soft-delete v=0)
         --delete-personal  also delete the "-personal" graphs listed by step 3

The script is idempotent — every step keys off current state and re-running
after a partial failure just finishes the remainder.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr, Key

SYSTEM_OWNER = "System"
SYSTEM_SCOPE = "SYSTEM"
GRAPHS_TABLE = "CustomerGraphs"
NODES_TABLE = "CustomerGraphNodes"
MAP_TABLE = "RequestAgentMap"
INSTRUCTIONS_TABLE = "Instructions"
GRAPHS_GSI = "customerIdIndex"

MERGED_AGENT_NAME = "TitleCreatorDefaultAgent"
MERGED_MAP_KEY = "TitleCreatorDefault"
MERGED_INSTRUCTION_NAME = "TitleCreatorDefault Prompt"
MERGED_INPUT_TEMPLATE = "{{content}}"
# Must match genai-proxy-server/src/main/resources/config/prompts/title-creator.system.txt
MERGED_SYSTEM_PROMPT = (
    "Create a short descriptive title (at most 8 words) for the content the user sends — "
    "the opening of a conversation (possibly naming its assistant persona) or a note. "
    "Respond with the title only - no quotes, no trailing punctuation, no extra text."
)

CATEGORY_BY_REQUEST_TYPE = {
    "CONVERSATION_TITLE": "TITLE_CREATOR",
    "NOTE_TITLE": "TITLE_CREATOR",
    "MEMORY_EXTRACTION": "MEMORY",
    "INSTRUCTION_PERSONA": "INSTRUCTIONS",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def scan_all(table, **kwargs):
    items = []
    while True:
        response = table.scan(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    return items


def query_all(table, **kwargs):
    items = []
    while True:
        response = table.query(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    return items


class Env:
    def __init__(self, args):
        session = boto3.Session(profile_name=args.profile) if args.profile else boto3.Session()
        region = os.getenv("AWS_REGION", "us-east-1")
        db = session.resource("dynamodb", region_name=region)
        self.graphs = db.Table(GRAPHS_TABLE)
        self.nodes = db.Table(NODES_TABLE)
        self.map = db.Table(MAP_TABLE)
        self.instructions = db.Table(INSTRUCTIONS_TABLE)
        self.apply = args.apply
        self.hard = args.hard
        self.now = iso_now()

    # ── Shared lookups ─────────────────────────────────────────────────────

    def map_rows(self):
        return scan_all(self.map)

    def live_graph(self, graph_id):
        item = self.graphs.get_item(Key={"graphId": graph_id, "version": 0}).get("Item")
        return item if item and "deletedAt" not in item else None

    def live_node(self, node_id):
        item = self.nodes.get_item(Key={"nodeId": node_id, "version": 0}).get("Item")
        return item if item and "deletedAt" not in item else None

    def live_system_graphs(self):
        return query_all(
            self.graphs,
            IndexName=GRAPHS_GSI,
            KeyConditionExpression=Key("customerId").eq(SYSTEM_OWNER),
            FilterExpression=Attr("deletedAt").not_exists(),
        )

    def all_live_graphs(self):
        return scan_all(
            self.graphs,
            FilterExpression=(
                Attr("version").eq(0) & Attr("deletedAt").not_exists() & Attr("customerId").exists()
            ),
        )

    # ── Write helpers (all gated on --apply) ───────────────────────────────

    def versioned_update(self, table, pk_name, pk_value, changes: dict, label: str):
        """v0 update + immutable history snapshot, mirroring GraphRepository."""
        print(f"    UPDATE {label}: {', '.join(changes)}")
        if not self.apply:
            return
        v0 = table.get_item(Key={pk_name: pk_value, "version": 0}).get("Item")
        if not v0:
            print(f"    !! {label}: live row vanished, skipping")
            return
        next_version = int(v0.get("latestVersion", 1)) + 1
        history = {k: v for k, v in v0.items() if k not in ("customerId", "latestVersion", "updatedAt")}
        history.update(changes)
        history["version"] = next_version
        history["createdAt"] = self.now
        table.put_item(Item=history)
        new_v0 = dict(v0)
        new_v0.update(changes)
        new_v0["latestVersion"] = next_version
        new_v0["updatedAt"] = self.now
        table.put_item(Item=new_v0)

    def delete_graph(self, graph_item, reason: str):
        graph_id = graph_item["graphId"]
        node_ids = list(graph_item.get("nodeIds", []))
        mode = "HARD-delete" if self.hard else "soft-delete"
        print(f"    {mode} graph {graph_id} ({graph_item.get('name', '')!r}, {len(node_ids)} node(s)) — {reason}")
        if not self.apply:
            return
        if self.hard:
            for nid in node_ids:
                for item in query_all(self.nodes, KeyConditionExpression=Key("nodeId").eq(nid)):
                    self.nodes.delete_item(Key={"nodeId": nid, "version": item["version"]})
            for item in query_all(self.graphs, KeyConditionExpression=Key("graphId").eq(graph_id)):
                self.graphs.delete_item(Key={"graphId": graph_id, "version": item["version"]})
        else:
            for nid in node_ids:
                self.nodes.update_item(
                    Key={"nodeId": nid, "version": 0},
                    UpdateExpression="SET deletedAt = :now",
                    ExpressionAttributeValues={":now": self.now},
                )
            self.graphs.update_item(
                Key={"graphId": graph_id, "version": 0},
                UpdateExpression="SET deletedAt = :now",
                ExpressionAttributeValues={":now": self.now},
            )

    def delete_instruction(self, instruction_id: str, reason: str):
        """Instructions have no soft-delete convention — all versions go (cf. InstructionRepository.deleteInstruction)."""
        print(f"    delete instruction {instruction_id} — {reason}")
        if not self.apply:
            return
        for item in query_all(self.instructions, KeyConditionExpression=Key("instructionId").eq(instruction_id)):
            self.instructions.delete_item(Key={"instructionId": instruction_id, "version": item["version"]})

    # ── Node-config helpers ────────────────────────────────────────────────

    def instruction_ids_of(self, graph_item):
        ids = set()
        for nid in graph_item.get("nodeIds", []):
            node = self.live_node(nid)
            if not node:
                continue
            try:
                config = json.loads(node.get("config", "{}"))
            except ValueError:
                continue
            if config.get("instruction_id"):
                ids.add(config["instruction_id"])
        return ids


# ─── Step 1: title merge ──────────────────────────────────────────────────────


def step1_title_merge(env: Env):
    print("\n── Step 1: merge the title agents into TitleCreatorDefaultAgent ──")
    ct = env.map.get_item(Key={"scope": SYSTEM_SCOPE, "requestType": "CONVERSATION_TITLE"}).get("Item")
    nt = env.map.get_item(Key={"scope": SYSTEM_SCOPE, "requestType": "NOTE_TITLE"}).get("Item")
    if not ct:
        print("  !! No SYSTEM/CONVERSATION_TITLE map row — nothing to merge. "
              "(Fresh env? The fixed seeder creates the merged agent on boot.)")
        return None

    keep_id = ct["graphId"]
    keep = env.live_graph(keep_id)
    if not keep:
        print(f"  !! CONVERSATION_TITLE points at missing graph {keep_id} — fix the mapping first. Aborting step 1.")
        return None
    print(f"  keeping graph {keep_id} ({keep.get('name', '')!r})")

    # 1a. Rename + categorize the kept graph.
    graph_changes = {}
    if keep.get("name") != MERGED_AGENT_NAME:
        graph_changes["name"] = MERGED_AGENT_NAME
    if keep.get("category") != "TITLE_CREATOR":
        graph_changes["category"] = "TITLE_CREATOR"
    if graph_changes:
        env.versioned_update(env.graphs, "graphId", keep_id, graph_changes, f"graph {keep_id}")
    else:
        print(f"    graph {keep_id} already merged (name+category) — skipping")

    # 1b. Entry node input_template → {{content}}.
    entry_node_id = keep.get("entryPoint")
    entry_node = env.live_node(entry_node_id) if entry_node_id else None
    instruction_id = None
    if entry_node:
        try:
            config = json.loads(entry_node.get("config", "{}"))
        except ValueError:
            config = {}
        instruction_id = config.get("instruction_id")
        if config.get("input_template") != MERGED_INPUT_TEMPLATE:
            config["input_template"] = MERGED_INPUT_TEMPLATE
            env.versioned_update(
                env.nodes, "nodeId", entry_node_id,
                {"config": json.dumps(config)}, f"node {entry_node_id} (input_template)",
            )
        else:
            print(f"    node {entry_node_id} already uses {MERGED_INPUT_TEMPLATE} — skipping")
    else:
        print(f"  !! entry node {entry_node_id!r} of {keep_id} not found — input_template NOT migrated")

    # 1c. New instruction version with the merged prompt.
    if instruction_id:
        versions = query_all(
            env.instructions,
            KeyConditionExpression=Key("instructionId").eq(instruction_id),
            ScanIndexForward=False, Limit=1,
        )
        latest = versions[0] if versions else None
        if latest and latest.get("instructions") == MERGED_SYSTEM_PROMPT:
            print(f"    instruction {instruction_id} already carries the merged prompt — skipping")
        elif latest:
            print(f"    NEW VERSION of instruction {instruction_id} (merged title prompt)")
            if env.apply:
                item = dict(latest)
                item["version"] = int(latest["version"]) + 1
                item["name"] = MERGED_INSTRUCTION_NAME
                item["instructions"] = MERGED_SYSTEM_PROMPT
                env.instructions.put_item(Item=item)
        else:
            print(f"  !! instruction {instruction_id} has no versions — prompt NOT migrated")

    # 1d. Map rows: mapKey + NOTE_TITLE repoint (enabled preserved).
    if ct.get("mapKey") != MERGED_MAP_KEY:
        print(f"    CONVERSATION_TITLE mapKey → {MERGED_MAP_KEY}")
        if env.apply:
            env.map.update_item(
                Key={"scope": SYSTEM_SCOPE, "requestType": "CONVERSATION_TITLE"},
                UpdateExpression="SET mapKey = :mk, updatedAt = :now, updatedBy = :by",
                ExpressionAttributeValues={":mk": MERGED_MAP_KEY, ":now": env.now, ":by": "merge-script"},
            )
    old_note_graph_id = nt.get("graphId") if nt else None
    if not nt:
        print(f"    NOTE_TITLE row missing — creating it → {keep_id}")
        if env.apply:
            env.map.put_item(Item={
                "scope": SYSTEM_SCOPE, "requestType": "NOTE_TITLE", "mapKey": MERGED_MAP_KEY,
                "graphId": keep_id, "enabled": True, "updatedBy": "merge-script",
                "createdAt": env.now, "updatedAt": env.now,
            })
    elif nt.get("graphId") != keep_id or nt.get("mapKey") != MERGED_MAP_KEY:
        print(f"    NOTE_TITLE → {keep_id} (was {nt.get('graphId')}, enabled={nt.get('enabled', True)} preserved)")
        if env.apply:
            env.map.update_item(
                Key={"scope": SYSTEM_SCOPE, "requestType": "NOTE_TITLE"},
                UpdateExpression="SET graphId = :gid, mapKey = :mk, updatedAt = :now, updatedBy = :by",
                ExpressionAttributeValues={
                    ":gid": keep_id, ":mk": MERGED_MAP_KEY, ":now": env.now, ":by": "merge-script",
                },
            )
    else:
        print("    NOTE_TITLE already repointed — skipping")

    # 1e. Old note-title graph is now unreferenced — delete it (+ instruction in step 2's sweep).
    if old_note_graph_id and old_note_graph_id != keep_id:
        old = env.live_graph(old_note_graph_id)
        if old and old.get("customerId") == SYSTEM_OWNER:
            env.delete_graph(old, "superseded by the merged Title Creator agent")
        elif old:
            print(f"    old NOTE_TITLE graph {old_note_graph_id} is customer-owned — leaving it alone")
    return keep_id


# ─── Step 2: orphan sweep ─────────────────────────────────────────────────────


def step2_orphan_sweep(env: Env, keep_id):
    print("\n── Step 2: sweep orphaned System graphs (old seeder race losers) ──")
    referenced = {row["graphId"] for row in env.map_rows()}
    system_graphs = env.live_system_graphs()
    orphans, kept = [], []
    for g in system_graphs:
        unmapped = (
            g["graphId"] not in referenced
            and not g.get("isDefault")
            and g["graphId"] != keep_id
        )
        # Only seeder-published names are safe to sweep: unmapped System graphs
        # with other names are deliberately published shared templates.
        if unmapped and not str(g.get("name", "")).endswith("DefaultAgent"):
            print(f"  keeping unmapped System graph {g['graphId']} ({g.get('name', '')!r}) — "
                  "not a seeded name; delete manually if unwanted")
            unmapped = False
        (orphans if unmapped else kept).append(g)

    if not orphans:
        print("  no orphaned System graphs found")
        return

    kept_instruction_ids = set()
    for g in kept:
        kept_instruction_ids |= env.instruction_ids_of(g)

    print(f"  {len(orphans)} orphaned System graph(s):")
    orphan_instruction_ids = set()
    for g in sorted(orphans, key=lambda x: x.get("createdAt", "")):
        orphan_instruction_ids |= env.instruction_ids_of(g)
        env.delete_graph(g, "not referenced by any RequestAgentMap row")

    for iid in sorted(orphan_instruction_ids - kept_instruction_ids):
        creator = None
        versions = query_all(env.instructions, KeyConditionExpression=Key("instructionId").eq(iid), Limit=1)
        if versions:
            creator = versions[0].get("creator")
        if creator == SYSTEM_OWNER:
            env.delete_instruction(iid, "only referenced by deleted orphan graphs")
        else:
            print(f"    instruction {iid} (creator={creator!r}) not System-owned — leaving it alone")


# ─── Step 3: "-personal" duplicates ───────────────────────────────────────────


def step3_personal_duplicates(env: Env, delete_personal: bool):
    print("\n── Step 3: stale '-personal' customer copies ──")
    candidates = [
        g for g in scan_all(
            env.graphs,
            FilterExpression=(
                Attr("version").eq(0)
                & Attr("deletedAt").not_exists()
                & Attr("customerId").exists()
                & Attr("customerId").ne(SYSTEM_OWNER)
                & Attr("name").contains("-personal")
            ),
        )
        if str(g.get("name", "")).endswith("-personal")
    ]
    if not candidates:
        print("  none found")
        return
    print(f"  {len(candidates)} '-personal' graph(s):")
    all_map_rows = env.map_rows()
    for g in candidates:
        print(f"    customer={g.get('customerId')}  graph={g['graphId']}  name={g.get('name', '')!r}")
        if not delete_personal:
            continue
        env.delete_graph(g, "stale '-personal' duplicate (--delete-personal)")
        for row in all_map_rows:
            if row["graphId"] == g["graphId"] and row["scope"] != SYSTEM_SCOPE:
                print(f"      delete map row {row['scope']}/{row['requestType']} → {g['graphId']}")
                if env.apply:
                    env.map.delete_item(Key={"scope": row["scope"], "requestType": row["requestType"]})
    if not delete_personal:
        print("  (listing only — re-run with --delete-personal to delete)")


# ─── Step 4: dangling customer-scope map rows ─────────────────────────────────


def step4_dangling_map_rows(env: Env):
    print("\n── Step 4: dangling customer-scope map rows ──")
    dangling = 0
    for row in env.map_rows():
        if env.live_graph(row["graphId"]):
            continue
        if row["scope"] == SYSTEM_SCOPE:
            print(f"  !! SYSTEM/{row['requestType']} points at dead graph {row['graphId']} — "
                  "NOT auto-deleted; remap it in the admin panel")
            continue
        dangling += 1
        print(f"    delete {row['scope']}/{row['requestType']} → dead graph {row['graphId']}")
        if env.apply:
            env.map.delete_item(Key={"scope": row["scope"], "requestType": row["requestType"]})
    if not dangling:
        print("  no dangling customer rows")


# ─── Step 5: category backfill ────────────────────────────────────────────────


def step5_category_backfill(env: Env):
    print("\n── Step 5: category backfill ──")
    category_by_graph = {}
    for row in env.map_rows():
        category = CATEGORY_BY_REQUEST_TYPE.get(row["requestType"])
        if category:
            category_by_graph[row["graphId"]] = category

    counts = {}
    for g in env.all_live_graphs():
        if g.get("category"):
            continue
        category = category_by_graph.get(g["graphId"], "CONVERSATION")
        counts[category] = counts.get(category, 0) + 1
        print(f"    {g['graphId']} ({g.get('name', '')!r}) → {category}")
        if env.apply:
            try:
                env.graphs.update_item(
                    Key={"graphId": g["graphId"], "version": 0},
                    UpdateExpression="SET category = :c",
                    ConditionExpression="attribute_not_exists(category)",
                    ExpressionAttributeValues={":c": category},
                )
            except env.graphs.meta.client.exceptions.ConditionalCheckFailedException:
                print("      (already categorized by a concurrent write — kept)")
    if counts:
        print("  backfilled: " + ", ".join(f"{v}× {k}" for k, v in sorted(counts.items())))
    else:
        print("  every live graph already has a category")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually write (default: dry-run)")
    parser.add_argument("--hard", action="store_true",
                        help="hard-delete graph/node rows incl. history (default: soft-delete v=0)")
    parser.add_argument("--profile", help="AWS profile (default profile = dev, 'production' = prod)")
    parser.add_argument("--delete-personal", action="store_true",
                        help="delete the '-personal' graphs listed by step 3")
    args = parser.parse_args()

    env = Env(args)
    print(f"Target: profile={args.profile or 'default (dev)'}  mode={'APPLY' if args.apply else 'DRY-RUN'}"
          + ("  (hard deletes)" if args.hard else ""))

    keep_id = step1_title_merge(env)
    step2_orphan_sweep(env, keep_id)
    step3_personal_duplicates(env, args.delete_personal)
    step4_dangling_map_rows(env)
    step5_category_backfill(env)

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to write.")


if __name__ == "__main__":
    sys.exit(main())
