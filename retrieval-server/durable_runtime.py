"""
Fail-safe bootstrap for durable agent runs (see DURABLE_AGENTS_DBOS_PLAN.md).

Durable runs = DBOS durable workflows + a LangGraph Postgres checkpointer, backed
by the Supabase Postgres in DATABASE_URL. This module is enabled ONLY when
DATABASE_URL is set; if it's unset — or anything here fails — the retrieval-server
starts and serves the existing /retrieve path exactly as before, with durable
/runs simply inactive. Nothing here is allowed to crash app startup.

Lifecycle:
  import time   -> _construct_dbos(): create the DBOS singleton so @DBOS.workflow
                   decorators (runs.py) can register, and slow its idle polling.
                   Does NOT touch Postgres.
  startup()     -> open the checkpointer connection pool, run checkpointer + DBOS
                   migrations, DBOS.launch() (also recovers interrupted workflows),
                   delete unused DBOS queues, start the run cleanup loop.
  shutdown()    -> DBOS.destroy() + close the pool.

P0-verified config for the Supabase session pooler: use_listen_notify=False
(the pooler has no working LISTEN/NOTIFY) and dbos_system_schema (DBOS tables
live in a schema of the single Supabase database).

Idle cost: DBOS polls Postgres on fixed timers whether or not a run exists, and
Supabase bills every byte those polls return as egress. At DBOS's 1-second
defaults an idle process runs ~26 statements/s, enough to exhaust the free
plan's egress; _quiet_idle_polling() brings that to about one.
"""
import asyncio
import logging
import os
import time

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")
DBOS_SYSTEM_SCHEMA = os.getenv("DBOS_SYSTEM_SCHEMA", "dbos")
# Connections per process. The Supabase session pooler refuses clients past its
# pool size (15 on the smallest compute), counted across every machine on the
# project, so two machines must stay at 7 each or under. DBOS keeps every
# connection it opens until the process exits (its default pool is 20); the
# checkpointer pool closes idle extras after 10 minutes.
_DBOS_POOL_SIZE = int(os.getenv("DBOS_POOL_SIZE", "4"))
_CHECKPOINTER_POOL_MAX = int(os.getenv("CHECKPOINTER_POOL_MAX", "3"))
# How long startup waits for the first database connection. Startup blocks the
# server from answering /health, and Fly's health-check grace period is 30 s, so
# an unreachable database must give up well before that.
_CONNECT_TIMEOUT_SEC = float(os.getenv("DATABASE_CONNECT_TIMEOUT_SEC", "10"))
# How long an ended run's DBOS rows and events outlive it (status reads and
# reattach right after it ends), and how often the cleanup sweep runs. Their
# sum bounds how long a run's content stays in Postgres after it ends, which the
# privacy policy states as "within an hour".
RUN_RETENTION_SEC = int(os.getenv("RUN_RETENTION_SEC", "1800"))
RUN_CLEANUP_INTERVAL_SEC = int(os.getenv("RUN_CLEANUP_INTERVAL_SEC", "600"))

# The DBOS version _quiet_idle_polling() was written against; requirements pin it.
_TUNED_DBOS_VERSION = "3.4.0"
# Crash recovery re-enqueues onto DBOS's internal queue, so this bounds how long
# a recovered run waits to restart after startup.
_INTERNAL_QUEUE_POLL_SEC = 10.0
# Workflow timeouts and delayed starts; runs use neither.
_BACKGROUND_JOBS_SEC = 30.0
# The queue manager re-lists database-backed queues every second; a new queue
# is noticed within this long.
_QUEUE_LIST_CACHE_SEC = 60.0
# No workflow schedules exist.
_SCHEDULER_POLL_SEC = 600.0

_dbos_constructed = False  # DBOS() instance exists -> workflows may register/decorate
_ready = False             # checkpointer setup + DBOS.launch() succeeded -> runs usable
_checkpointer = None
_pool = None
_cleanup_task = None       # background run cleanup loop
_queue_list_cache: dict = {}


def config_present() -> bool:
    """DATABASE_URL is set — durable runs are configured (may not be launched yet)."""
    return bool(DATABASE_URL)


def dbos_constructed() -> bool:
    """The DBOS singleton exists, so runs.py could register its workflows."""
    return _dbos_constructed


def is_ready() -> bool:
    """Durable runs are fully up (checkpointer + DBOS launched)."""
    return _ready


def get_checkpointer():
    """The AsyncPostgresSaver, or None if durable runs aren't ready."""
    return _checkpointer


