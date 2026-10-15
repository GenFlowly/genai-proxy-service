"""
Tests for making durable-run restarts, recoveries and dead letters visible
(plan 0.5): the startup recovery WARNING, the durable metrics on /metrics,
/ready next to a constant /health, the Fly readiness checks, and the
generated Grafana rows and alert rules.

/ready is exercised through the real app in a subprocess (importing app.py
reconfigures logging and metrics for the whole process, which other tests
must not inherit).

Run with `python -m unittest tests.test_durable_observability`.
"""
import json
import os
import subprocess
import sys
import tomllib
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import prometheus_client

import durable_metrics
import durable_runtime

RETRIEVAL_DIR = Path(__file__).resolve().parents[1]
GRAFANA_DIR = RETRIEVAL_DIR.parent / "observability" / "grafana"


class _FakeDBOS:
    application_version = "v2"

    def __init__(self, rows=(), fail=False):
        self.rows, self.fail = list(rows), fail

    async def list_workflows_async(self, **kwargs):
        if self.fail:
            raise RuntimeError("system database unavailable")
        statuses = kwargs.get("status")
        return [w for w in self.rows if statuses is None or w.status in statuses]


def _wf(workflow_id, status="ENQUEUED", app_version="v2", attempts=1):
    return SimpleNamespace(workflow_id=workflow_id, status=status, app_version=app_version,
                           recovery_attempts=attempts, input={"args": ("SECRET INPUT",)})


class StartupRecoveryLogTest(unittest.IsolatedAsyncioTestCase):
    async def test_one_warning_with_the_count_and_ids_of_recovered_runs(self):
        dbos = _FakeDBOS([
            _wf("run_a", status="ENQUEUED", attempts=1),   # re-enqueued by launch()
            _wf("run_b", status="PENDING", attempts=2),    # already dequeued again
            _wf("run_queued", status="ENQUEUED", attempts=0),  # never started: not a recovery
        ])
        with self.assertLogs("durable_runtime", level="WARNING") as logs:
            recovered = await durable_runtime.log_recovered_workflows(dbos)
        self.assertEqual(recovered, ["run_a", "run_b"])
        self.assertEqual(len(logs.output), 1)
        self.assertIn("recovering 2 workflow(s)", logs.output[0])
        self.assertIn("run_a", logs.output[0])
        self.assertNotIn("SECRET", logs.output[0])

    async def test_runs_of_another_version_are_named_as_not_recovered(self):
        dbos = _FakeDBOS([_wf("run_old", status="PENDING", app_version="v1")])
        with self.assertLogs("durable_runtime", level="WARNING") as logs:
            self.assertEqual(await durable_runtime.log_recovered_workflows(dbos), [])
        self.assertIn("1 workflow(s) of another app version will not be recovered", logs.output[0])
        self.assertIn("run_old", logs.output[0])

    async def test_nothing_to_recover_logs_no_warning(self):
        with self.assertNoLogs("durable_runtime", level="WARNING"):
            self.assertEqual(await durable_runtime.log_recovered_workflows(_FakeDBOS()), [])

    async def test_never_raises(self):
        with self.assertLogs("durable_runtime", level="ERROR"):
            self.assertEqual(await durable_runtime.log_recovered_workflows(_FakeDBOS(fail=True)), [])


class DurableMetricsTest(unittest.TestCase):
    def test_metrics_are_on_the_default_registry_that_metrics_serves(self):
        durable_metrics.run_recovered()
        durable_metrics.run_dead_lettered("agent_run")
        durable_metrics.tool_call_interrupted("generate_pdf")
        exposition = prometheus_client.generate_latest().decode()
        self.assertIn("durable_run_recovered_total ", exposition)
        self.assertIn('durable_run_dead_lettered_total{workflow="agent_run"}', exposition)
        self.assertIn('tool_call_interrupted_total{tool="generate_pdf"}', exposition)


_READY_SCRIPT = r"""
import json, os, sys
sys.path.insert(0, os.getcwd())
mode = sys.argv[1]
os.environ.pop("DATABASE_URL", None)
if mode != "unset":
    os.environ["DATABASE_URL"] = "postgresql://user:pass@127.0.0.1:9/none"
import app as app_module
import durable_runtime
if mode != "unset":
    async def startup():
        durable_runtime._ready = mode == "up"
    async def shutdown():
        pass
    durable_runtime.startup, durable_runtime.shutdown = startup, shutdown
from fastapi.testclient import TestClient
with TestClient(app_module.app) as client:
    out = {path: [client.get(path).status_code, client.get(path).json()] for path in ("/ready", "/health")}
print("READY_RESULT " + json.dumps(out))
"""


