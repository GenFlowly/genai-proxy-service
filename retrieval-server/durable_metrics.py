"""
Durable-run recovery metrics (plan 0.2, 0.4, 0.5).

Registered once, at import, with prometheus_client's default registry, which
/metrics already serves (app.py), so Fly's Prometheus scrapes them with the
rest. They use prometheus_client directly rather than
encoding_library.observability, which drops labels outside its
ALLOWED_DIMENSIONS (`workflow` is not one). Labels carry only workflow and
tool names — never a run, customer or argument.

  durable_run_recovered_total            an agent_run re-executed after a restart
  durable_run_dead_lettered_total{workflow}  a run DBOS gave up recovering
                                         (MAX_RECOVERY_ATTEMPTS_EXCEEDED); counted
                                         once per run by the sweep
  tool_call_interrupted_total{tool}      a tool call refused on re-execution
                                         because a restart interrupted it
"""
from prometheus_client import Counter

DURABLE_RUN_RECOVERED = Counter(
    "durable_run_recovered_total",
    "agent_run executions that replayed a run interrupted by a restart",
)
DURABLE_RUN_DEAD_LETTERED = Counter(
    "durable_run_dead_lettered_total",
    "Durable runs dead-lettered after exhausting their recovery attempts",
    ["workflow"],
)
TOOL_CALL_INTERRUPTED = Counter(
    "tool_call_interrupted_total",
    "Tool calls not run again on re-execution because a restart interrupted them",
    ["tool"],
)


def run_recovered() -> None:
    DURABLE_RUN_RECOVERED.inc()


def run_dead_lettered(workflow: str) -> None:
    DURABLE_RUN_DEAD_LETTERED.labels(workflow=workflow).inc()


def tool_call_interrupted(tool: str) -> None:
    TOOL_CALL_INTERRUPTED.labels(tool=tool).inc()
