"""
Integration tests for the durable-run recovery caps and app version (plan 0.1)
and the run sweep over real dead-lettered and stranded runs (plan 0.2).

DBOS runs on an SQLite system database through the REAL durable_runtime and
runs modules, so the real workflow registrations apply — the
max_recovery_attempts values on agent_run / request_agent_run and the
application_version from DBOS_APP_VERSION. Each "launch" is a separate process
(tests/durable_harness.py); a step hard-exits the process (os._exit(137)), the
way an OOM kill does, and the next launch recovers the run. run_events lives in
an SQLite file through tests/sqlite_pool.py.

Run with `python -m unittest tests.test_durable_recovery_cap` (about 25 s: the
processes import the whole graph stack).
"""
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from tests.durable_harness import parse_result, read_lines

RETRIEVAL_DIR = Path(__file__).resolve().parents[1]
APP_VERSION = "test-app-version-1"
HARD_EXIT = 137


def run_harness(scenario: str, directory: str, phase: str, timeout: float = 120,
                app_version: str = APP_VERSION):
    """One process lifetime. Returns (returncode, result dict | None, completed)."""
    env = dict(os.environ)
    env["DBOS_APP_VERSION"] = app_version
    env.pop("DATABASE_URL", None)  # the harness points DBOS at its own SQLite file
    proc = subprocess.run(
        [sys.executable, "-m", "tests.durable_harness", scenario, "--dir", directory, "--phase", phase],
        cwd=RETRIEVAL_DIR, env=env, capture_output=True, text=True, timeout=timeout,
    )
    return proc.returncode, parse_result(proc.stdout), proc


def _chain(scenario: str, crashing_launches: int, versions: list[str] | None = None) -> dict:
    """Launch `scenario` until it stops crashing; record every launch.
    `versions[i]` is launch i's DBOS_APP_VERSION (default APP_VERSION)."""
    directory = tempfile.mkdtemp(prefix=f"durable-{scenario}-")
    launches = []
    for i in range(crashing_launches + 1):
        version = versions[i] if versions else APP_VERSION
        code, result, proc = run_harness(
            scenario, directory, "start" if i == 0 else "recover", app_version=version,
        )
        launches.append({"code": code, "result": result, "stderr": proc.stderr[-3000:]})
        if code != HARD_EXIT:
            break
    return {"dir": directory, "launches": launches, "executions": read_lines(directory, "executions.log")}


class RecoveryCapIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Independent scenarios, each with its own database: run concurrently.
        with ThreadPoolExecutor(max_workers=4) as pool:
            agent = pool.submit(_chain, "poison", 4)
            request = pool.submit(_chain, "poison_request", 1)
            cancel = pool.submit(_chain, "cancel", 0)
            stranded = pool.submit(_chain, "stranded", 1, [APP_VERSION, APP_VERSION + "-bumped"])
            cls.agent, cls.request, cls.cancel = agent.result(), request.result(), cancel.result()
            cls.stranded = stranded.result()

    def _describe(self, chain: dict) -> str:
        return "\n".join(
            f"launch {i}: code={l['code']} result={l['result']}\n{l['stderr']}"
            for i, l in enumerate(chain["launches"])
        )

    def test_agent_run_poison_executes_four_times_then_is_dead_lettered(self):
        launches = self.agent["launches"]
        # K=3: four executions, each a crash ...
        self.assertEqual([l["code"] for l in launches[:4]], [HARD_EXIT] * 4, self._describe(self.agent))
        self.assertEqual(len(self.agent["executions"]), 4, self._describe(self.agent))
        # ... and the 5th launch dead-letters it WITHOUT executing it.
        last = launches[4]
        self.assertEqual(last["code"], 0, self._describe(self.agent))
        self.assertEqual(last["result"]["status"], "MAX_RECOVERY_ATTEMPTS_EXCEEDED")
        self.assertEqual(last["result"]["recovery_attempts"], 5)
        self.assertEqual(len(launches), 5)

    def test_runs_carry_the_configured_application_version(self):
        result = self.agent["launches"][-1]["result"]
        self.assertEqual(result["current_app_version"], APP_VERSION)
        self.assertEqual(result["app_version"], APP_VERSION)

    def test_request_agent_run_is_dead_lettered_on_the_first_restart(self):
        launches = self.request["launches"]
        self.assertEqual(launches[0]["code"], HARD_EXIT, self._describe(self.request))
        self.assertEqual(len(self.request["executions"]), 1, self._describe(self.request))
        self.assertEqual(launches[1]["code"], 0, self._describe(self.request))
        self.assertEqual(launches[1]["result"]["status"], "MAX_RECOVERY_ATTEMPTS_EXCEEDED")

    def test_cancel_route_cancels_a_live_run(self):
        launch = self.cancel["launches"][0]
        self.assertEqual(launch["code"], 0, self._describe(self.cancel))
        result = launch["result"]
        self.assertEqual(result["before"]["status"], "PENDING")
        self.assertEqual(result["response"], {"run_id": "run_harness", "status": "cancelled"})
        self.assertEqual(result["after"]["status"], "CANCELLED")

    def test_sweep_ends_the_dead_lettered_run_with_one_error_and_one_terminal_row(self):
        # Three sweep passes (two in one process, one as after a restart) over
        # the real dead letter above.
        result = self.agent["launches"][-1]["result"]
        rows = result["rows"]
        self.assertEqual(len(rows), 2, rows)
        error_row, terminal_row = rows
        self.assertEqual(error_row["event"], {
            "error": error_row["event"]["error"], "error_type": "run_lost",
        })
        self.assertFalse(error_row["terminal"])
        self.assertTrue(terminal_row["terminal"])
        self.assertEqual(terminal_row["event"]["status"], "error")
        self.assertEqual(terminal_row["event"]["error_type"], "run_lost")
        self.assertEqual(terminal_row["event"]["error"], error_row["event"]["error"])
        self.assertEqual(result["dead_lettered_metric"], 1.0)

    def test_sweep_cancels_a_run_stranded_by_an_app_version_bump(self):
        launches = self.stranded["launches"]
        self.assertEqual(launches[0]["code"], HARD_EXIT, self._describe(self.stranded))
        self.assertEqual(launches[1]["code"], 0, self._describe(self.stranded))
        result = launches[1]["result"]
        # The bumped version neither recovered nor executed it ...
        self.assertEqual(len(self.stranded["executions"]), 1)
        self.assertEqual(result["before"]["status"], "PENDING")
        self.assertEqual(result["before"]["app_version"], APP_VERSION)
        self.assertEqual(result["current_app_version"], APP_VERSION + "-bumped")
        # ... so the sweep cancelled it and ended its stream with an error.
        self.assertEqual(result["after"]["status"], "CANCELLED")
        self.assertEqual([r["event"].get("error_type") for r in result["rows"]], ["run_lost", "run_lost"])
        self.assertEqual([r["terminal"] for r in result["rows"]], [False, True])


class RecoveryCapConfigTest(unittest.TestCase):
    def test_caps(self):
        import runs

        self.assertEqual(runs.AGENT_RUN_MAX_RECOVERY_ATTEMPTS, 3)
        self.assertEqual(runs.REQUEST_AGENT_RUN_MAX_RECOVERY_ATTEMPTS, 0)

    def test_requirements_pin_the_durable_packages_exactly(self):
        pins = {}
        for line in (RETRIEVAL_DIR / "requirements.txt").read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            for name in ("dbos", "langgraph", "langgraph-checkpoint", "langgraph-checkpoint-postgres"):
                if line.split("==")[0].split(">")[0].split("<")[0].split("[")[0].strip() == name:
                    pins[name] = line
        self.assertEqual(set(pins), {"dbos", "langgraph", "langgraph-checkpoint", "langgraph-checkpoint-postgres"})
        for name, line in pins.items():
            self.assertRegex(line, rf"^{name}==\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
