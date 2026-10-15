"""One-off, read-only scan for customer tools whose names collide with new
built-in tools (plan 3.2).

Built-ins resolve before customer tools (graph/tools_runtime.tools_for), so
a stored customer tool named revise_pdf, read_pdf_source or read_attachment
would silently stop being callable once those built-ins ship. Run this
against each stage BEFORE deploying them; any conflict must be renamed with
the customer first.

    AWS_PROFILE=... python scripts/scan_reserved_tool_names.py --region us-east-1

Reads only customerId, name, provider, status and discoveredTools (records
carry no secrets; credentials live in another table). Prints a JSON report;
exits 1 when a conflict is found, 0 otherwise.
"""
import argparse
import json
import os
import sys

RESERVED = ("revise_pdf", "read_pdf_source", "read_attachment")


def tool_names(record: dict) -> list[str]:
    """The model-facing names a stored record exposes."""
    name = (record.get("name") or "").strip()
    if (record.get("provider") or "http") != "mcp":
        return [name] if name else []
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from graph_tools.providers.mcp_tool import _tool_name

    discovered = record.get("discoveredTools") or []
    if isinstance(discovered, str):
        try:
            discovered = json.loads(discovered)
        except ValueError:
            discovered = []
    names = []
    for entry in discovered if isinstance(discovered, list) else []:
        remote = (entry.get("name") or "").strip() if isinstance(entry, dict) else ""
        if remote:
            names.append(_tool_name(name, remote))
    return names


def scan(table, reserved: set[str]) -> dict:
    report = {"scanned": 0, "conflicts": []}
    kwargs = {
        "ProjectionExpression": "customerId, #n, #p, #s, discoveredTools",
        "ExpressionAttributeNames": {"#n": "name", "#p": "provider", "#s": "status"},
    }
    while True:
        page = table.scan(**kwargs)
        for record in page.get("Items", []):
            report["scanned"] += 1
            for tool in tool_names(record):
                if tool in reserved:
                    report["conflicts"].append({
                        "customerId": record.get("customerId"),
                        "recordName": record.get("name"),
                        "toolName": tool,
                        "status": record.get("status"),
                    })
        if "LastEvaluatedKey" not in page:
            return report
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--table", default=os.environ.get("CUSTOMER_TOOLS_TABLE", "CustomerTools"))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument("--names", nargs="*", default=list(RESERVED),
                        help="names to check (default: the plan 3.2 built-ins)")
    args = parser.parse_args(argv)

    import boto3

    table = boto3.resource("dynamodb", region_name=args.region).Table(args.table)
    report = scan(table, set(args.names))
    report["table"] = args.table
    print(json.dumps(report, indent=2, default=str))
    return 1 if report["conflicts"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
