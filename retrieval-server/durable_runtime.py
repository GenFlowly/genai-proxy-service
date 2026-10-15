"""
Fail-safe bootstrap for durable agent runs (see DURABLE_AGENTS_DBOS_PLAN.md).

Durable runs = DBOS durable workflows + a LangGraph Postgres checkpointer, backed
by the Supabase Postgres in DATABASE_URL. This module is enabled ONLY when
DATABASE_URL is set; if it's unset — or anything here fails — the retrieval-server
starts and serves the existing /retrieve path exactly as before, with durable
/runs simply inactive. Nothing here is allowed to crash app startup.

Lifecycle:
  import time   -> _construct_dbos(): create the DBOS singleton so @DBOS.workflow
                   decorators (routes/runs.py) can register. Does NOT touch Postgres.
  startup()     -> open the checkpointer connection pool, run checkpointer + DBOS
                   migrations, DBOS.launch() (also recovers interrupted workflows),
                   then start the run_events TTL pruner and the run sweep.
  shutdown()    -> DBOS.destroy() + close the pool.

The run sweep (plan 0.2) ends runs nothing else will end — dead-lettered,
failed or stranded by an app-version bump — with an error the user sees, and
counts request-agent dead letters.

P0-verified config for the Supabase session pooler: use_listen_notify=False
(the pooler has no working LISTEN/NOTIFY, so DBOS polls) and dbos_system_schema
(DBOS tables live in a schema of the single Supabase database).
"""
import logging
import os
import time
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")
DBOS_SYSTEM_SCHEMA = os.getenv("DBOS_SYSTEM_SCHEMA", "dbos")
# Explicit DBOS application version (plan 0.1). DBOS recovers and dequeues only
# workflows of the CURRENT version. Left unset, it hashes the workflow wrappers'
# source plus the installed dbos version, so editing a wrapper (or a dbos
# release) strands every in-flight run, while a change that reorders the steps
# a run takes (graph code: llm_node, tool_executor, subagent, ...) does NOT
# change it — and replaying an old run on a new step order misaligns the step
# memo. So production pins it and bumps it exactly when the step sequence can
# change. Procedure: development.md, "Durable runs: deploy rules".
DBOS_APP_VERSION = os.getenv("DBOS_APP_VERSION") or None
_CHECKPOINTER_POOL_MAX = int(os.getenv("CHECKPOINTER_POOL_MAX", "5"))
# Run-events TTL (P3): prune the reattach channel so it doesn't grow unbounded.
RUN_EVENTS_TTL_SEC = int(os.getenv("RUN_EVENTS_TTL_SEC", str(7 * 24 * 3600)))
RUN_EVENTS_CLEANUP_INTERVAL_SEC = int(os.getenv("RUN_EVENTS_CLEANUP_INTERVAL_SEC", "3600"))
# Run sweep (plan 0.2). A loop, not a startup pass: DBOS dead-letters a
# recovered run in its queue worker AFTER launch() returns.
SWEEP_FIRST_DELAY_SEC = float(os.getenv("DURABLE_SWEEP_FIRST_DELAY_SEC", "10"))
SWEEP_INTERVAL_SEC = float(os.getenv("DURABLE_SWEEP_INTERVAL_SEC", "60"))
# A PENDING/ENQUEUED run of another app version is never recovered nor
# dequeued; past this age the sweep cancels it and ends it with an error.
STRANDED_AFTER_SEC = int(os.getenv("DURABLE_STRANDED_AFTER_SEC", "600"))
_SWEEP_BATCH = 200

_dbos_constructed = False  # DBOS() instance exists -> workflows may register/decorate
_ready = False             # checkpointer setup + DBOS.launch() succeeded -> runs usable
_checkpointer = None
_pool = None
_cleanup_task = None       # background run_events TTL pruner
_sweep_task = None         # background run sweep (plan 0.2)


def config_present() -> bool:
    """DATABASE_URL is set — durable runs are configured (may not be launched yet)."""
    return bool(DATABASE_URL)


def dbos_constructed() -> bool:
    """The DBOS singleton exists, so routes/runs.py could register its workflow."""
    return _dbos_constructed


