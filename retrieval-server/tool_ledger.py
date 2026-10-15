"""
Tool-call attempt ledger for durable runs (plan 0.4).

On the durable path every built-in tool call runs as a memoized DBOS step
(`tool_invoke`, graph/nodes/tool_executor.py). A call that completed before a
crash returns from the step memo on re-execution and never runs again. The
one call that was IN FLIGHT when the process died has no memo, and DBOS would
simply run it again — after an OOM kill, that is the call that killed the
process. This ledger closes that gap: the step body records an attempt before
running the tool, so a re-execution that finds an earlier attempt of the same
step refuses to run it and hands the model an error result instead. One crash
per tool call, never a crash loop.

Rows are keyed (workflow_id, function_id, attempt) — DBOS.workflow_id and
DBOS.step_id, read INSIDE the step body (step_id is None anywhere else).
Subagents run in the parent's workflow and share its step counter, so their
calls get unique keys too. A row holds ids, the tool name, status and times:
never arguments, results, error text or secrets.

begin() rules:
  * no earlier attempt                       -> record attempt 1 and run;
  * an earlier attempt for another call id   -> ReplayDivergence: the replay
    is not following the recorded step order, and continuing would feed the
    model results that belong to other calls — fail the run;
  * an earlier attempt of the same call      -> do not run (RefusedAttempt):
    it was interrupted by the restart (or finished without its memo being
    recorded), its effects are unknown.

The table lives next to run_events on the checkpointer's pool
(durable_runtime.startup) and is pruned with it after RUN_EVENTS_TTL_SEC.
Purge: delete_workflow (DELETE /runs/{id}/data) and delete_customer.
"""
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psycopg.errors

logger = logging.getLogger(__name__)

TABLE = "tool_call_attempts"
_pool = None

# Identifies this process in the rows it writes (which attempt ran where).
BOOT_ID = uuid.uuid4().hex

STARTED = "started"
FINISHED = "finished"
FAILED = "failed"
REFUSED_INTERRUPTED = "refused_interrupted"

# What the model reads for a refused call. Never echoes the call's arguments.
INTERRUPTED_MESSAGE = (
    "This tool call was interrupted when the server restarted and was not run again."
)

# One statement per execute: the pool prepares statements, which rules out
# multi-statement strings. Times are written by the application (portable SQL).
_CREATE_SQL = (
    f"""
    CREATE TABLE IF NOT EXISTS {TABLE} (
        workflow_id   TEXT        NOT NULL,
        function_id   INTEGER     NOT NULL,
        attempt       INTEGER     NOT NULL,
        tool_call_id  TEXT        NOT NULL,
        tool_name     TEXT        NOT NULL,
        customer_id   TEXT        NOT NULL,
        status        TEXT        NOT NULL,
        owner_boot_id TEXT        NOT NULL,
        started_at    TIMESTAMPTZ NOT NULL,
        finished_at   TIMESTAMPTZ,
        error_class   TEXT,
        PRIMARY KEY (workflow_id, function_id, attempt)
    )
    """,
    f"CREATE INDEX IF NOT EXISTS {TABLE}_customer_idx ON {TABLE} (customer_id)",
    f"CREATE INDEX IF NOT EXISTS {TABLE}_started_idx ON {TABLE} (started_at)",
)


class ReplayDivergence(Exception):
    """The re-execution reached a recorded tool step with a different tool call.
    Raised out of the step and out of the tool executor (never turned into a
    tool error): the run must fail rather than continue on a misaligned memo."""

    def __init__(self, workflow_id: str, function_id: int, recorded_call_id: str, call_id: str):
        self.inputs = (workflow_id, function_id, recorded_call_id, call_id)
        super().__init__(
            f"Replay divergence in workflow {workflow_id} step {function_id}: the step "
            f"recorded tool call {recorded_call_id!r}, this execution reached it with "
            f"{call_id!r}. The run is not following its recorded step order (was "
            f"DBOS_APP_VERSION bumped with the step-order change?)."
        )

    def __reduce__(self):
        # DBOS records a step's exception with pickle.
        return (self.__class__, self.inputs)


