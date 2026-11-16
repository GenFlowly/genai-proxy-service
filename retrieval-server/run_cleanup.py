"""
Deletes what durable runs leave in Postgres once nothing can use it again.

A run's LangGraph checkpoints exist only so a run that is still going can resume
(after a crash or a wait for input). Its DBOS rows (input, output, cached LLM
replies) and run_events serve recovery, status reads and reattach while it runs
and briefly after; once it ends, the proxy has persisted the result. So:

  * each workflow drops its own checkpoints the moment it ends
    (checkpoints_dropped_at_end),
  * sweep() deletes the DBOS rows of runs that ended more than the retention
    window ago, then every checkpoint row and run event whose run no longer has a
    workflow row.

The orphan pass relies on run id = DBOS workflow id = checkpoint thread_id =
run_events.run_id (runs.start_run / runs.run_request_agent), and on DBOS
recording a workflow before its body runs, so a live run is never an orphan.
"""
import contextlib
import logging
from datetime import datetime, timedelta, timezone

from dbos._error import DBOSWorkflowCancelledError

import durable_runtime

logger = logging.getLogger(__name__)

_ENDED_STATUSES = ["SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"]
_BATCH = 500
_CHECKPOINT_TABLES = ("checkpoint_writes", "checkpoint_blobs", "checkpoints")


async def delete_checkpoints(run_id: str) -> None:
    """Delete a run's checkpoint thread. Never raises: a failure is logged and
    the sweep removes the rows later."""
    checkpointer = durable_runtime.get_checkpointer()
    if checkpointer is None:
        return
    try:
        await checkpointer.adelete_thread(run_id)
    except Exception:
        logger.exception("Could not delete the checkpoints of run %s", run_id)


@contextlib.asynccontextmanager
async def checkpoints_dropped_at_end(run_id: str):
    """Wrap a workflow body: drop the run's checkpoints when it returns, raises,
    or is cancelled. Any other BaseException (task cancelled by a shutdown or
    redeploy, another executor owning the run) keeps them, because DBOS resumes
    that run from its checkpoint."""
    try:
        yield
    except (Exception, DBOSWorkflowCancelledError):
        await delete_checkpoints(run_id)
        raise
    await delete_checkpoints(run_id)


async def sweep(retention_sec: int) -> None:
    """Delete runs that ended more than retention_sec ago, then orphaned
    checkpoints and events. Every delete is idempotent, so processes sweeping
    concurrently is harmless."""
    from dbos import DBOS

    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=retention_sec)).isoformat()
    runs_deleted = 0
    while True:
        ended = await DBOS.list_workflows_async(
            status=_ENDED_STATUSES,
            completed_before=cutoff,
            limit=_BATCH,
            load_input=False,
            load_output=False,
        )
        if not ended:
            break
        await DBOS.delete_workflows_async([w.workflow_id for w in ended])
        runs_deleted += len(ended)
        if len(ended) < _BATCH:
            break

    checkpoint_rows, event_rows = await _delete_orphans()
    if runs_deleted or checkpoint_rows or event_rows:
        logger.info(
            "Run cleanup: deleted %d ended run(s), %d orphaned checkpoint row(s), %d orphaned run event(s)",
            runs_deleted, checkpoint_rows, event_rows,
        )


async def _delete_orphans() -> tuple[int, int]:
    workflows = f"{durable_runtime.DBOS_SYSTEM_SCHEMA}.workflow_status"
    checkpoint_rows = 0
    async with durable_runtime.get_pool().connection() as conn:
        for table in _CHECKPOINT_TABLES:
            cur = await conn.execute(
                f"DELETE FROM {table} t WHERE NOT EXISTS "
                f"(SELECT 1 FROM {workflows} w WHERE w.workflow_uuid = t.thread_id)"
            )
            checkpoint_rows += cur.rowcount
        cur = await conn.execute(
            f"DELETE FROM run_events e WHERE NOT EXISTS "
            f"(SELECT 1 FROM {workflows} w WHERE w.workflow_uuid = e.run_id)"
        )
        return checkpoint_rows, cur.rowcount