def is_ready() -> bool:
    """Durable runs are fully up (checkpointer + DBOS launched)."""
    return _ready


def get_checkpointer():
    """The AsyncPostgresSaver, or None if durable runs aren't ready."""
    return _checkpointer


def get_pool():
    """The shared async connection pool (also used by run_events for the events
    table), or None if durable runs aren't ready."""
    return _pool


def _construct_dbos() -> None:
    global _dbos_constructed
    if _dbos_constructed or not config_present():
        return
    try:
        from dbos import DBOS, DBOSConfig

        DBOS(
            config=DBOSConfig(
                name="retrieval-server",
                system_database_url=DATABASE_URL,
                use_listen_notify=False,
                dbos_system_schema=DBOS_SYSTEM_SCHEMA,
                run_migrations=True,
                # None keeps DBOS's own behaviour (DBOS__APPVERSION env, else
                # the computed hash).
                application_version=DBOS_APP_VERSION,
            )
        )
        _dbos_constructed = True
        logger.info("DBOS constructed (durable runs configured; pending launch)")
    except Exception:
        logger.exception("DBOS construction failed — durable runs disabled")


# Construct at import so routes/runs.py's @DBOS.workflow can register before launch.
_construct_dbos()


async def startup() -> None:
    """FastAPI startup hook. Fail-safe: on any error durable runs stay disabled
    and the server continues serving /retrieve normally."""
    global _ready, _checkpointer, _pool
    if not _dbos_constructed:
        logger.info("Durable runs disabled (DATABASE_URL unset or DBOS init failed)")
        return
    try:
        from dbos import DBOS
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        from psycopg.rows import dict_row
        from psycopg_pool import AsyncConnectionPool

        # Connection settings match AsyncPostgresSaver.from_conn_string; a pool
        # (not a single connection) so concurrent runs don't contend, and
        # prepare_threshold=0 keeps it safe over the Supabase pooler.
        _pool = AsyncConnectionPool(
            conninfo=DATABASE_URL,
            min_size=1,
            max_size=_CHECKPOINTER_POOL_MAX,
            open=False,
            kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        )
        await _pool.open()
        _checkpointer = AsyncPostgresSaver(_pool)
        await _checkpointer.setup()

        # Reattach events table (poll-based stream channel) shares this pool,
        # and so does the tool-call attempt ledger (plan 0.4).
        import run_events
        import tool_ledger
        await run_events.setup(_pool)
        await tool_ledger.setup(_pool)

        DBOS.launch()  # runs migrations + recovers any interrupted workflows

        # Register the agent-runs queue now that the system DB is up (queues
        # can't be registered before launch). Import here to avoid a heavy
        # import at module load.
        import runs
        await runs.register_run_queue()
        await log_recovered_workflows()

        import asyncio
        global _cleanup_task, _sweep_task
        _cleanup_task = asyncio.create_task(_run_events_ttl_loop())
        _sweep_task = asyncio.create_task(_sweep_loop())

        _ready = True
        logger.info("Durable runs ENABLED (checkpointer ready, DBOS launched)")
    except Exception:
        logger.exception("Durable runtime startup failed — durable runs disabled")
        _ready = False


async def _run_events_ttl_loop() -> None:
    """Periodically prune run_events and the tool-call attempt ledger past
    their TTL. Idempotent DELETEs, so it's safe for every process to run its
    own loop."""
    import asyncio

    import run_events
    import tool_ledger
    while True:
        try:
            await asyncio.sleep(RUN_EVENTS_CLEANUP_INTERVAL_SEC)
            deleted = await run_events.delete_older_than(RUN_EVENTS_TTL_SEC)
            if deleted:
                logger.info("run_events TTL prune: deleted %d row(s) older than %ds", deleted, RUN_EVENTS_TTL_SEC)
            deleted = await tool_ledger.delete_older_than(RUN_EVENTS_TTL_SEC)
            if deleted:
                logger.info("tool ledger TTL prune: deleted %d row(s) older than %ds", deleted, RUN_EVENTS_TTL_SEC)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("run_events / tool ledger TTL prune failed")


