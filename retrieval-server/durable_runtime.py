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
                   migrations, DBOS.launch() (also recovers interrupted workflows).
  shutdown()    -> DBOS.destroy() + close the pool.

P0-verified config for the Supabase session pooler: use_listen_notify=False
(the pooler has no working LISTEN/NOTIFY, so DBOS polls) and dbos_system_schema
(DBOS tables live in a schema of the single Supabase database).
"""
import logging
import os

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")
DBOS_SYSTEM_SCHEMA = os.getenv("DBOS_SYSTEM_SCHEMA", "dbos")
_CHECKPOINTER_POOL_MAX = int(os.getenv("CHECKPOINTER_POOL_MAX", "5"))

_dbos_constructed = False  # DBOS() instance exists -> workflows may register/decorate
_ready = False             # checkpointer setup + DBOS.launch() succeeded -> runs usable
_checkpointer = None
_pool = None


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

        # Reattach events table (poll-based stream channel) shares this pool.
        import run_events
        await run_events.setup(_pool)

        DBOS.launch()  # runs migrations + recovers any interrupted workflows

        # Register the agent-runs queue now that the system DB is up (queues
        # can't be registered before launch). Import here to avoid a heavy
        # import at module load.
        import runs
        await runs.register_run_queue()

        _ready = True
        logger.info("Durable runs ENABLED (checkpointer ready, DBOS launched)")
    except Exception:
        logger.exception("Durable runtime startup failed — durable runs disabled")
        _ready = False


async def shutdown() -> None:
    global _pool
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
