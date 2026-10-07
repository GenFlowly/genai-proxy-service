#!/usr/bin/env python
"""Harness eval runner — drives /retrieve and checks tasks.yaml assertions.

Usage:
    EVAL_BASE_URL=http://localhost:8000 \
    EVAL_CUSTOMER_ID=<test customer> \
    EVAL_GRAPH_ID=<agent-loop graph id> \
    EVAL_PROVIDER=openai EVAL_MODEL=gpt-5 \
    EVAL_CREDENTIALS_JSON='{"openai_api_key": "sk-…"}' \
    .venv/bin/python evals/run_evals.py [--only task-name] [--update-baseline]

Each task's result is compared against evals/baseline.json when it exists;
--update-baseline rewrites it from this run. Exit code: 0 when nothing
regressed vs the baseline (new failures of never-baselined tasks warn only),
1 on regression or infrastructure failure.

Deliberately NOT a unittest suite: it needs a live server, live vendor keys,
and a seeded knowledge base, and its outputs are a judgment-shaped report,
not a green/red bar. See evals/README.md for the one-time setup.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    import httpx
    import yaml
except ImportError as e:
    sys.exit(f"missing dependency: {e} — run inside the server venv")

EVALS_DIR = Path(__file__).resolve().parent
BASELINE_PATH = EVALS_DIR / "baseline.json"
REQUEST_TIMEOUT_SECONDS = 600.0


def _env(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        sys.exit(f"{name} is required (see evals/README.md)")
    return value


def _request_body(task: dict) -> dict:
    body = {
        "customer_id": _env("EVAL_CUSTOMER_ID"),
        "client": "evals",
        "data_type": "note",
        "request_source": "conversation",
        "raw_data": {"query_data": task["query"]},
        "llm_provider": _env("EVAL_PROVIDER", "openai"),
        "llm_model": _env("EVAL_MODEL"),
        "llm_credentials": json.loads(_env("EVAL_CREDENTIALS_JSON")),
        "conversation_history": [{"role": "user", "content": task["query"]}],
        "memory_enabled": False,
        "is_agentic": True,
    }
    graph_id = os.getenv("EVAL_GRAPH_ID")
    if graph_id:
        body["graph_id"] = graph_id
    return body


def _run_task(task: dict, base_url: str) -> dict:
    """Stream one /retrieve call; fold the SSE events into an observation."""
    observed = {
        "answer": "", "tools_called": [], "tool_rounds": 0, "todos_seen": False,
        "web_sources": 0, "errors": [], "usage": {}, "duration_s": 0.0,
    }
    started = time.monotonic()
    body = _request_body(task)
    # Per-task harness knob overrides ride a dedicated header the server does
    # not have — so instead they are applied by publishing a variant graph.
    # v1 keeps it simpler: overrides are advisory documentation unless
    # EVAL_GRAPH_ID_<TASKNAME> names a variant graph to use.
    variant = os.getenv(f"EVAL_GRAPH_ID_{task['name'].upper().replace('-', '_')}")
    if variant:
        body["graph_id"] = variant

    with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        with client.stream("POST", f"{base_url}/retrieve", json=body) as response:
            response.raise_for_status()
            content_parts: list[str] = []
            for line in response.iter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[len("data: "):]
                if payload == "[DONE]":
                    break
                event = json.loads(payload)
                if "content" in event:
                    content_parts.append(event["content"])
                elif "content_reset" in event:
                    content_parts = []
                elif "thinking_step" in event:
                    step = event["thinking_step"]
                    if step.get("kind") == "TOOL" and step.get("status") == "done":
                        observed["tool_rounds"] += 1
                        for call in step.get("calls") or []:
                            observed["tools_called"].append(call.get("name", ""))
                    if step.get("todos"):
                        observed["todos_seen"] = True
                elif "web_sources" in event:
                    observed["web_sources"] = len(event["web_sources"])
                elif "error" in event:
                    observed["errors"].append(event["error"])
                elif "usage" in event:
                    observed["usage"] = event["usage"]
            observed["answer"] = "".join(content_parts)
    observed["duration_s"] = round(time.monotonic() - started, 1)
    return observed


def _check(task: dict, observed: dict) -> list[str]:
    failures: list[str] = []
    answer = observed["answer"]
    called = set(observed["tools_called"])

    for tool in task.get("must_call_tools") or []:
        if tool not in called:
            failures.append(f"never called {tool} (called: {sorted(called) or 'none'})")
    for tool in task.get("must_not_call_tools") or []:
        if tool in called:
            failures.append(f"called {tool} but must not")
    if task.get("answer_regex") and not re.search(task["answer_regex"], answer, re.I | re.S):
        failures.append(f"answer does not match /{task['answer_regex']}/")
    if task.get("answer_not_regex") and re.search(task["answer_not_regex"], answer, re.I | re.S):
        failures.append(f"answer matches forbidden /{task['answer_not_regex']}/")
    if len(answer) < int(task.get("min_answer_chars") or 0):
        failures.append(f"answer too short ({len(answer)} chars)")
    if task.get("expect_citations"):
        if not re.search(r"\[\d+\]", answer):
            failures.append("no [n] citation markers in the answer")
        if observed["web_sources"] == 0:
            failures.append("no web_sources event emitted")
    if task.get("expect_todos") and not observed["todos_seen"]:
        failures.append("no thinking_step carried a todos checklist")
    if observed["tool_rounds"] < int(task.get("min_tool_rounds") or 0):
        failures.append(f"only {observed['tool_rounds']} tool round(s)")
    if "max_tool_rounds" in task and observed["tool_rounds"] > int(task["max_tool_rounds"]):
        failures.append(f"{observed['tool_rounds']} tool round(s) > max {task['max_tool_rounds']}")
    if task.get("expect_no_error", True) and observed["errors"]:
        failures.append(f"stream errored: {observed['errors'][:1]}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="run a single task by name")
    parser.add_argument("--update-baseline", action="store_true")
    args = parser.parse_args()

    base_url = _env("EVAL_BASE_URL", "http://localhost:8000").rstrip("/")
    tasks = yaml.safe_load((EVALS_DIR / "tasks.yaml").read_text())
    if args.only:
        tasks = [t for t in tasks if t["name"] == args.only]
        if not tasks:
            sys.exit(f"no task named {args.only}")
    baseline = (
        json.loads(BASELINE_PATH.read_text()) if BASELINE_PATH.exists() else {}
    )

    results: dict[str, dict] = {}
    regressions: list[str] = []
    for task in tasks:
        print(f"\n━━ {task['name']} — {task['description'].strip()[:80]}")
        try:
            observed = _run_task(task, base_url)
        except Exception as e:
            print(f"   INFRA FAILURE: {e}")
            results[task["name"]] = {"passed": False, "infra": str(e)}
            regressions.append(task["name"])
            continue
        failures = _check(task, observed)
        passed = not failures
        results[task["name"]] = {
            "passed": passed,
            "failures": failures,
            "tool_rounds": observed["tool_rounds"],
            "tools_called": sorted(set(observed["tools_called"])),
            "answer_chars": len(observed["answer"]),
            "total_tokens": observed["usage"].get("total_tokens"),
            "duration_s": observed["duration_s"],
        }
        status = "PASS" if passed else "FAIL"
        print(
            f"   {status}  rounds={observed['tool_rounds']} "
            f"tools={sorted(set(observed['tools_called']))} "
            f"answer={len(observed['answer'])}ch "
            f"tokens={observed['usage'].get('total_tokens')} "
            f"{observed['duration_s']}s"
        )
        for failure in failures:
            print(f"        ✗ {failure}")
        was_passing = baseline.get(task["name"], {}).get("passed")
        if was_passing and not passed:
            regressions.append(task["name"])

    print("\n━━ Summary")
    passed_count = sum(1 for r in results.values() if r.get("passed"))
    print(f"   {passed_count}/{len(results)} passed")
    if regressions:
        print(f"   REGRESSIONS vs baseline: {regressions}")
    if args.update_baseline:
        BASELINE_PATH.write_text(json.dumps(results, indent=2) + "\n")
        print(f"   baseline updated: {BASELINE_PATH}")
    return 1 if regressions else 0


if __name__ == "__main__":
    sys.exit(main())