@dataclass(frozen=True)
class Attempt:
    attempt: int
    run: bool  # False: refused, an earlier attempt of this call was interrupted


async def setup(pool) -> None:
    """Create the table and remember the pool. Called once on startup
    (durable_runtime.startup), right after run_events.setup."""
    global _pool
    _pool = pool
    async with pool.connection() as conn:
        for statement in _CREATE_SQL:
            await conn.execute(statement)
    logger.info("%s table ready", TABLE)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def begin(workflow_id: str, function_id: int, tool_call_id: str, tool_name: str,
                customer_id: str) -> Attempt:
    """Record this attempt of the tool step and decide whether it may run.
    Must be called inside the step body. See the module docstring for the rules."""
    if _pool is None:
        raise RuntimeError("tool ledger is not set up")
    async with _pool.connection() as conn:
        # Only one execution owns a step, so a lost insert race is rare; each
        # loss means another writer recorded an attempt, so a few re-reads
        # always settle it.
        for _ in range(10):
            cur = await conn.execute(
                f"SELECT attempt, tool_call_id, status FROM {TABLE} "
                "WHERE workflow_id = %s AND function_id = %s ORDER BY attempt",
                (workflow_id, function_id),
            )
            rows = await cur.fetchall()
            for row in rows:
                if row["tool_call_id"] != tool_call_id:
                    raise ReplayDivergence(workflow_id, function_id, row["tool_call_id"], tool_call_id)
            attempt = rows[-1]["attempt"] + 1 if rows else 1
            run = not rows
            now = _now()
            try:
                await conn.execute(
                    f"INSERT INTO {TABLE} (workflow_id, function_id, attempt, tool_call_id, "
                    "tool_name, customer_id, status, owner_boot_id, started_at, finished_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (workflow_id, function_id, attempt, tool_call_id, tool_name, customer_id,
                     STARTED if run else REFUSED_INTERRUPTED, BOOT_ID, now, None if run else now),
                )
            except psycopg.errors.UniqueViolation:
                continue  # another writer took this attempt number: re-read
            return Attempt(attempt=attempt, run=run)
    raise RuntimeError(f"tool ledger: could not record an attempt for {workflow_id} step {function_id}")


async def finish(workflow_id: str, function_id: int, attempt: int, status: str,
                 error_class: str | None = None) -> None:
    """Mark an attempt finished or failed. `error_class` is an exception class
    name, never its message."""
    async with _pool.connection() as conn:
        await conn.execute(
            f"UPDATE {TABLE} SET status = %s, finished_at = %s, error_class = %s "
            "WHERE workflow_id = %s AND function_id = %s AND attempt = %s",
            (status, _now(), error_class, workflow_id, function_id, attempt),
        )


async def attempts(workflow_id: str) -> list[dict]:
    """A workflow's rows, oldest step first (ops/tests)."""
    async with _pool.connection() as conn:
        cur = await conn.execute(
            f"SELECT * FROM {TABLE} WHERE workflow_id = %s ORDER BY function_id, attempt",
            (workflow_id,),
        )
        return await cur.fetchall()


async def delete_workflow(workflow_id: str) -> int:
    """Purge one run's rows (DELETE /runs/{id}/data). Idempotent."""
    async with _pool.connection() as conn:
        cur = await conn.execute(f"DELETE FROM {TABLE} WHERE workflow_id = %s", (workflow_id,))
        return cur.rowcount


async def delete_customer(customer_id: str) -> int:
    """Purge every row of a deleted customer (plan 3.9). Idempotent."""
    async with _pool.connection() as conn:
        cur = await conn.execute(f"DELETE FROM {TABLE} WHERE customer_id = %s", (customer_id,))
        return cur.rowcount


async def delete_older_than(max_age_seconds: int) -> int:
    """TTL prune (same TTL as run_events); returns rows deleted. Idempotent."""
    async with _pool.connection() as conn:
        cur = await conn.execute(
            f"DELETE FROM {TABLE} WHERE started_at < %s",
            (_now() - timedelta(seconds=max_age_seconds),),
        )
        return cur.rowcount