_MAX_LOGGED_IDS = 50


async def log_recovered_workflows(dbos=None) -> list[str]:
    """One WARNING at startup naming the runs this start recovers (plan 0.5):
    launch() re-enqueues every PENDING workflow of this executor and app
    version — they were executing when the previous process died. Logged
    right after launch, so a run may already be dequeued again (PENDING) by
    the time it is listed; a run waiting in the queue that never started
    (no attempt yet) is not a recovery and is not listed. A second WARNING
    names PENDING/ENQUEUED runs of other app versions, which are never
    recovered (the sweep ends them). Ids only — never inputs. Never raises."""
    try:
        if dbos is None:
            from dbos import DBOS as dbos
        current = dbos.application_version
        rows = await dbos.list_workflows_async(
            status=["PENDING", "ENQUEUED"], load_input=False, load_output=False,
        )
        recovered = [w.workflow_id for w in rows
                     if w.app_version == current and (w.recovery_attempts or 0) >= 1]
        stranded = [w.workflow_id for w in rows
                    if w.app_version is not None and w.app_version != current]
        if recovered:
            logger.warning(
                "Durable runtime: recovering %d workflow(s) interrupted by the last shutdown: %s",
                len(recovered), recovered[:_MAX_LOGGED_IDS],
            )
        if stranded:
            logger.warning(
                "Durable runtime: %d workflow(s) of another app version will not be recovered "
                "(current %s; the sweep ends them): %s",
                len(stranded), current, stranded[:_MAX_LOGGED_IDS],
            )
        return recovered
    except Exception:
        logger.exception("Durable runtime: could not list recovered workflows")
        return []


class SweepState:
    """What one process's sweep remembers between passes."""

    def __init__(self, started_ms: int | None = None):
        started_ms = int(time.time() * 1000) if started_ms is None else started_ms
        # request_agent_run dead letters are counted once: only rows whose
        # updated_at (set by DBOS when it dead-letters) is newer than anything
        # counted so far. Starts a little before this process started, which
        # covers the dead letters this process's own launch() produces.
        self.dead_letter_watermark_ms = started_ms - 120_000
        self.counted_dead_letters: set[str] = set()
        # agent_runs this process already ended (or found already ended), so
        # each pass does not re-check them.
        self.ended_runs: set[str] = set()


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _log_workflow(message: str, w) -> None:
    """Ids, name, attempts, executor and version only — a workflow's input is
    the user's request and is never logged."""
    logger.warning(
        "%s: workflow_id=%s name=%s status=%s recovery_attempts=%s executor=%s app_version=%s",
        message, w.workflow_id, w.name, w.status, w.recovery_attempts, w.executor_id, w.app_version,
    )


async def sweep_once(state: SweepState, dbos=None) -> None:
    """One pass of the run sweep (plan 0.2). Each part is isolated: a failure
    is logged and the other parts still run."""
    if dbos is None:
        from dbos import DBOS as dbos
    now = datetime.now(timezone.utc)
    for part in (_end_failed_agent_runs, _end_stranded_agent_runs, _count_request_dead_letters):
        try:
            await part(dbos, now, state)
        except Exception:
            logger.exception("durable run sweep: %s failed", part.__name__)


async def _end_failed_agent_runs(dbos, now: datetime, state: SweepState) -> None:
    """agent_runs DBOS dead-lettered (MAX_RECOVERY_ATTEMPTS_EXCEEDED: no output,
    no error row) or that failed outright (ERROR: the workflow raised before
    its terminal row) end with the two error rows, once."""
    import durable_metrics
    import run_events

    rows = await dbos.list_workflows_async(
        name="agent_run",
        status=["MAX_RECOVERY_ATTEMPTS_EXCEEDED", "ERROR"],
        start_time=_iso(now - timedelta(seconds=RUN_EVENTS_TTL_SEC)),
        sort_desc=True,
        limit=_SWEEP_BATCH,
        load_input=False,
        load_output=False,
    )
    for w in rows:
        if w.workflow_id in state.ended_runs:
            continue
        dead_lettered = w.status == "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
        if dead_lettered:
            message, error_type = run_events.RUN_LOST_MESSAGE, "run_lost"
        else:
            message, error_type = run_events.RUN_FAILED_MESSAGE, "error"
        events = run_events.failure_events(w.workflow_id, message, error_type)
        if await run_events.publish_terminal_once(w.workflow_id, events):
            if dead_lettered:
                durable_metrics.run_dead_lettered("agent_run")
                _log_workflow("durable run dead-lettered after repeated crashes; ended it with an error", w)
            else:
                _log_workflow("durable run failed without a terminal event; ended it with an error", w)
        state.ended_runs.add(w.workflow_id)