def _ready(mode: str) -> dict:
    env = dict(os.environ)
    env.pop("DATABASE_URL", None)
    proc = subprocess.run([sys.executable, "-c", _READY_SCRIPT, mode], cwd=RETRIEVAL_DIR, env=env,
                          capture_output=True, text=True, timeout=120)
    for line in proc.stdout.splitlines():
        if line.startswith("READY_RESULT "):
            return json.loads(line[len("READY_RESULT "):])
    raise AssertionError(f"no result (exit {proc.returncode}):\n{proc.stderr[-3000:]}")


class ReadyEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with ThreadPoolExecutor(max_workers=3) as pool:
            cls.results = dict(zip(("unset", "down", "up"), pool.map(_ready, ("unset", "down", "up"))))

    def test_without_database_url_it_is_ready(self):
        status, body = self.results["unset"]["/ready"]
        self.assertEqual(status, 200)
        self.assertEqual(body["durable_runs"], "not_configured")

    def test_configured_but_not_started_is_503_while_health_stays_200(self):
        self.assertEqual(self.results["down"]["/ready"][0], 503)
        self.assertEqual(self.results["down"]["/health"], [200, {"status": "healthy"}])

    def test_configured_and_started_is_ready(self):
        self.assertEqual(self.results["up"]["/ready"], [200, {"status": "ready", "durable_runs": "ready"}])


class FlyChecksTest(unittest.TestCase):
    def test_both_fly_configs_check_ready_next_to_health(self):
        for name in ("fly.toml", "fly.production.toml"):
            checks = tomllib.loads((RETRIEVAL_DIR / name).read_text())["checks"]
            self.assertEqual(checks["health"]["path"], "/health", name)
            self.assertEqual(checks["ready"]["path"], "/ready", name)
            self.assertEqual(checks["ready"]["port"], 5001, name)


def _row_panels(dashboard: dict, title: str) -> list[dict]:
    panels = dashboard["panels"]
    start = next(i for i, p in enumerate(panels) if p["type"] == "row" and p["title"] == title)
    end = next((i for i in range(start + 1, len(panels)) if panels[i]["type"] == "row"), len(panels))
    return panels[start + 1:end]


def _exprs(panels: list[dict]) -> str:
    return "\n".join(t["expr"] for p in panels for t in p.get("targets", []))


@unittest.skipUnless(GRAFANA_DIR.exists(), "observability/ is not in this checkout")
class GrafanaTest(unittest.TestCase):
    def test_agent_runs_row_on_both_backend_dashboards(self):
        for env in ("development", "production"):
            dashboard = json.loads((GRAFANA_DIR / f"fly-backend-{env}.json").read_text())
            exprs = _exprs(_row_panels(dashboard, "Agent runs"))
            for metric in ("agent_run_total", "agent_run_started_total", "durable_run_recovered_total",
                           "durable_run_dead_lettered_total", "tool_call_interrupted_total"):
                self.assertIn(metric, exprs, (env, metric))
            self.assertIn(f'app="genai-retrieval-server-{env}"', exprs)

    def test_pdf_generation_row_on_both_backend_dashboards(self):
        for env in ("development", "production"):
            dashboard = json.loads((GRAFANA_DIR / f"fly-backend-{env}.json").read_text())
            exprs = _exprs(_row_panels(dashboard, "PDF generation"))
            for metric in ("pdf_render_seconds_bucket", "pdf_render_seconds_count", "pdf_child_peak_rss_bytes",
                           "pdf_queue_wait_seconds", "pdf_render_warnings_total", "pdf_rejected_total",
                           "tool_execution_total"):
                self.assertIn(metric, exprs, (env, metric))

    def test_alert_rules_cover_restarts_dead_letters_recoveries_and_errors(self):
        for env in ("development", "production"):
            rules = json.loads((GRAFANA_DIR / "alerts" / f"retrieval-alerts-{env}.json").read_text())
            exprs = {r["title"]: r["data"][0]["model"]["expr"] for r in rules}
            self.assertIn("process_start_time_seconds", "\n".join(exprs.values()))
            self.assertIn("fly_instance_memory_mem_available", "\n".join(exprs.values()))
            dead = next(e for e in exprs.values() if "durable_run_dead_lettered_total" in e)
            self.assertIn('workflow="agent_run"', dead)
            self.assertIn("durable_run_recovered_total", "\n".join(exprs.values()))
            self.assertIn('status="error"', "\n".join(exprs.values()))
            for rule in rules:
                self.assertEqual(rule["folderUID"], f"genflowly-{env}")
                self.assertLessEqual(len(rule["uid"]), 40)


if __name__ == "__main__":
    unittest.main()