def get_pool():
    """The shared async connection pool (also used by run_events and
    run_cleanup), or None if durable runs aren't ready."""
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
                sys_db_pool_size=_DBOS_POOL_SIZE,
                scheduler_polling_interval_sec=_SCHEDULER_POLL_SEC,
            )
        )
        _dbos_constructed = True
        logger.info("DBOS constructed (durable runs configured; pending launch)")
    except Exception:
        logger.exception("DBOS construction failed — durable runs disabled")
        return
    try:
        _quiet_idle_polling()
    except Exception:
        logger.exception("Could not slow DBOS idle polling; it keeps its 1-second loops")


def _quiet_idle_polling() -> None:
    """Slow the DBOS loops that poll every second: the internal queue's worker,
    the background-jobs sweep, and the queue manager's queue list. DBOS 3.4 has
    no setting for these, so this sets its internals, and leaves any other
    version at its defaults with a warning. Must run before DBOS.launch()."""
    from importlib.metadata import version

    installed = version("dbos")
    if installed != _TUNED_DBOS_VERSION:
        logger.warning(
            "dbos %s installed but idle polling is tuned for %s; DBOS keeps its 1-second loops",
            installed, _TUNED_DBOS_VERSION,
        )
        return

    from dbos import _workflow_commands
    from dbos._dbos import _get_or_create_dbos_registry
    from dbos._sys_db import SystemDatabase

    _workflow_commands._BACKGROUND_JOBS_INTERVAL_SEC = _BACKGROUND_JOBS_SEC
    _get_or_create_dbos_registry().get_internal_queue()._polling_interval_sec = _INTERNAL_QUEUE_POLL_SEC

    list_queues = SystemDatabase.list_queues

    def cached_list_queues(self, **kwargs):
        key = (id(self), repr(kwargs))
        hit = _queue_list_cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < _QUEUE_LIST_CACHE_SEC:
            return hit[1]
        queues = list_queues(self, **kwargs)
        _queue_list_cache[key] = (time.monotonic(), queues)
        return queues

    SystemDatabase.list_queues = cached_list_queues


# Construct at import so runs.py's @DBOS.workflow can register before launch.
_construct_dbos()


async def startup() -> None:
    """FastAPI startup hook. Fail-safe: on any error durable runs stay disabled
    and the server continues serving /retrieve normally."""
    global _ready, _checkpointer, _pool, _cleanup_task
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
        await _pool.open(wait=True, timeout=_CONNECT_TIMEOUT_SEC)
        _checkpointer = AsyncPostgresSaver(_pool)
        await _checkpointer.setup()

        # Reattach events table (poll-based stream channel) shares this pool.
        import run_events
        await run_events.setup(_pool)

        DBOS.launch()  # runs migrations + recovers any interrupted workflows
        await _delete_unused_queues()

        _cleanup_task = asyncio.create_task(_cleanup_loop())

        _ready = True
        logger.info("Durable runs ENABLED (checkpointer ready, DBOS launched)")
    except Exception:
        logger.exception("Durable runtime startup failed — durable runs disabled")
        _ready = False
        _checkpointer = None
        # An open pool keeps reconnecting in the background forever.
        await _close_pool()


async def _close_pool() -> None:
    global _pool
    if _pool is not None:
        try:
            await _pool.close()
        except Exception:
            logger.exception("Checkpointer pool close error")
        _pool = None


async def _delete_unused_queues() -> None:
    """Runs start directly (runs.start_run), so this server consumes no
    database-backed queue, yet DBOS gives every queue registered under its
    application a worker that polls every second."""
    from dbos import DBOS

    try:
        for queue in await DBOS.list_queues_async():
            await DBOS.delete_queue_async(queue.name)
            logger.info("Deleted unused DBOS queue %s", queue.name)
    except Exception:
        logger.exception("Could not delete unused DBOS queues")
    _queue_list_cache.clear()


async def _cleanup_loop() -> None:
    """Sweep ended runs at startup and then every RUN_CLEANUP_INTERVAL_SEC.
    Every delete is idempotent, so each process running its own loop is safe."""
    import run_cleanup

    while True:
        try:
            await run_cleanup.sweep(RUN_RETENTION_SEC)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Run cleanup failed")
        try:
            await asyncio.sleep(RUN_CLEANUP_INTERVAL_SEC)
        except asyncio.CancelledError:
            break


async def shutdown() -> None:
    global _cleanup_task
    if _cleanup_task is not None:
        _cleanup_task.cancel()
        _cleanup_task = None
    try:
        if _dbos_constructed:
            from dbos import DBOS

            DBOS.destroy()
    except Exception:
        logger.exception("DBOS shutdown error")
    await _close_pool()