async def _end_stranded_agent_runs(dbos, now: datetime, state: SweepState) -> None:
    """agent_runs left PENDING/ENQUEUED under another app version (a deploy
    bumped DBOS_APP_VERSION while they ran) are never recovered or dequeued:
    cancel them, then end them with the error rows."""
    import run_events

    current = dbos.application_version
    rows = await dbos.list_workflows_async(
        name="agent_run",
        status=["PENDING", "ENQUEUED"],
        end_time=_iso(now - timedelta(seconds=STRANDED_AFTER_SEC)),
        limit=_SWEEP_BATCH,
        load_input=False,
        load_output=False,
    )
    for w in rows:
        # An unset version is dequeued by the latest version: not stranded.
        if w.app_version is None or w.app_version == current:
            continue
        await dbos.cancel_workflow_async(w.workflow_id)
        events = run_events.failure_events(w.workflow_id, run_events.RUN_LOST_MESSAGE, "run_lost")
        await run_events.publish_terminal_once(w.workflow_id, events)
        state.ended_runs.add(w.workflow_id)
        _log_workflow(f"durable run stranded by an app version change (current {current}); cancelled it", w)


async def _count_request_dead_letters(dbos, now: datetime, state: SweepState) -> None:
    """request_agent_run is capped at 0 recovery attempts, so every restart
    that interrupts one dead-letters it. Its caller is gone; log and count each
    once — only rows dead-lettered (updated_at) after the previous pass."""
    import durable_metrics

    rows = await dbos.list_workflows_async(
        name="request_agent_run",
        status="MAX_RECOVERY_ATTEMPTS_EXCEEDED",
        completed_after=_iso(datetime.fromtimestamp(state.dead_letter_watermark_ms / 1000, timezone.utc)),
        limit=_SWEEP_BATCH,
        load_input=False,
        load_output=False,
    )
    newest = state.dead_letter_watermark_ms
    for w in rows:
        updated = w.updated_at or 0
        if updated <= state.dead_letter_watermark_ms or w.workflow_id in state.counted_dead_letters:
            continue
        state.counted_dead_letters.add(w.workflow_id)
        newest = max(newest, updated)
        durable_metrics.run_dead_lettered("request_agent_run")
        _log_workflow("request agent run dead-lettered after a restart", w)
    state.dead_letter_watermark_ms = newest


async def _sweep_loop() -> None:
    """First pass ~10 s after startup (after this boot's recovery has had time
    to re-dispatch, and dead-letter, interrupted runs), then every 60 s."""
    import asyncio

    state = SweepState()
    try:
        await asyncio.sleep(SWEEP_FIRST_DELAY_SEC)
        while True:
            await sweep_once(state)
            await asyncio.sleep(SWEEP_INTERVAL_SEC)
    except asyncio.CancelledError:
        pass


async def shutdown() -> None:
    global _pool, _cleanup_task, _sweep_task
    if _cleanup_task is not None:
        _cleanup_task.cancel()
        _cleanup_task = None
    if _sweep_task is not None:
        _sweep_task.cancel()
        _sweep_task = None
    try:
        if _dbos_constructed:
            from dbos import DBOS

            DBOS.destroy()
    except Exception:
        logger.exception("DBOS shutdown error")
    if _pool is not None:
        try:
            await _pool.close()
        except Exception:
            logger.exception("Checkpointer pool close error")
        _pool = None
