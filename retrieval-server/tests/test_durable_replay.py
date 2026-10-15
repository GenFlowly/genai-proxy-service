"""
Crash-and-recover integration tests for deterministic replay (plan 0.4).

Each variant runs a real durable agent_run twice (tests/durable_harness.py,
scenario "replay"): the first process hard-exits at the variant's crash point,
the second one's DBOS.launch() recovers and re-executes the run. DBOS runs on
an SQLite system database; the LLM is a scripted streaming chat model behind
the real llm_invoke step, and `fake_tool` stores a file through a fake S3
before it may crash. Everything else — runs.py, the dynamic graph, llm_node,
tool_executor with its tool_invoke step, the attempt ledger, spawn_agent and
subagents — is the shipped code.

The step-name sequence test pins the DBOS step order of a two-round run. If it
fails, the order of steps a run takes has changed: in-flight runs of the old
order must not be replayed on the new one, so bump DBOS_APP_VERSION in the
same change (retrieval-server/development.md, "DBOS_APP_VERSION") and update
the expected sequence here.

Run with `python -m unittest tests.test_durable_replay` (about 25 s).
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from graph_tools import base as graph_tools_base
from tests.durable_harness import (
    ARG_MARKER,
    FINAL_ANSWER,
    HITL_VALUE,
    INTERRUPTED_PREFIX,
    RUN_ID,
    STREAM_ANSWER,
    parse_result,
    read_lines,
)

RETRIEVAL_DIR = Path(__file__).resolve().parents[1]
HARD_EXIT = 137
INTERRUPTED = INTERRUPTED_PREFIX + (
    "This tool call was interrupted when the server restarted and was not run again."
)
VARIANTS = ("main", "divergence", "stream", "late_crash", "hitl", "subagent")

# The DBOS steps of a two-round run, in order. See the module docstring before
# changing it: a change here needs a DBOS_APP_VERSION bump.
EXPECTED_TWO_ROUND_STEPS = [
    [1, "load_graph"],
    [2, "llm_invoke"],
    [3, "tool_invoke"],
    [4, "llm_invoke"],
    [5, "tool_invoke"],
    [6, "llm_invoke"],
]


def _run_variant(variant: str) -> dict:
    directory = tempfile.mkdtemp(prefix=f"durable-replay-{variant}-")
    env = dict(os.environ, DBOS_APP_VERSION="test-replay-1")
    env.pop("DATABASE_URL", None)
    launches = []
    for phase in ("start", "recover"):
        proc = subprocess.run(
            [sys.executable, "-m", "tests.durable_harness", "replay", "--variant", variant,
             "--dir", directory, "--phase", phase],
            cwd=RETRIEVAL_DIR, env=env, capture_output=True, text=True, timeout=180,
        )
        launches.append({"code": proc.returncode, "result": parse_result(proc.stdout),
                         "stderr": proc.stderr[-4000:]})
    return {
        "launches": launches,
        "result": launches[-1]["result"],
        "llm": read_lines(directory, "llm_bodies.log"),
        "tools": read_lines(directory, "tool_effects.log"),
        "puts": read_lines(directory, "s3_puts.log"),
    }


def _proxy_text(rows: list[dict]) -> str:
    """The answer text the proxy stores: content appended, content_reset clears."""
    text = ""
    for row in rows:
        event = row["event"]
        if event.get("content"):
            text += event["content"]
        elif "content_reset" in event:
            text = ""
    return text


class DeterministicReplayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with ThreadPoolExecutor(max_workers=len(VARIANTS)) as pool:
            futures = {v: pool.submit(_run_variant, v) for v in VARIANTS}
            cls.runs = {v: f.result() for v, f in futures.items()}

    def _get(self, variant: str) -> dict:
        run = self.runs[variant]
        detail = "\n".join(
            f"[{variant} launch {i}] code={l['code']}\n{l['stderr']}" for i, l in enumerate(run["launches"])
        )
        self.assertEqual(run["launches"][0]["code"], HARD_EXIT, detail)
        self.assertEqual(run["launches"][1]["code"], 0, detail)
        self.assertIsNotNone(run["result"], detail)
        return run

    # --- two tool rounds, crash in the round-2 tool step after its put -------

    def test_recovered_run_bills_no_completed_llm_call_again(self):
        run = self._get("main")
        self.assertEqual(run["result"]["status"], "SUCCESS")
        self.assertEqual(run["result"]["recovery_attempts"], 2)
        self.assertEqual([b["phase"] for b in run["llm"]], ["start", "start", "recover"])

    def test_completed_tool_call_runs_once_and_the_interrupted_one_is_not_rerun(self):
        run = self._get("main")
        self.assertEqual([(t["phase"], t["round"]) for t in run["tools"]], [("start", 1), ("start", 2)])
        # The model gets the interrupted error for the round-2 call instead.
        final_call = run["llm"][-1]
        self.assertEqual(final_call["tool_results"], ["root round 1 done", INTERRUPTED])
        self.assertEqual(run["result"]["interrupted_metric"], 1.0)
        self.assertEqual(run["result"]["recovered_metric"], 1.0)

    def test_history_holds_each_round_once(self):
        run = self._get("main")
        minted = [b["minted"][0] for b in run["llm"][:2]]  # A, B from the first process
        self.assertEqual(run["result"]["history"], minted)
        self.assertEqual(run["result"]["history_calls"], minted)

    def test_one_artifact_linked_and_only_the_interrupted_attempt_unlinked(self):
        run = self._get("main")
        summary = run["result"]["summary"]
        self.assertEqual(len(summary["generated_artifacts"]), 1)
        linked = {a["key"] for a in summary["generated_artifacts"]}
        puts = [p["key"] for p in run["puts"]]
        self.assertEqual(len(puts), 2)
        self.assertEqual([k for k in puts if k not in linked], [puts[1]])

    def test_artifact_ids_derive_from_the_call(self):
        run = self._get("main")
        artifact = run["result"]["summary"]["generated_artifacts"][0]
        call_a = run["llm"][0]["minted"][0]
        seed = f"cust-1:{RUN_ID}:3:{call_a}"
        self.assertEqual(run["tools"][0]["seed"], seed)
        expected = str(uuid.uuid5(graph_tools_base._ARTIFACT_ID_NAMESPACE, f"{seed}:1"))
        self.assertEqual(artifact["artifact_id"], expected)
        self.assertEqual(artifact["key"], f"customers/cust-1/attachments/{expected}")

    def test_dbos_step_sequence_is_pinned(self):
        # A failure here means the DBOS step order changed: bump
        # DBOS_APP_VERSION with it (module docstring).
        self.assertEqual(self._get("main")["result"]["steps"], EXPECTED_TWO_ROUND_STEPS)

    def test_ledger_rows_hold_ids_and_never_arguments(self):
        for variant in ("main", "subagent"):
            ledger = self._get(variant)["result"]["ledger"]
            self.assertTrue(ledger)
            self.assertNotIn(ARG_MARKER, json.dumps(ledger))
            self.assertEqual(
                set(ledger[0]),
                {"workflow_id", "function_id", "attempt", "tool_call_id", "tool_name", "customer_id",
                 "status", "owner_boot_id", "started_at", "finished_at", "error_class"},
            )
        ledger = self._get("main")["result"]["ledger"]
        self.assertEqual(
            [(r["function_id"], r["attempt"], r["status"]) for r in ledger],
            [(3, 1, "finished"), (5, 1, "started"), (5, 2, "refused_interrupted")],
        )

    def test_the_replay_clears_the_crashed_attempts_text_and_ends_completed(self):
        rows = self._get("main")["result"]["rows"]
        self.assertEqual(sum(1 for r in rows if r["terminal"]), 1)
        self.assertEqual(rows[-1]["event"]["status"], "completed")
        self.assertEqual(_proxy_text(rows), FINAL_ANSWER)
        # Usage comes from the checkpointed state: all three calls, two of
        # them replayed from the memo (no model events).
        usage_rows = [r["event"]["usage"] for r in rows if "usage" in r["event"] and not r["terminal"]]
        self.assertEqual([u["total_tokens"] for u in usage_rows], [45])
        self.assertEqual(rows[-1]["event"]["usage"]["total_tokens"], 45)

    # --- purge (plan 3.9) -------------------------------------------------------

    def test_delete_run_data_purges_every_store_and_repeats_with_204(self):
        purge = self._get("main")["result"]["purge"]
        self.assertEqual(purge["codes"], [204, 204])
        self.assertIsNone(purge["status_after"])           # DBOS rows
        self.assertIn(purge["steps_after"], (0,))          # step outputs (memoized results)
        self.assertFalse(purge["checkpoint_after"])        # LangGraph checkpoints
        self.assertEqual(purge["threads_after"], [])
        self.assertEqual(purge["rows_after"], 0)           # run_events
        self.assertEqual(purge["ledger_after"], 0)         # tool ledger

    # --- a replay that does not follow the recorded steps ---------------------

    def test_a_divergent_replay_fails_the_run_instead_of_feeding_the_model(self):
        run = self._get("divergence")
        rows = run["result"]["rows"]
        self.assertEqual(rows[-1]["event"]["status"], "error")
        # Nothing ran again: no tool, no billed LLM call in the second process.
        self.assertEqual([t["phase"] for t in run["tools"]], ["start", "start"])
        self.assertEqual([b["phase"] for b in run["llm"]], ["start", "start"])

    # --- crash while the answer streams --------------------------------------

    def test_a_crash_mid_answer_stores_the_final_answer_only(self):
        run = self._get("stream")
        rows = run["result"]["rows"]
        # The first process really was cut off mid-answer (its first words
        # went out, then the whole answer once more after the restart) ...
        streamed = "".join(r["event"].get("content", "") for r in rows)
        self.assertEqual(streamed.count("The answer is "), 2)
        self.assertEqual(streamed.count(STREAM_ANSWER), 1)
        # ... yet what the proxy keeps is exactly the final answer.
        self.assertEqual(_proxy_text(rows), STREAM_ANSWER)
        self.assertEqual([(b["phase"], b["n_tool_results"]) for b in run["llm"]],
                         [("start", 0), ("start", 1), ("recover", 1)])
        self.assertEqual(len(run["tools"]), 1)

    def test_a_crash_after_the_answer_republishes_it_from_the_memo(self):
        run = self._get("late_crash")
        self.assertEqual([b["phase"] for b in run["llm"]], ["start", "start", "start"])
        self.assertEqual(len(run["tools"]), 2)
        self.assertEqual(_proxy_text(run["result"]["rows"]), FINAL_ANSWER)
        self.assertEqual(run["result"]["interrupted_metric"], 0.0)

    # --- human in the loop ---------------------------------------------------

    def test_a_crash_after_recv_replays_the_recorded_human_input(self):
        run = self._get("hitl")
        self.assertEqual(run["result"]["status"], "SUCCESS")
        # The second process got the value from the step memo: nobody sent it again.
        replayed = [b for b in run["llm"] if b["phase"] == "recover"]
        self.assertEqual(len(replayed), 1)
        self.assertIn(f"chose: {HITL_VALUE}", replayed[0]["last_human"])
        self.assertEqual(run["result"]["summary"]["generated_response"], f"You chose {HITL_VALUE}.")
        names = [name for _, name in run["result"]["steps"]]
        self.assertEqual(names[:2], ["load_graph", "DBOS.recv"])
        # Each execution asks for input once; the proxy drops the duplicate.
        self.assertEqual(sum(1 for r in run["result"]["rows"] if "awaiting_input" in r["event"]), 2)

    # --- subagent ------------------------------------------------------------

    def test_a_crash_in_a_subagents_round_2_does_not_rerun_its_round_1_tool(self):
        run = self._get("subagent")
        self.assertEqual(run["result"]["status"], "SUCCESS")
        self.assertEqual([(t["phase"], t["scope"], t["round"]) for t in run["tools"]],
                         [("start", "child", 1), ("start", "child", 2)])
        child_replay = [b for b in run["llm"] if b["phase"] == "recover" and b["scope"] == "child"]
        self.assertEqual(len(child_replay), 1)
        self.assertEqual(child_replay[0]["tool_results"], ["child round 1 done", INTERRUPTED])
        self.assertEqual(
            [name for _, name in run["result"]["steps"]],
            ["load_graph", "llm_invoke", "llm_invoke", "tool_invoke", "llm_invoke", "tool_invoke",
             "llm_invoke", "llm_invoke"],
        )


if __name__ == "__main__":
    unittest.main()
